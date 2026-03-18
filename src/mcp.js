// mcp.js

// 存储所有已注册的工具描述（供大模型理解）
const toolDefinitions = [];
// 存储所有工具的具体执行逻辑
const registry = {};
// 外部注入的日志函数
let sysLog = console.log;

/**
 * 初始化 MCP 服务
 * @param {Object} policyConfig - 完整的策略配置
 * @param {Function} logger - index.js 中的 log 函数
 */
export function initMcp(policyConfig, logger) {
    if (logger) sysLog = logger;

    const mcpConfig = policyConfig.mcp || {};
    if (!mcpConfig.enabled) {
        sysLog('info', '[mcp]', 'MCP 服务总开关已关闭');
        return;
    }

    // -----------------------------------------------------
    // 1. 注册功能：网页搜索 (web_search)
    // -----------------------------------------------------
    if (mcpConfig.tools?.web_search?.enabled) {
        toolDefinitions.push({
            type: "function",
            function: {
                name: "web_search",
                description: "当用户询问实时新闻、当前事实、天气、或者你资料库里没有的现时世界信息时，调用此工具搜索互联网。",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "要搜索的最佳关键词" }
                    },
                    required: ["query"]
                }
            }
        });

        registry['web_search'] = async (args) => {
            sysLog('info', '[mcp]', '执行网页搜索', { query: args.query });
            try {
                // 原生轻量级搜索逻辑
                const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(args.query), {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                const html = await res.text();

                const snippetRegex = /<a class="result__snippet[^>]*>(.*?)<\/a>/g;
                let match;
                const results = [];
                while ((match = snippetRegex.exec(html)) !== null && results.length < 3) {
                    let text = match[1].replace(/<\/?[^>]+(>|$)/g, "");
                    text = text.replace(/&\w+;/g, " ");
                    results.push(text.trim());
                }

                if (results.length === 0) return "未找到相关搜索结果，可能是由于网络波动。";
                return results.join('\n');
            } catch (err) {
                sysLog('error', '[mcp]', '搜索请求失败', { error: err?.message || String(err) });
                return "网络搜索接口无响应。";
            }
        };
        sysLog('info', '[mcp]', '已挂载服务: web_search');
    }

    // 未来可以在这里继续注册其他服务，例如 read_file, get_weather 等
}

/**
 * 获取当前已启用的工具列表，提供给大模型
 */
export function getMcpTools() {
    return toolDefinitions.length > 0 ? toolDefinitions : undefined;
}

/**
 * 调度并执行工具
 * @param {string} name - 工具名称
 * @param {string} argsStr - 大模型返回的参数字符串
 */
export async function executeMcpTool(name, argsStr) {
    if (!registry[name]) {
        sysLog('warn', '[mcp]', `大模型尝试调用未注册的工具: ${name}`);
        return `工具 ${name} 未找到或未启用`;
    }

    let args;
    try {
        args = JSON.parse(argsStr);
    } catch(e) {
        args = { query: argsStr }; // 容错处理
    }

    return await registry[name](args);
}

/**
 * 动态生成工具说明的 System Prompt，增强开源模型的理解力
 */
export function getMcpSystemPrompt() {
    if (toolDefinitions.length === 0) return "";
    let prompt = "\n\n【可用工具列表】\n你可以调用以下外部工具来获取实时信息：\n";
    toolDefinitions.forEach(t => {
        prompt += `- 工具名: ${t.function.name}\n  描述: ${t.function.description}\n  参数说明: ${JSON.stringify(t.function.parameters)}\n`;
    });
    prompt += "如果你认为需要调用工具，请使用系统支持的函数调用(Tool Calling)格式。";
    return prompt;
}