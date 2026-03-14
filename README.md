# qq-bridge

一个运行在本地的 QQ 桥接器，用于将 NapCatQQ / OneBot 接入一个具备“拟人化聊天行为”的智能回复系统。

当前项目的目标，不只是“自动回复”，而是构建一个更像真人的聊天代理：

- 能通过 NapCatQQ + OneBot 实时收发 QQ 消息
- 能基于白名单控制接入范围
- 能区分私聊和群聊行为
- 能实现基础的人类化延迟、等待、分段回复
- 能在群聊中根据策略决定是否接话、插话、或保持沉默
- 能接入大模型生成回复内容
- 后续可继续接入 OpenClaw 作为更完整的对话与记忆中枢

---

## 项目现状

目前这套桥接器已经完成了以下关键能力：

### 已完成

- NapCatQQ + OneBot 正式路径打通
- 桥接器可通过 WebSocket 接收 QQ 消息事件
- 桥接器可通过 WebSocket 调用 OneBot API 发送消息
- 已支持私聊白名单
- 已支持群聊白名单
- 已支持基础群聊触发策略：
  - 被 `@` 时回复
  - 可扩展为被名字点到时回复
  - 可扩展为群聊插话
- 已支持拟人化等待：
  - 等更多消息再回复
  - 随机延迟
  - 分段发送
- 已支持基础日志与状态调试：
  - `/health`
  - `/debug/state`
  - `/debug/config`
  - `logs/bridge.log`
- 已完成从 stub 回复逻辑向 LLM 回复逻辑的架构升级设计

### 当前架构方向

系统职责被逐步拆成三层：

1. **Transport Layer**
   - NapCat / OneBot 接入
   - 负责收消息、发消息、连接状态维护

2. **Decision Layer**
   - 负责决定：
     - 要不要回复
     - 为什么回复
     - 什么时候回复
     - 是普通回复、被点名回复、被 @ 回复、还是插话

3. **Reply Layer**
   - 负责生成具体回复文本
   - 当前可使用 stub 或 LLM
   - 后续可切换为 OpenClaw

---

## 设计目标

这个项目不是一个“关键词触发器”，而是一个偏行为代理（behavioral agent）：

### 私聊目标

- 像真人一样对话
- 不要每次都秒回
- 能保持最近上下文
- 风格偏口语、短句、自然

### 群聊目标

- 默认安静，不刷存在感
- 被明确点名时再发言
- 在合适时机低频插话
- 插话要像顺手接一句，而不是突然长篇输出

### 人类化目标

- 有作息、忙碌状态、在/不在感
- 能模拟“稍后回复”
- 能把较长内容拆成自然聊天短句，而不是机械切片
- 后续可扩展主动发消息能力

---

## 技术栈

- **Node.js**
- **Express**
- **ws**
- **NapCatQQ**
- **OneBot**
- **LLM API（OpenAI 兼容接口优先）**

---

## 目录结构建议

```txt
qq-bridge/
├── config/
│   ├── runtime.json
│   ├── runtime.example.json
│   ├── policy.json
│   └── policy.example.json
├── logs/
│   └── bridge.log
├── src/
│   ├── index.js
│   └── README.md
├── package.json
└── README.md
```

---

## 配置说明

### `config/runtime.json`

运行时配置，主要包括：

- bridge 监听地址
- NapCat / OneBot 连接地址
- token
- 回复模式
- 日志设置

示例：

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 3102
  },
  "napcat": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "token": "your_token"
  },
  "openclaw": {
    "mode": "stub",
    "webhookUrl": "http://127.0.0.1:3102/openclaw/reply"
  },
  "logging": {
    "level": "info",
    "fileName": "bridge.log"
  }
}
```

### `config/policy.json`

行为策略配置，主要包括：

- 私聊/群聊白名单
- 群聊触发规则
- 拟人化等待参数
- 人类状态参数
- LLM 配置

一个典型示例：

```json
{
  "allowPrivate": true,
  "allowedUsers": ["2423587736"],
  "allowedGroups": ["123456789"],
  "replyInGroupsOnlyWhenAt": false,
  "ignoreSelfMessages": true,

  "maxReplyParts": 4,
  "maxPartLength": 28,
  "baseDelayMs": 1200,
  "randomDelayMs": 2600,

  "persona": {
    "enabled": true,
    "style": "casual-zh",
    "stripMarkdown": true,
    "preferShort": true,
    "waitForMoreMessagesMs": 1800,
    "maxConsecutiveReplies": 3
  },

  "groupPolicy": {
    "enabled": true,
    "botNames": ["机器人名字", "机器人昵称"],
    "replyWhenMentionedByName": true,
    "replyWhenAt": true,
    "replyWhenDirectQuestion": false,
    "allowInterrupt": true,
    "interruptChance": 0.12,
    "interruptCooldownMs": 900000,
    "minGroupMessagesBeforeInterrupt": 5
  },

  "humanState": {
    "enabled": true,
    "mode": "simple",
    "defaultState": "online",
    "states": {
      "online": {
        "replyMultiplier": 1,
        "delayMultiplier": 1,
        "allowInterrupt": true
      },
      "busy": {
        "replyMultiplier": 0.7,
        "delayMultiplier": 1.8,
        "allowInterrupt": false
      },
      "away": {
        "replyMultiplier": 0.3,
        "delayMultiplier": 2.5,
        "allowInterrupt": false
      },
      "sleeping": {
        "replyMultiplier": 0.05,
        "delayMultiplier": 4,
        "allowInterrupt": false
      }
    }
  },

  "llm": {
    "enabled": true,
    "apiBaseUrl": "https://your-api.example.com/v1",
    "apiKey": "your_api_key",
    "model": "your_model_name",
    "temperature": 0.8,
    "maxTokens": 200
  }
}
```

---

## 启动方式

安装依赖：

```bash
cd ~/.openclaw/workspace/qq-bridge
npm install
```

启动服务：

```bash
npm run start
```

开发模式：

```bash
npm run dev
```

查看日志：

```bash
tail -f logs/bridge.log
```

---

## 调试接口

### 健康检查

```bash
curl http://127.0.0.1:3102/health
```

用于查看：

- 服务是否启动
- event ws 是否连接
- api ws 是否连接
- 最近事件数量
- 已发送消息数量

### 查看详细状态

```bash
curl http://127.0.0.1:3102/debug/state
```

用于查看：

- 最近收到的消息
- 最近的 decision
- 最近发送记录
- 队列状态
- 群聊历史
- 最近聊天状态

### 查看当前生效配置

```bash
curl http://127.0.0.1:3102/debug/config
```

---

## 决策逻辑概述

桥接器收到消息后，大致会经过以下阶段：

1. **消息接收**
   - 从 NapCat / OneBot 接收事件

2. **基础过滤**
   - 是否是 message 事件
   - 是否是自己的消息
   - 是否通过白名单

3. **消息暂存 / 聚合**
   - 等待一小段时间，看对方是否继续发消息
   - 只处理最新一条或最近一组消息

4. **Decision Layer**
   - 私聊默认允许回复
   - 群聊根据规则判断：
     - 被 @
     - 被名字点到
     - 是否适合插话
     - 当前 humanState 是否允许

5. **Reply Layer**
   - 调用 LLM 生成回复
   - 输出短句、自然、口语化文本

6. **分段与发送**
   - 优先让 LLM 自己组织成 1~3 句短消息
   - 必要时兜底切分
   - 经 OneBot API 发回 QQ

---

## 上下文策略

建议采用“两层上下文”：

### 1. 最近 10 条原始上下文

用于保持即时对话连续性。

### 2. 最近 50 条对话摘要

用于保留中期上下文，例如：

- 最近在聊什么
- 有哪些未完成的问题
- 刚刚答应了什么
- 对方当前的目标是什么

建议由 LLM 周期性生成摘要，并在每次回复时与最近 10 条消息一起提供给模型。

---

## 群聊策略建议

群聊不要设计成“见消息就回”。

建议分为：

### 明确触发

- 被 `@`
- 被名字点到
- 明确在问 bot

### 可选触发

- 最近群话题和 bot 强相关
- bot 刚好适合补一句
- 群内没有人已经完整回答

### 插话触发

- 有冷却时间
- 有最低消息数要求
- 有概率门槛
- 受当前 humanState 约束

默认目标：

- 少说
- 说短
- 像真人
- 不抢话

---

## 当前已知问题 / 待优化项

以下是已识别的优化方向：

- 名字点名识别需要更鲁棒
  - 文本归一化
  - 标点、空格、变体昵称处理

- 回复切分仍需优化
  - 优先让 LLM 自己按聊天短句输出
  - split 逻辑只作为兜底

- 私聊上下文需要完善
  - 统一维护 chat history
  - 喂给模型最近 10 条上下文
  - 增加最近 50 条摘要

- 群聊插话仍需调参
  - 需要更稳的节奏控制
  - 可增加关键词或话题相关性规则

- 长期目标仍是接入 OpenClaw
  - 让内容生成与更强的记忆体系接轨
  - 同时保留 bridge 自身的行为控制层

---

## 推荐演进路线

### 阶段 A
**规则 decision + LLM reply**

- 最易调试
- 最容易观察问题
- 最适合先把“像人”做出来

### 阶段 B
**规则预筛 + 模型辅助 decision + LLM reply**

- 让模型参与判断“该不该说”
- 但仍保留规则边界

### 阶段 C
**规则 decision + OpenClaw reply**

- 行为仍由 bridge 控制
- 内容交给 OpenClaw
- 接入更完整上下文和长期记忆

---

## 这个项目最重要的经验

这不是一个“接上大模型就完事”的项目。

真正难的不是“生成一句回复”，而是：

- 决定什么时候说
- 决定什么时候不说
- 决定怎么说得像真人
- 决定在群里存在感要多高
- 决定如何保留上下文但不显得机械

所以，**行为层** 和 **内容层** 必须分开设计。

这也是本项目最核心的架构思路。

---

## 致谢 / 备注

这个项目从一开始只是想把 OpenClaw 接到个人 QQ，后来逐渐变成了一个更完整的“聊天行为代理”实验。
从打通 NapCat / OneBot，到建立白名单、拟人化延迟、群聊策略、上下文架构，再到 LLM 接入路线，整个过程推进得比预期更扎实，也更有产品感。

如果后续继续演进，最值得保留的不是某一段代码，而是现在这套拆层思路：

- transport
- decision
- reply

这套骨架是对的。
