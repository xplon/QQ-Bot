import fs from 'fs';
import path from 'path';
import express from 'express';
import { WebSocket } from 'ws';
import { initMcp, getMcpTools, executeMcpTool, getMcpSystemPrompt } from './mcp.js';

const root = path.resolve(process.cwd());
const configDir = path.join(root, 'config');
const logsDir = path.join(root, 'logs');
const persistedStateFile = path.join(logsDir, 'state.json');

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

// 初始化 MCP 工具注册中心
initMcp(policy, log);

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
    chatSummaries: new Map(),
    lastInterruptsByGroup: new Map(),
    nextReviveTimeByGroup: new Map(),
    blockedUsers: new Set(),
    glossary: new Map() // groupId -> "term: definition \n term: definition"
};

function loadPersistedState() {
    try {
        if (!fs.existsSync(persistedStateFile)) return;
        const raw = JSON.parse(fs.readFileSync(persistedStateFile, 'utf8'));
        if (raw.chatHistory) {
            Object.entries(raw.chatHistory).forEach(([k, arr]) => {
                state.chatHistory.set(k, arr.map((m) => ({ ...m, at: m.at || Date.now() })));
            });
        }
        if (raw.chatSummaries) {
            Object.entries(raw.chatSummaries).forEach(([k, v]) => state.chatSummaries.set(k, v));
        }
        if (raw.lastGroupReplyAt) {
            Object.entries(raw.lastGroupReplyAt).forEach(([k, v]) => state.lastGroupReplyAt.set(k, v));
        }
        if (raw.lastInterruptsByGroup) {
            Object.entries(raw.lastInterruptsByGroup).forEach(([k, v]) => state.lastInterruptsByGroup.set(k, v));
        }
        if (raw.nextReviveTimeByGroup) {
            Object.entries(raw.nextReviveTimeByGroup).forEach(([k, v]) => state.nextReviveTimeByGroup.set(k, v));
        }
        if (raw.groupMessageHistory) {
             Object.entries(raw.groupMessageHistory).forEach(([k, v]) => state.groupMessageHistory.set(k, v));
        }
        if (raw.blockedUsers) {
            raw.blockedUsers.forEach((u) => state.blockedUsers.add(u));
        }
        if (raw.glossary) {
            Object.entries(raw.glossary).forEach(([k, v]) => state.glossary.set(k, v));
        }
        log('info', '[persist]', 'state loaded', { entries: Object.keys(raw.chatHistory || {}).length });
    } catch (err) {
        log('error', '[persist]', 'load failed', { message: err?.message || String(err) });
    }
}

function savePersistedState() {
    try {
        const payload = {
            chatHistory: Object.fromEntries(state.chatHistory),
            chatSummaries: Object.fromEntries(state.chatSummaries),
            lastGroupReplyAt: Object.fromEntries(state.lastGroupReplyAt),
            lastInterruptsByGroup: Object.fromEntries(state.lastInterruptsByGroup),
            nextReviveTimeByGroup: Object.fromEntries(state.nextReviveTimeByGroup),
            groupMessageHistory: Object.fromEntries(state.groupMessageHistory),
            blockedUsers: Array.from(state.blockedUsers),
            glossary: Object.fromEntries(state.glossary)
        };
        fs.writeFileSync(persistedStateFile, JSON.stringify(payload, null, 2));
    } catch (err) {
        log('error', '[persist]', 'save failed', { message: err?.message || String(err) });
    }
}

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

    let replyToId = null;
    if (Array.isArray(evt.message)) {
        const replySeg = evt.message.find(seg => seg?.type === 'reply');
        if (replySeg?.data?.id) {
            replyToId = String(replySeg.data.id);
        }
    }
    // Fallback for raw string if array missing (Napcat sometimes sends array, sometimes string)
    if (!replyToId && typeof evt.raw_message === 'string') {
        const match = evt.raw_message.match(/\[CQ:reply,id=(\d+)\]/);
        if (match) {
            replyToId = match[1];
        }
    }

    return {
        platform: 'qq',
        postType: evt.post_type,
        chatType: evt.message_type || null,
        selfId: evt.self_id ? String(evt.self_id) : null,
        userId: evt.user_id ? String(evt.user_id) : null,
        groupId: evt.group_id ? String(evt.group_id) : null,
        messageId: evt.message_id ? String(evt.message_id) : null,
        replyToId,
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

    if (state.blockedUsers.has(String(evt.userId))) {
        // Exception: allow unblock command to pass through, but we handle it before checkAllow in main loop actually.
        // But if I handle it before, I don't need to return allowed=true here.
        // Wait, if I handle command *before* calling checkAllow, then this check is fine.
        return { allowed: false, reason: 'user-blocked' };
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
            // Allow if name is mentioned or it's a direct question, even if not @-ed
            const gp = policy.groupPolicy || {};
            const nameHit = gp.replyWhenMentionedByName && isNameMentioned(evt);
            const questionHit = gp.replyWhenDirectQuestion && isDirectQuestion(evt);
            
            // Also allow if we might want to interrupt (we can't decide fully here, but we shouldn't block it yet if interrupts are enabled)
            // However, interrupting usually requires analyzing context which happens later. 
            // If we strictly enforce "replyInGroupsOnlyWhenAt", random interrupts might be blocked.
            // We'll relax this check if interrupts are enabled in policy.
            const interruptEnabled = gp.enabled && gp.allowInterrupt;

            if (!nameHit && !questionHit && !interruptEnabled) {
                return { allowed: false, reason: 'group-not-mentioned' };
            }
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

    const rs = policy.replySplit || {};
    const softLimit = rs.softLimit || policy.maxReplyParts || 4;
    const hardLimit = rs.hardLimit || 8; 
    const shortThreshold = rs.shortSentenceThreshold || 6;

    const byLines = source
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

    if (byLines.length > 1) {
        let parts = byLines
        .slice(0, hardLimit)
        .map((line) => line.replace(/^[，。！？、,.!?:：;；\s]+/, '').trim())
        .filter(Boolean);
        
        return parts;
    }

    const chunks = [];
    let rest = source;
    const maxLen = rs.maxPartLength || policy.maxPartLength || 28;
    const maxParts = hardLimit;

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

        if (cut < shortThreshold) {
            cut = rest.lastIndexOf('，', maxLen);
        }

        if (cut < shortThreshold) cut = maxLen;

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
    .replace(/[，。！？、,.!?:：;；"'“”‘’（）()\[\]【】<>《》\-—_]/g, ' ') // Replace punctuation with space to handle boundaries
    .replace(/\s+/g, ' ')
    .trim();
}

function isNameMentioned(evt) {
    const names = policy.groupPolicy?.botNames || [];
    if (names.length === 0) return false;

    // improved matching for English names
    const text = evt.text || '';
    const rawText = evt.raw?.raw_message || '';

    // Combine text and raw to ensure we catch everything
    const combined = normalizeForNameMatch(text + ' ' + rawText);

    return names.some((name) => {
        const normalizedName = normalizeForNameMatch(name);
        if (!normalizedName) return false;

        // Use regex for word boundary check if it contains English letters
        if (/[a-z]/i.test(normalizedName)) {
             try {
                 const regex = new RegExp(`(^|\\s)${normalizedName}(\\s|$)`, 'i');
                 return regex.test(combined) || combined.includes(normalizedName); // Fallback to includes if regex fails or for partials
             } catch (e) {
                 return combined.includes(normalizedName);
             }
        }
        return combined.includes(normalizedName);
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
    
    // Configurable mode extras
    const modeExtras = policy.humanState?.modeDelayExtras || {};
    // Fallbacks if not present
    const defaultExtras = {
        'interrupt': 2500,
        'group-question': 800,
        'private-reply': 0,
        'group-at': 500,
        'group-name': 700
    };
    
    const modeExtra = Number(modeExtras[baseMode] ?? defaultExtras[baseMode] ?? 0);

    return Math.floor((base + Math.random() * random + modeExtra) * delayMultiplier);
}

function pushChatMessage(evt, role = 'user', textOverride = null) {
    const key = getChatKey(evt);
    const arr = state.chatHistory.get(key) || [];
    const maxHistory = policy.context?.maxHistoryLength || 80;

    arr.push({
        at: Date.now(),
        role,
        chatType: evt.chatType,
        userId: evt.userId || null,
        groupId: evt.groupId || null,
        messageId: evt.messageId || null,
        text: textOverride ?? evt.text ?? ''
    });

    while (arr.length > maxHistory) arr.shift();

    state.chatHistory.set(key, arr);

    if (evt.chatType === 'group') {
        const groupArr = state.groupMessageHistory.get(String(evt.groupId)) || [];
        groupArr.push({
            at: Date.now(),
            userId: evt.userId,
            messageId: evt.messageId || null,
            text: evt.text
        });
        while (groupArr.length > 50) groupArr.shift(); // Increase kept group messages for activity analysis
        state.groupMessageHistory.set(String(evt.groupId), groupArr);
    }
}    

function buildContext(evt) {
    const key = getChatKey(evt);
    const history = state.chatHistory.get(key) || [];
    const maxHistory = policy.context?.maxHistoryLength || 80;
    const recentMessages = history.slice(-maxHistory); 
    const summary = state.chatSummaries.get(key) || '';

    let replyToText = null;
    if (evt.replyToId) {
        // Find in recent history first
        const found = history.find(m => String(m.messageId) === String(evt.replyToId));
        if (found) {
            replyToText = found.text;
        } else {
             // Look in group history if group chat
             if (evt.chatType === 'group') {
                 const gHist = state.groupMessageHistory.get(String(evt.groupId)) || [];
                 const foundInGroup = gHist.find(m => String(m.messageId) === String(evt.replyToId));
                 if (foundInGroup) {
                     replyToText = foundInGroup.text;
                 }
             }
        }
    }

    return {
        recentMessages,
        summary,
        replyToText
    };
}

function isInQuietHours() {
    const qh = policy.humanState?.quietHours;
    if (!qh?.enabled) return false;

    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    
    const startHour = qh.startHour ?? 0;
    const startMinute = qh.startMinute ?? 30;
    const endHour = qh.endHour ?? 9;
    const endMinute = qh.endMinute ?? 0;

    // Convert everything to minutes from midnight for easier comparison
    const currentMins = hour * 60 + minute;
    const startMins = startHour * 60 + startMinute;
    const endMins = endHour * 60 + endMinute;

    if (startMins < endMins) {
        // e.g. 01:00 to 05:00
        return currentMins >= startMins && currentMins < endMins;
    } else {
        // e.g. 23:00 to 07:00 (crosses midnight)
        return currentMins >= startMins || currentMins < endMins;
    }
}


function shouldInterrupt(evt, context, humanState) {
    const gp = policy.groupPolicy || {};
    if (!gp.enabled || !gp.allowInterrupt) {
        log('info', '[interrupt]', 'disabled by config', { groupId: evt.groupId });
        return false;
    }

    // Quiet hours check
    if (isInQuietHours()) {
        log('info', '[interrupt]', 'quiet hours skip', { groupId: evt.groupId });
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
    
    // New heuristics thresholds
    const activityWindowMs = Number(gp.activityWindowMs || 120000); // 2 mins
    const minMsgsInWindow = Number(gp.minMsgsInWindow || 5);
    const idleReviveAfterMs = Number(gp.idleReviveAfterMs || 15 * 60 * 1000); // 15 mins
    const idleReviveChance = Number(gp.idleReviveChance || 0.15);
    const maxInterruptsPerHour = Number(gp.maxInterruptsPerHour || 4);

    const now = Date.now();
    const lastReplyAt = state.lastGroupReplyAt.get(String(evt.groupId)) || 0;
    const sinceLastReply = now - lastReplyAt;

    if (sinceLastReply < cooldownMs) {
        log('info', '[interrupt]', 'cooldown not passed', {
            groupId: evt.groupId,
            sinceLastReply,
            cooldownMs
        });
        return false;
    }
    
    // Check hourly cap
    const interrupts = state.lastInterruptsByGroup.get(String(evt.groupId)) || [];
    const recentInterrupts = interrupts.filter((t) => now - t <= 60 * 60 * 1000);
    if (recentInterrupts.length >= maxInterruptsPerHour) {
        log('info', '[interrupt]', 'hourly cap hit', { groupId: evt.groupId });
        return false;
    }

    const groupMsgs = state.groupMessageHistory.get(String(evt.groupId)) || [];
    
    // Activity Analysis
    const recentWindow = groupMsgs.filter((m) => now - m.at <= activityWindowMs);
    
    // 1. Idle Revive Logic: If very quiet for a long time, maybe speak?
    // We look at the gap between the *previous* message and the *current* message to see if this message just broke a long silence
    // But wait, if WE are interrupting, we are reacting to *someone else's* message (the trigger evt).
    // So if evt came in after 2 hours of silence, we might want to chime in ("Everyones awake!").
    
    let isRevive = false;
    if (groupMsgs.length >= 2) {
        const prevMsg = groupMsgs[groupMsgs.length - 2];
        const currentMsg = groupMsgs[groupMsgs.length - 1]; // This should be evt if pushChatMessage was called before?
        // Wait, pushChatMessage is called in 'connectEventWs' BEFORE 'processEvent'.
        // So yes, groupMessageHistory has the current message at the end.
        
        const gap = currentMsg.at - prevMsg.at;
        if (gap > idleReviveAfterMs) {
            isRevive = true;
        }
    }
    
    // 2. High Activity Logic
    const isHighActivity = recentWindow.length >= minMsgsInWindow;

    if (!isHighActivity && !isRevive && groupMsgs.length < minMsgs) {
         log('info', '[interrupt]', 'not enough activity/messages', {
            groupId: evt.groupId,
            count: groupMsgs.length,
            recentWindowCount: recentWindow.length
        });
        return false;
    }

    // Logic: 
    // If Revive -> Higher chance?
    // If High Activity -> Standard chance?
    
    let currentChance = chance;
    if (isRevive) {
        currentChance = idleReviveChance;
    }

    const rolled = Math.random();
    const hit = rolled < currentChance;

    if (hit) {
         // Record interrupt
         recentInterrupts.push(now);
         state.lastInterruptsByGroup.set(String(evt.groupId), recentInterrupts);
    }

    log('info', '[interrupt]', 'chance roll', {
        groupId: evt.groupId,
        rolled,
        chance: currentChance,
        hit,
        isRevive,
        isHighActivity
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
    const glossary = state.glossary.get(key) || '';

    const updateInterval = policy.context?.summaryUpdateInterval || 10;
    const summaryInputLength = policy.context?.summaryInputLength || 50;

    if (history.length < 20) return;
    if (history.length % updateInterval !== 0) return;

    const llm = policy.llm || {};
    if (!llm.enabled) return;

    const content = history
    .slice(-summaryInputLength)
    .map((m) => `${m.role === 'assistant' ? '你' : '对方'}: ${m.text}`)
    .join('\n');

    const prompt = [
        '请把下面最近对话整理成简短上下文摘要，供后续聊天继续参考。',
        '保留：最近在聊什么、对方的目标、未完成的问题、你刚刚答应了什么。',
        '此外，请提取对话中出现的“黑话”、“梗”或特殊术语，更新到术语表中。',
        `当前的术语表：${glossary || '无'}`,
        '输出格式请保持纯文本，第一部分是【摘要】，第二部分是【术语表】（如果没新术语可不写）。',
        '控制在300字以内。'
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
                max_tokens: 250,
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
            // Simple Parse: look for [Summary] and [Glossary] markers or just intelligent guess
            // Actually, LLM might just output plain text. Let's try to regex split if possible, or just save whole thing as summary if unsafe.
            // Better: Instruct strict format.
            // "摘要：xxx\n术语表：xxx"
            let summaryPart = text;
            let glossaryPart = '';
            
            if (text.includes('术语表：')) {
                const parts = text.split('术语表：');
                summaryPart = parts[0].replace('摘要：', '').trim();
                glossaryPart = parts[1].trim();
            } else if (text.includes('【术语表】')) {
                const parts = text.split('【术语表】');
                summaryPart = parts[0].replace('【摘要】', '').trim();
                glossaryPart = parts[1].trim();
            }

            if (summaryPart) {
                state.chatSummaries.set(key, summaryPart);
            }
            if (glossaryPart) {
                // Merge or Replace? The prompt asked to "Update", so LLM should have included old + new?
                // The prompt said "Current glossary: ... Update it". So the output should be the NEW full glossary.
                state.glossary.set(key, glossaryPart);
            }
            
            log('info', '[summary]', 'updated', { key, summaryLen: summaryPart.length, glossaryLen: glossaryPart.length });
        }
    } catch (err) {
        log('error', '[summary]', 'update failed', {
            key,
            message: err?.message || String(err)
        });
    }
}

async function initiateGroupTopic(groupId) {
    const key = `g:${groupId}`;
    const history = state.chatHistory.get(key) || [];
    const recentMessages = history.slice(-20);
    const summary = state.chatSummaries.get(key) || '';
    
    const llm = policy.llm || {};
    if (!llm.enabled) {
         log('warn', '[revive]', 'llm disabled, skip');
         return;
    }

    const systemPrompt = [
        '你是群聊里的活跃成员。',
        '群里最近很久没人说话了，你需要发起一个新话题来活跃气氛。',
        '话题可以是：最近的热点、大家共同的兴趣、或者是随便聊聊生活。',
        '语气要自然、轻松，不要太生硬。',
        '不要打招呼（比如“大家好”），直接说事。',
        '只输出一句话。'
    ].join(' ');

    const context = {
        summary,
        recentMessages: recentMessages.map(m => ({
            role: m.role,
            content: m.text
        }))
    };

    try {
        const resp = await fetch(`${llm.apiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${llm.apiKey}`
            },
            body: JSON.stringify({
                model: llm.model,
                temperature: 0.9, // Higher temp for creativity
                max_tokens: 150,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `最近的聊天概要：${summary || '无'}。最近消息：${JSON.stringify(recentMessages.slice(-5))}` }
                ]
            })
        });

        if (!resp.ok) throw new Error(`revive http ${resp.status}`);

        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        
        if (text) {
             const parts = splitReply(text);
             if (parts.length > 0) {
                 await sendReply({ chatType: 'group', groupId }, parts);
                 log('info', '[revive]', 'initiated topic', { groupId, text });
             }
        }
    } catch (err) {
        log('error', '[revive]', 'failed', { message: err?.message || String(err) });
    }
}

function calcNextReviveTime() {
    // 随机 1 到 3 小时后发起一次主动对话
    const minMs = 60 * 60 * 1000;
    const maxMs = 3 * 60 * 60 * 1000;
    return Date.now() + minMs + Math.random() * (maxMs - minMs);
}

function runInfoLoop() {
    // Check for active revive
    const now = Date.now();
    const config = policy.groupPolicy || {};

    if (config?.enabled) {
        const groups = policy.allowedGroups || [];
        for (const gid of groups) {
            let nextTime = state.nextReviveTimeByGroup.get(gid);
            
            // If never set (e.g. first run), set it now
            if (!nextTime) {
                nextTime = calcNextReviveTime();
                state.nextReviveTimeByGroup.set(gid, nextTime);
                continue;
            }
            
            if (now >= nextTime) {
                // Time to potentially revive
                // First reset timer to avoid loop if we fail or skip
                state.nextReviveTimeByGroup.set(gid, calcNextReviveTime());
                
                if (isInQuietHours()) {
                    log('info', '[revive]', 'skip due to quiet hours', { groupId: gid });
                    continue;
                }
                
                const prob = config.idleReviveChance ?? 0.5;
                if (Math.random() < prob) {
                    log('info', '[revive]', 'triggering', { groupId: gid });
                    initiateGroupTopic(gid).then(r => {
                        // Success or failure is logged inside initiateGroupTopic
                    });
                } else {
                    log('info', '[revive]', 'skip by probability', { groupId: gid });
                }
            }
        }
    }
}

setInterval(runInfoLoop, 60000); // Run every minute

// Persist state on exit
process.on('SIGINT', () => {
    savePersistedState();
    process.exit();
});

process.on('SIGTERM', () => {
    savePersistedState();
    process.exit();
});

// Periodic save
setInterval(savePersistedState, 60000); 

async function generateLlmReply(evt, decision, context) {
    const llm = policy.llm || {};

    if (!llm.enabled) {
        return buildStubReply(evt);
    }

    const mcpPromptText = getMcpSystemPrompt();

    // 动态生成当前的精确时间（强制指定东八区，带上星期几）
    const currentTimeStr = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'long'
    });

    const systemPrompt = [
        `【当前系统时间】：${currentTimeStr}。`,
        '你在扮演一个真实自然的QQ聊天对象。',
        '【最高优先级指令】：当用户询问你不知道的事实、实时新闻、天气、或需要联网查询的信息时，你【可能需要】调用对应的工具（如 web_search）获取资料。绝对不要直接用纯文本瞎编！',
        '回复要短，口语化，像真人，不要markdown，不要列表，不要解释自己，不要像客服。',
        '优先写成1到3句自然聊天短句。',
        '每一句都尽量是完整意思，不要硬切半句。',
        '如果内容稍长，可以分成两句，但每句都要像即时聊天里会单独发出去的话。',
        '群聊插话时要轻一点，像顺手接一句，不要突然长篇大论。',
        '被@或被点名时，正常回答，简洁自然。',
        '如果你想分成多句，请用换行分隔，每行一句。',
        '注意消息前面的时间戳，如果时间跨度很大，说明可能是新话题；注意不同用户的ID，这是多人在同时聊天，不要把不同人的对话弄混。',
        mcpPromptText
    ].join(' ');

    // Inject Glossary into System Prompt or User Payload?
    // System prompt is static constant here, let's append to it or put in user payload.
    // Putting in user payload "summary" field is cleaner.
    
    // Check glossary
    const chatKey = getChatKey(evt);
    const glossary = state.glossary.get(chatKey);
    const fullSummary = context.summary + (glossary ? `\n\n【术语表/黑话参考】：${glossary}` : '');

    const formattedMessages = (context.recentMessages || []).map(m => {
        const timeStr = new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false });
        const speaker = m.role === 'assistant' ? '你' : `[用户${m.userId ? String(m.userId).slice(-4) : '未知'}]`;
        return `[${timeStr}] ${speaker}: ${m.text}`;
    });

    const userPayload = {
        chatType: evt.chatType,
        mode: decision.mode,
        reason: decision.reason,
        humanState: decision.humanState,
        message: evt.text,
        replyTo: context.replyToText ? { text: context.replyToText } : undefined,
        summary: fullSummary, // Modified summary with glossary
        recentMessages: formattedMessages
    };

    const messagesPayload = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) }
    ];

    try {
        // 从 mcp.js 动态获取当前启用的工具
        const activeTools = getMcpTools();
        const requestBody = {
            model: llm.model,
            temperature: llm.temperature ?? 0.8,
            max_tokens: llm.maxTokens ?? 200,
            messages: messagesPayload
        };

        if (activeTools && activeTools.length > 0) {
            requestBody.tools = activeTools;
            requestBody.tool_choice = "auto";
            log('info', '[llm-mcp]', '已挂载 MCP 工具并发起请求', { toolsCount: activeTools.length });
        }

        const resp = await fetch(`${llm.apiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${llm.apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!resp.ok) {
            const errorBody = await resp.text();
            throw new Error(`HTTP ${resp.status} - ${errorBody}`);
        }

        let data = await resp.json();
        let responseMessage = data?.choices?.[0]?.message;

        log('info', '[llm-mcp]', '首轮响应结果', {
            hasToolCalls: !!(responseMessage?.tool_calls && responseMessage.tool_calls.length > 0),
            textContent: responseMessage?.content ? responseMessage.content.substring(0, 30) + '...' : '无纯文本'
        });

        // 如果 AI 决定调用 MCP 工具
        if (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0) {
            log('info', '[llm]', 'AI 触发工具调用', { calls: responseMessage.tool_calls.length });
            messagesPayload.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                // 直接由 mcp.js 调度执行
                const toolResult = await executeMcpTool(toolCall.function.name, toolCall.function.arguments);

                messagesPayload.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: String(toolResult)
                });
            }

            // 二次请求
            const secondResp = await fetch(`${llm.apiBaseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${llm.apiKey}`
                },
                body: JSON.stringify({
                    model: llm.model,
                    temperature: llm.temperature ?? 0.8,
                    max_tokens: llm.maxTokens ?? 200,
                    messages: messagesPayload
                })
            });

            if (!secondResp.ok) {
                const secondError = await secondResp.text();
                throw new Error(`Second Call HTTP ${secondResp.status} - ${secondError}`);
            }

            const secondData = await secondResp.json();
            const text = secondData?.choices?.[0]?.message?.content?.trim();

            return text || buildStubReply(evt);
        }

        return responseMessage?.content?.trim() || buildStubReply(evt);

    } catch (err) {
        log('error', '[llm]', 'generate failed', { error: err?.message || String(err) });
        return buildStubReply(evt);
    }

    // const data = await resp.json();
    // const text = data?.choices?.[0]?.message?.content?.trim();
    //
    // return text || buildStubReply(evt);
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

    // Trigger summary update occasionally
    refreshChatSummaryIfNeeded(evt).catch(err => {
        log('warn', '[summary]', 'background update failed', { message: err?.message || String(err) });
    });
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

            // Check for Safety Commands
            const text = evt.text?.trim() || '';
            // Command must be name-mentioned or @-mentioned + stop/start
            // Simplify: Just check if text contains "stop" or "start" and is directed at bot
            let isCommand = false;
            if (isNameMentioned(evt) || evt.mentioned) {
                 if (/\bstop\b/i.test(text)) {
                     state.blockedUsers.add(String(evt.userId));
                     log('info', '[safety]', 'user blocked', { userId: evt.userId });
                     // await sendReply(evt, ['已停止回复你的消息。发送 start 恢复。']);
                     return;
                 }
                 if (/\bstart\b/i.test(text)) {
                     state.blockedUsers.delete(String(evt.userId));
                     log('info', '[safety]', 'user unblocked', { userId: evt.userId });
                     // await sendReply(evt, ['已恢复。']);
                     return;
                 }
            }
            
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

// ================= 手动测试 MCP 工具的接口 =================
app.get('/test/mcp/:toolName', async (req, res) => {
    const toolName = req.params.toolName;
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({ ok: false, error: '请在 URL 中提供 q 参数，例如 ?q=上海天气' });
    }

    log('info', '[test]', `手动触发 MCP 工具: ${toolName}`, { query });

    try {
        // 模拟 AI 传入的 JSON 字符串参数
        const argsStr = JSON.stringify({ query: query });

        // 直接调用 mcp.js 里的核心逻辑
        const result = await executeMcpTool(toolName, argsStr);

        res.json({
            ok: true,
            tool: toolName,
            input: query,
            result: result // 这里就是原汁原味的爬虫返回结果
        });
    } catch (err) {
        log('error', '[test]', `手动触发工具失败: ${toolName}`, { error: err?.message || String(err) });
        res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

app.listen(runtime.bridge.port, runtime.bridge.host, () => {
    log('info', '[bridge]', 'listening', {
        url: `http://${runtime.bridge.host}:${runtime.bridge.port}`
    });
    log('info', '[config]', 'loaded', summarizeConfig());
    loadPersistedState(); // Load state on startup
    connectEventWs();
    connectApiWs();
});
