import fs from 'fs';
import path from 'path';
import express from 'express';
import { WebSocket } from 'ws';

const root = path.resolve(process.cwd());
const configDir = path.join(root, 'config');
const logsDir = path.join(root, 'logs');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

ensureDir(logsDir);

function loadJson(name, fallbackName) {
    const p = path.join(configDir, name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    if (fallbackName) {
        return JSON.parse(fs.readFileSync(path.join(configDir, fallbackName), 'utf8'));
    }
    throw new Error(`missing config: ${name}`);
}

const runtime = loadJson('runtime.json', 'runtime.example.json');
const policy = loadJson('policy.json', 'policy.example.json');

const logFile = path.join(logsDir, runtime.logging?.fileName || 'bridge.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const app = express();
app.use(express.json({ limit: '1mb' }));

const state = {
    startedAt: new Date().toISOString(),
    eventWsConnected: false,
    apiWsConnected: false,
    eventWsLastOpenAt: null,
    apiWsLastOpenAt: null,
    eventWsLastCloseAt: null,
    apiWsLastCloseAt: null,
    eventWsLastError: null,
    apiWsLastError: null,
    lastEvents: [],
    lastDecisions: [],
    sent: [],
    pending: new Map(),
    apiCounter: 0,
    perUserTimers: new Map(),
    perUserQueuedEvent: new Map(),
    lastReplyAtByUser: new Map(),
    
    groupMessageHistory: new Map(),
    lastGroupReplyAt: new Map(),
    lastDecisionByChat: new Map(),
    
    chatHistory: new Map(),
    chatSummaries: new Map()
};

let eventWs = null;
let apiWs = null;

function stringifyMeta(meta) {
    if (meta === undefined || meta === null) return '';
    if (typeof meta === 'string') return meta;
    try {
        return JSON.stringify(meta);
    } catch {
        return String(meta);
    }
}

function log(level, tag, message, meta) {
    const line = [
        new Date().toISOString(),
        `[${level}]`,
        tag,
        message,
        stringifyMeta(meta)
    ]
    .filter(Boolean)
    .join(' ');

    console.log(line);
    logStream.write(`${line}\n`);
}

function pushRecent(bucket, item, max = 80) {
    bucket.push(item);
    while (bucket.length > max) bucket.shift();
}

function rememberDecision(evt, allowed, reason, extra = {}) {
    pushRecent(state.lastDecisions, {
        at: new Date().toISOString(),
        allowed,
        reason,
        chatType: evt.chatType,
        userId: evt.userId,
        groupId: evt.groupId,
        messageId: evt.messageId,
        text: evt.text,
        ...extra
    });
}

function buildWsUrl(baseUrl, apiMode = false) {
    const u = new URL(baseUrl);
    u.pathname = apiMode ? '/api' : '/';
    if (runtime.napcat.token) {
        u.searchParams.set('access_token', runtime.napcat.token);
    }
    return u.toString();
}

function getChatKey(evt) {
    if (evt.chatType === 'group') return `g:${evt.groupId}`;
    return `u:${evt.userId}`;
}

function normalizeEvent(evt) {
    const text =
    typeof evt.raw_message === 'string'
    ? evt.raw_message
    : Array.isArray(evt.message)
    ? evt.message
    .filter((x) => x?.type === 'text')
    .map((x) => x?.data?.text || '')
    .join('')
    : '';

    const mentioned = Array.isArray(evt.message)
    ? evt.message.some(
    (seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(evt.self_id)
    )
    : false;

    return {
        platform: 'qq',
        postType: evt.post_type,
        chatType: evt.message_type || null,
        selfId: evt.self_id ? String(evt.self_id) : null,
        userId: evt.user_id ? String(evt.user_id) : null,
        groupId: evt.group_id ? String(evt.group_id) : null,
        messageId: evt.message_id ? String(evt.message_id) : null,
        text,
        raw: evt,
        mentioned,
        time: evt.time || Math.floor(Date.now() / 1000)
    };
}

function checkAllow(evt) {
    if (evt.postType !== 'message') {
        return { allowed: false, reason: 'not-message' };
    }

    if (policy.ignoreSelfMessages && evt.userId && evt.selfId && evt.userId === evt.selfId) {
        return { allowed: false, reason: 'ignore-self-message' };
    }

    if (evt.chatType === 'private') {
        if (!policy.allowPrivate) {
            return { allowed: false, reason: 'private-disabled' };
        }
        if (policy.allowedUsers?.length && !policy.allowedUsers.includes(evt.userId)) {
            return { allowed: false, reason: 'user-not-in-whitelist' };
        }
        return { allowed: true, reason: 'private-allowed' };
    }

    if (evt.chatType === 'group') {
        if (policy.allowedGroups?.length && !policy.allowedGroups.includes(evt.groupId)) {
            return { allowed: false, reason: 'group-not-in-whitelist' };
        }
        if (policy.replyInGroupsOnlyWhenAt && !evt.mentioned) {
            return { allowed: false, reason: 'group-not-mentioned' };
        }
        return { allowed: true, reason: 'group-allowed' };
    }

    return { allowed: false, reason: 'unsupported-chat-type' };
}

function cleanText(text) {
    return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#*_>~\-]{1,}/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, '')
    .trim();
}

function makeCasualZh(text) {
    let out = cleanText(text);
    out = out.replace(/我认为/g, '我感觉');
    out = out.replace(/你可以/g, '你可以先');
    out = out.replace(/例如/g, '比如');
    out = out.replace(/因此/g, '所以');
    out = out.replace(/此外/g, '还有');
    out = out.replace(/您好/g, '你');
    out = out.replace(/请问/g, '');
    return out.trim();
}

function splitReply(text) {
    const source = policy.persona?.enabled ? makeCasualZh(text) : cleanText(text);
    if (!source) return [];

    const byLines = source
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

    if (byLines.length > 1) {
        return byLines
        .slice(0, policy.maxReplyParts || 4)
        .map((line) => line.replace(/^[，。！？、,.!?:：;；\s]+/, '').trim())
        .filter(Boolean);
    }

    const chunks = [];
    let rest = source;
    const maxLen = policy.maxPartLength || 28;
    const maxParts = policy.maxReplyParts || 4;

    while (rest && chunks.length < maxParts) {
        if (rest.length <= maxLen) {
            chunks.push(rest.replace(/^[，。！？、,.!?:：;；\s]+/, '').trim());
            break;
        }

        let cut = Math.max(
            rest.lastIndexOf('。', maxLen),
            rest.lastIndexOf('！', maxLen),
            rest.lastIndexOf('？', maxLen),
            rest.lastIndexOf('\n', maxLen)
        );

        if (cut < 6) {
            cut = rest.lastIndexOf('，', maxLen);
        }

        if (cut < 6) cut = maxLen;

        let part = rest.slice(0, cut).trim();
        rest = rest.slice(cut).trim();

        part = part.replace(/^[，。！？、,.!?:：;；\s]+/, '').trim();
        rest = rest.replace(/^[，。！？、,.!?:：;；\s]+/, '').trim();

        if (part) chunks.push(part);
    }

    return chunks.filter(Boolean);
}

function buildStubReply(evt) {
    const t = evt.text?.trim() || '';
    if (!t) return '收到';
    if (/^(在吗|在不在|在不)$/.test(t)) return '在';
    if (/^(你好|hi|hello)$/i.test(t)) return '嗨';
    return `收到你刚刚说的是${t}`;
}

function normalizeForNameMatch(text) {
    return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?:：;；"'“”‘’（）()\[\]【】<>《》\-—_]/g, '');
}

function isNameMentioned(evt) {
    const names = policy.groupPolicy?.botNames || [];
    const text = evt.text || '';
    const rawText = evt.raw?.raw_message || '';

    const merged = normalizeForNameMatch(`${text} ${rawText}`);

    return names.some((name) => {
        const normalizedName = normalizeForNameMatch(name);
        return normalizedName && merged.includes(normalizedName);
    });
}
function isDirectQuestion(evt) {
    const text = evt.text || '';
    if (!text) return false;

    if (/[?？]/.test(text)) return true;

    const keywords = ['吗', '么', '是不是', '咋', '怎么', '为什么', '咋样', '怎么看'];
    return keywords.some((k) => text.includes(k));
}

function computeHumanState() {
    const hour = new Date().getHours();

    if (hour >= 1 && hour < 8) return 'sleeping';

    if (
    (hour >= 9 && hour < 12) ||
    (hour >= 14 && hour < 18) ||
    (hour >= 20 && hour < 24)
    ) {
        return 'online';
    }

    if ((hour >= 12 && hour < 14) || (hour >= 18 && hour < 20)) {
        return 'busy';
    }

    return 'away';
}

function computeDelayMs(baseMode, humanState) {
    const base = Number(policy.baseDelayMs || 1200);
    const random = Number(policy.randomDelayMs || 2600);
    const stateCfg = policy.humanState?.states?.[humanState] || {};
    const delayMultiplier = Number(stateCfg.delayMultiplier || 1);

    let modeExtra = 0;
    if (baseMode === 'interrupt') modeExtra = 2500;
    if (baseMode === 'group-question') modeExtra = 800;
    if (baseMode === 'private-reply') modeExtra = 0;
    if (baseMode === 'group-at') modeExtra = 500;
    if (baseMode === 'group-name') modeExtra = 700;

    return Math.floor((base + Math.random() * random + modeExtra) * delayMultiplier);
}

function pushChatMessage(evt, role = 'user', textOverride = null) {
    const key = getChatKey(evt);
    const arr = state.chatHistory.get(key) || [];

    arr.push({
        at: Date.now(),
        role,
        chatType: evt.chatType,
        userId: evt.userId || null,
        groupId: evt.groupId || null,
        text: textOverride ?? evt.text ?? ''
    });

    while (arr.length > 60) arr.shift();

    state.chatHistory.set(key, arr);

    if (evt.chatType === 'group') {
        const groupArr = state.groupMessageHistory.get(String(evt.groupId)) || [];
        groupArr.push({
            at: Date.now(),
            userId: evt.userId,
            text: evt.text
        });
        while (groupArr.length > 12) groupArr.shift();
        state.groupMessageHistory.set(String(evt.groupId), groupArr);
    }
}    

function pushGroupMessage(evt) {
    if (evt.chatType !== 'group' || !evt.groupId) return;

    const key = String(evt.groupId);
    const arr = state.groupMessageHistory.get(key) || [];

    arr.push({
    at: Date.now(),
    userId: evt.userId,
    text: evt.text
    });

    while (arr.length > 12) arr.shift();

    state.groupMessageHistory.set(key, arr);
}

function buildContext(evt) {
    const key = getChatKey(evt);
    const history = state.chatHistory.get(key) || [];
    const recentMessages = history.slice(-10);
    const summary = state.chatSummaries.get(key) || '';

    return {
        recentMessages,
        summary
    };
}

function shouldInterrupt(evt, context, humanState) {
    const gp = policy.groupPolicy || {};
    if (!gp.enabled || !gp.allowInterrupt) {
        log('info', '[interrupt]', 'disabled by config', { groupId: evt.groupId });
        return false;
    }

    const stateCfg = policy.humanState?.states?.[humanState] || {};
    if (stateCfg.allowInterrupt === false) {
        log('info', '[interrupt]', 'disabled by human state', {
            groupId: evt.groupId,
            humanState
        });
        return false;
    }

    const cooldownMs = Number(gp.interruptCooldownMs || 600000);
    const minMsgs = Number(gp.minGroupMessagesBeforeInterrupt || 3);
    const chance = Number(gp.interruptChance || 0.18);

    const lastReplyAt = state.lastGroupReplyAt.get(String(evt.groupId)) || 0;
    const sinceLastReply = Date.now() - lastReplyAt;

    if (sinceLastReply < cooldownMs) {
        log('info', '[interrupt]', 'cooldown not passed', {
            groupId: evt.groupId,
            sinceLastReply,
            cooldownMs
        });
        return false;
    }

    const groupMsgs = state.groupMessageHistory.get(String(evt.groupId)) || [];
    if (groupMsgs.length < minMsgs) {
        log('info', '[interrupt]', 'not enough recent group messages', {
            groupId: evt.groupId,
            count: groupMsgs.length,
            minMsgs
        });
        return false;
    }

    const rolled = Math.random();
    const hit = rolled < chance;

    log('info', '[interrupt]', 'chance roll', {
        groupId: evt.groupId,
        rolled,
        chance,
        hit,
        recentCount: groupMsgs.length
    });

    return hit;
}

function decideReply(evt, context) {
    const humanState = computeHumanState();

    if (evt.chatType === 'private') {
        const delayMs = computeDelayMs('private-reply', humanState);

        return {
        shouldReply: true,
        mode: 'private-reply',
        reason: 'private-whitelist-allowed',
        delayMs,
        confidence: 0.95,
        humanState
        };
    }

    if (evt.chatType === 'group') {
        const gp = policy.groupPolicy || {};

        if (evt.mentioned && gp.replyWhenAt) {
            return {
                shouldReply: true,
                mode: 'group-at',
                reason: 'at-mentioned',
                delayMs: computeDelayMs('group-at', humanState),
                confidence: 0.98,
                humanState
            };
        }
    
        log('info', '[group-check]', 'checking name mention', {
            text: evt.text,
            rawMessage: evt.raw?.raw_message,
            botNames: policy.groupPolicy?.botNames || [],
            matched: isNameMentioned(evt)
        });

        if (gp.replyWhenMentionedByName && isNameMentioned(evt)) {
            return {
                shouldReply: true,
                mode: 'group-name',
                reason: 'mentioned-by-name',
                delayMs: computeDelayMs('group-name', humanState),
                confidence: 0.9,
                humanState
            };
        }

        if (gp.replyWhenDirectQuestion && isDirectQuestion(evt)) {
            return {
                shouldReply: true,
                mode: 'group-question',
                reason: 'direct-question',
                delayMs: computeDelayMs('group-question', humanState),
                confidence: 0.72,
                humanState
            };
        }

        if (shouldInterrupt(evt, context, humanState)) {
            return {
                shouldReply: true,
                mode: 'interrupt',
                reason: 'interrupt-rule-hit',
                delayMs: computeDelayMs('interrupt', humanState),
                confidence: 0.45,
                humanState
            };
        }

        return {
            shouldReply: false,
            mode: 'silent',
            reason: 'group-no-trigger',
            delayMs: 0,
            confidence: 0.1,
            humanState
        };
    }

    return {
        shouldReply: false,
        mode: 'silent',
        reason: 'unsupported-chat-type',
        delayMs: 0,
        confidence: 0,
        humanState
    };
}
    
async function refreshChatSummaryIfNeeded(evt) {
    const key = getChatKey(evt);
    const history = state.chatHistory.get(key) || [];

    if (history.length < 20) return;
    if (history.length % 10 !== 0) return;

    const llm = policy.llm || {};
    if (!llm.enabled) return;

    const content = history
    .slice(-50)
    .map((m) => `${m.role === 'assistant' ? '你' : '对方'}: ${m.text}`)
    .join('\n');

    const prompt = [
        '请把下面最近对话整理成简短上下文摘要，供后续聊天继续参考。',
        '保留：最近在聊什么、对方的目标、未完成的问题、你刚刚答应了什么。',
        '不要写成分析报告，控制在200字以内。'
    ].join(' ');

    try {
        const resp = await fetch(`${llm.apiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${llm.apiKey}`
            },
            body: JSON.stringify({
                model: llm.model,
                temperature: 0.3,
                max_tokens: 180,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: content }
                ]
            })
        });

        if (!resp.ok) throw new Error(`summary http ${resp.status}`);

        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) {
            state.chatSummaries.set(key, text);
            log('info', '[summary]', 'updated', { key, summary: text });
        }
    } catch (err) {
        log('error', '[summary]', 'update failed', {
            key,
            message: err?.message || String(err)
        });
    }
}

async function generateLlmReply(evt, decision, context) {
    const llm = policy.llm || {};

    if (!llm.enabled) {
        return buildStubReply(evt);
    }

    const systemPrompt = [
        '你在扮演一个真实自然的QQ聊天对象。',
        '回复要短，口语化，像真人，不要markdown，不要列表，不要解释自己，不要像客服。',
        '优先写成1到3句自然聊天短句。',
        '每一句都尽量是完整意思，不要硬切半句。',
        '如果内容稍长，可以分成两句，但每句都要像即时聊天里会单独发出去的话。',
        '群聊插话时要轻一点，像顺手接一句，不要突然长篇大论。',
        '被@或被点名时，正常回答，简洁自然。',
        '如果你想分成多句，请用换行分隔，每行一句。'
    ].join(' ');

    const userPayload = {
        chatType: evt.chatType,
        mode: decision.mode,
        reason: decision.reason,
        humanState: decision.humanState,
        message: evt.text,
        summary: context.summary || '',
        recentMessages: context.recentMessages || []
    };

    const resp = await fetch(`${llm.apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${llm.apiKey}`
        },
        body: JSON.stringify({
            model: llm.model,
            temperature: llm.temperature ?? 0.8,
            max_tokens: llm.maxTokens ?? 200,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(userPayload) }
            ]
        })
    });

    if (!resp.ok) {
        throw new Error(`llm http ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();

    return text || buildStubReply(evt);
}

function calcReplyDelayMs() {
    const base = Number(policy.baseDelayMs || 1200);
    const random = Number(policy.randomDelayMs || 2600);
    return base + Math.floor(Math.random() * Math.max(random, 1));
}

function summarizeConfig() {
    return {
        bridge: runtime.bridge,
        napcat: {
            wsUrl: runtime.napcat?.wsUrl,
            httpUrl: runtime.napcat?.httpUrl,
            tokenConfigured: Boolean(runtime.napcat?.token)
        },
        openclaw: runtime.openclaw,
        logging: {
            level: runtime.logging?.level || 'info',
            file: logFile
        },
        policy: {
            allowPrivate: policy.allowPrivate,
            allowedUsers: policy.allowedUsers || [],
            allowedGroups: policy.allowedGroups || [],
            replyInGroupsOnlyWhenAt: policy.replyInGroupsOnlyWhenAt,
            ignoreSelfMessages: policy.ignoreSelfMessages,
            maxReplyParts: policy.maxReplyParts,
            maxPartLength: policy.maxPartLength,
            baseDelayMs: policy.baseDelayMs,
            randomDelayMs: policy.randomDelayMs,
            persona: policy.persona || {}
        }
    };
}

function callApi(action, params = {}) {
    return new Promise((resolve, reject) => {
    if (!apiWs || apiWs.readyState !== WebSocket.OPEN) {
        reject(new Error('api ws not connected'));
        return;
    }

    const echo = `echo-${++state.apiCounter}-${Date.now()}`;
    const timer = setTimeout(() => {
        state.pending.delete(echo);
        reject(new Error(`api timeout for ${action}`));
        }, 8000);

        state.pending.set(echo, { resolve, reject, timer, action });
        apiWs.send(JSON.stringify({ action, params, echo }));
    });
}

async function sendReply(target, parts) {
    for (const part of parts) {
        const delay = calcReplyDelayMs();
        log('info', '[delay]', 'scheduled reply part', {
            userId: target.userId,
            groupId: target.groupId,
            delay,
            part
        });

        await new Promise((r) => setTimeout(r, delay));

        const action = target.chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
        const params =
        target.chatType === 'group'
        ? { group_id: String(target.groupId), message: part }
        : { user_id: String(target.userId), message: part };

        const result = await callApi(action, params);
        state.lastReplyAtByUser.set(String(target.userId || target.groupId), Date.now());
        pushRecent(state.sent, { at: new Date().toISOString(), action, params, result });
        pushChatMessage(target, 'assistant', part);
        log('info', '[send]', action, { params, result });
    }
}

async function processEvent(evt) {
    const context = buildContext(evt);
    const decision = decideReply(evt, context);

    rememberDecision(evt, decision.shouldReply, decision.reason, decision);

    const chatKey =
    evt.chatType === 'group' ? `g:${evt.groupId}` : `u:${evt.userId}`;
    state.lastDecisionByChat.set(chatKey, {
        at: new Date().toISOString(),
        ...decision
    });

    log(
        decision.shouldReply ? 'info' : 'warn',
        '[decision]',
        decision.reason,
        {
            userId: evt.userId,
            groupId: evt.groupId,
            text: evt.text,
            ...decision
        }
    );

    if (!decision.shouldReply) return;

    await new Promise((r) => setTimeout(r, decision.delayMs));

    let reply;
    try {
        reply = await generateLlmReply(evt, decision, context);
        log('info', '[llm]', 'reply generated', {
        userId: evt.userId,
        groupId: evt.groupId,
        mode: decision.mode,
        reply
    });
    } catch (err) {
        log('error', '[llm]', 'generate failed, fallback to stub', {
        message: err?.message || String(err)
        });
        reply = buildStubReply(evt);
    }

    const parts = splitReply(reply);

    if (!parts.length) {
        log('warn', '[reply]', 'empty reply after llm', { reply });
        return;
    }

    await sendReply(evt, parts);

    if (evt.chatType === 'group' && evt.groupId) {
        state.lastGroupReplyAt.set(String(evt.groupId), Date.now());
    }
}

function scheduleEvent(evt) {
    const key = evt.chatType === 'private' ? `u:${evt.userId}` : `g:${evt.groupId}`;
    const waitMs = Number(policy.persona?.waitForMoreMessagesMs || 1800);

    state.perUserQueuedEvent.set(key, evt);

    const existing = state.perUserTimers.get(key);
    if (existing) clearTimeout(existing);

    log('info', '[queue]', 'scheduled latest event', {
        key,
        waitMs,
        userId: evt.userId,
        groupId: evt.groupId,
        text: evt.text
    });

    const timer = setTimeout(async () => {
        state.perUserTimers.delete(key);
        const latest = state.perUserQueuedEvent.get(key);
        state.perUserQueuedEvent.delete(key);
        if (!latest) return;

        try {
            await processEvent(latest);
        } catch (err) {
            log('error', '[process]', 'failed', {
                message: err?.message || String(err)
            });
        }
    }, waitMs);

    state.perUserTimers.set(key, timer);
}

function connectEventWs() {
    const ws = new WebSocket(buildWsUrl(runtime.napcat.wsUrl, false));
    eventWs = ws;

    ws.on('open', () => {
        state.eventWsConnected = true;
        state.eventWsLastOpenAt = new Date().toISOString();
        log('info', '[napcat]', 'event ws connected', {
            url: buildWsUrl(runtime.napcat.wsUrl, false)
        });
    });

    ws.on('message', async (buf) => {
        try {
            const msg = JSON.parse(String(buf));
            if (!msg.post_type) return;

            const evt = normalizeEvent(msg);
            pushRecent(state.lastEvents, evt);

            log('info', '[event]', 'received', {
                chatType: evt.chatType,
                userId: evt.userId,
                groupId: evt.groupId,
                messageId: evt.messageId,
                text: evt.text
            });

            const allowDecision = checkAllow(evt);

            rememberDecision(evt, allowDecision.allowed, allowDecision.reason);
            log(allowDecision.allowed ? 'info' : 'warn', '[filter]', allowDecision.reason, {
                userId: evt.userId,
                groupId: evt.groupId,
                text: evt.text
            });

            if (!allowDecision.allowed) return;

            pushChatMessage(evt, 'user');

            scheduleEvent(evt);
        } catch (err) {
            log('error', '[napcat]', 'event parse error', {
                message: err?.message || String(err)
            });
        }
    });

    ws.on('close', () => {
        state.eventWsConnected = false;
        state.eventWsLastCloseAt = new Date().toISOString();
        log('warn', '[napcat]', 'event ws closed, retry in 5s');
        setTimeout(connectEventWs, 5000);
    });

    ws.on('error', (err) => {
        state.eventWsConnected = false;
        state.eventWsLastError = err?.message || String(err);
        log('error', '[napcat]', 'event ws error', {
            message: state.eventWsLastError
        });
    });
}

function connectApiWs() {
    const ws = new WebSocket(buildWsUrl(runtime.napcat.wsUrl, true));
    apiWs = ws;

    ws.on('open', async () => {
        state.apiWsConnected = true;
        state.apiWsLastOpenAt = new Date().toISOString();
        log('info', '[napcat]', 'api ws connected', {
            url: buildWsUrl(runtime.napcat.wsUrl, true)
        });

        try {
            const info = await callApi('get_login_info', {});
            log('info', '[napcat]', 'api ready', info);
        } catch (err) {
            log('error', '[napcat]', 'api warmup failed', {
                message: err?.message || String(err)
            });
        }
    });

    ws.on('message', (buf) => {
        try {
            const msg = JSON.parse(String(buf));
            if (msg.echo && state.pending.has(msg.echo)) {
                const item = state.pending.get(msg.echo);
                clearTimeout(item.timer);
                state.pending.delete(msg.echo);
                item.resolve(msg);
            }
        } catch (err) {
            log('error', '[napcat]', 'api parse error', {
                message: err?.message || String(err)
            });
        }
    });

    ws.on('close', () => {
        state.apiWsConnected = false;
        state.apiWsLastCloseAt = new Date().toISOString();
        log('warn', '[napcat]', 'api ws closed, retry in 5s');
        setTimeout(connectApiWs, 5000);
    });

    ws.on('error', (err) => {
        state.apiWsConnected = false;
        state.apiWsLastError = err?.message || String(err);
        log('error', '[napcat]', 'api ws error', {
            message: state.apiWsLastError
        });
    });
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        startedAt: state.startedAt,
        eventWsConnected: state.eventWsConnected,
        apiWsConnected: state.apiWsConnected,
        eventWsLastOpenAt: state.eventWsLastOpenAt,
        apiWsLastOpenAt: state.apiWsLastOpenAt,
        eventWsLastCloseAt: state.eventWsLastCloseAt,
        apiWsLastCloseAt: state.apiWsLastCloseAt,
        eventWsLastError: state.eventWsLastError,
        apiWsLastError: state.apiWsLastError,
        recentEvents: state.lastEvents.length,
        sent: state.sent.length,
        logFile
    });
});

app.get('/debug/state', (_req, res) => {
    res.json({
        startedAt: state.startedAt,
        eventWsConnected: state.eventWsConnected,
        apiWsConnected: state.apiWsConnected,
        eventWsLastOpenAt: state.eventWsLastOpenAt,
        apiWsLastOpenAt: state.apiWsLastOpenAt,
        eventWsLastCloseAt: state.eventWsLastCloseAt,
        apiWsLastCloseAt: state.apiWsLastCloseAt,
        eventWsLastError: state.eventWsLastError,
        apiWsLastError: state.apiWsLastError,
        lastEvents: state.lastEvents,
        lastDecisions: state.lastDecisions,
        sent: state.sent,
        pending: Array.from(state.pending.keys()),
        queuedKeys: Array.from(state.perUserQueuedEvent.keys()),
        lastDecisionByChat: Object.fromEntries(state.lastDecisionByChat),
        groupMessageHistory: Object.fromEntries(
        Array.from(state.groupMessageHistory.entries()).map(([k, v]) => [k, v])
        ),
        lastGroupReplyAt: Object.fromEntries(state.lastGroupReplyAt)
    });
});

app.get('/debug/config', (_req, res) => {
    res.json(summarizeConfig());
});

app.post('/test/send-private', async (req, res) => {
    try {
        const { userId, message } = req.body || {};
        const result = await callApi('send_private_msg', {
            user_id: String(userId),
            message: String(message)
        });

        pushRecent(state.sent, {
            at: new Date().toISOString(),
            action: 'send_private_msg',
            params: { user_id: userId, message },
            result
        });

        log('info', '[test]', 'send-private ok', { userId, message, result });
        res.json({ ok: true, result });
    } catch (err) {
        log('error', '[test]', 'send-private failed', {
            message: err?.message || String(err)
        });
        res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

app.listen(runtime.bridge.port, runtime.bridge.host, () => {
    log('info', '[bridge]', 'listening', {
        url: `http://${runtime.bridge.host}:${runtime.bridge.port}`
    });
    log('info', '[config]', 'loaded', summarizeConfig());
    connectEventWs();
    connectApiWs();
});
