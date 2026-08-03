# qq-codex-bridge v0.2 产品说明书

> 文档版本：2026-08-03 | 目标版本：v0.2.0

---

## 一、产品定位

**qq-codex-bridge** 是一个开源本地桥接服务，让用户通过 **QQ、微信、飞书** 等即时通讯渠道与 **Codex/ChatGPT Desktop**（已合并为统一产品）进行 AI 对话；同时提供 **Agent 推送接口**，让 Codex、Claude 等 AI Agent 工具能主动向 IM 渠道推送消息（如自动化任务汇报、监控告警、定时摘要等）。

### 核心价值

1. **IM → AI**：在手机或电脑上通过熟悉的 IM 工具随时与桌面 AI 对话
2. **AI → IM**：Agent 工具主动推送任务结果、汇报、告警到 IM 渠道
3. **多渠道统一**：一套编排层同时服务 QQ、微信、飞书等多个 IM 平台
4. **多 Agent 兼容**：不绑定单一 AI 后端，同时支持 Codex Desktop、Claude 等

---

## 二、用户角色与场景

### 2.1 终端用户（IM 侧）

| 场景 | 描述 |
|---|---|
| 文本对话 | 在 QQ/微信/飞书中发送文字，AI 回复 |
| 图片理解 | 发送截图或照片，AI 分析图片内容 |
| 语音提问 | 发送语音消息，自动转写后提交 AI |
| AI 生图 | 请求 AI 生成图片，结果回传到 IM |
| 线程管理 | 切换/新建对话线程，保持上下文隔离 |
| 接收 Agent 推送 | 被动接收 AI Agent 主动推送的消息（任务完成通知、日报、告警等） |

### 2.2 开发者 / Agent 工具（推送侧）

| 场景 | 描述 |
|---|---|
| 自动化任务汇报 | Codex 完成编码任务后自动推送结果到微信群 |
| 监控告警 | 部署后的服务异常时通过飞书推送告警 |
| 定时摘要 | 每日自动汇总 GitHub PR 并推送到 QQ 群 |
| MCP 工具调用 | Claude/Codex 通过 MCP 协议直接调用推送能力 |
| Webhook 触发 | 外部系统通过 HTTP Webhook 触发消息推送 |

---

## 三、系统架构（v0.2）

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent 推送层                              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Webhook API  │  │  MCP Server  │  │  Codex Automation     │  │
│  │ POST /push   │  │ push_message │  │  Hook Integration     │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         └──────────────────┼─────────────────────┘              │
│                            ▼                                    │
│                   PushOrchestrator                               │
│                   (鉴权 → 路由 → 格式化 → 限流)                    │
│                            │                                    │
└────────────────────────────┼────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────┐
│                     统一渠道出站层                                 │
│                            │                                    │
│         ┌──────────────────┼──────────────────────┐             │
│         ▼                  ▼                      ▼             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐       │
│  │  QQ Sender  │  │ 微信 Sender  │  │   飞书 Sender     │       │
│  └─────────────┘  └──────────────┘  └──────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     统一渠道入站层                                 │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐   │
│  │ QQ Gateway   │  │ 微信 Gateway      │  │ 飞书 Gateway     │   │
│  │ (WebSocket)  │  │ (Long-Poll)      │  │ (Event Sub)     │   │
│  └──────┬───────┘  └──────┬───────────┘  └──────┬──────────┘   │
│         └──────────────────┼─────────────────────┘              │
│                            ▼                                    │
│                   BridgeOrchestrator                             │
│                   (去重 → Session → 媒体 → 转发)                  │
│                            │                                    │
└────────────────────────────┼────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────┐
│                   统一桌面驱动层                                   │
│                            │                                    │
│                   UnifiedDesktopDriver                          │
│                   ┌────────┴────────┐                           │
│                   ▼                 ▼                           │
│           AppServer (主)      CDP Fallback (备)                  │
│           (JSON-RPC WS)      (DOM 注入)                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、核心模块说明

### 4.1 统一桌面驱动层（UnifiedDesktopDriver）

**解决的问题**：Codex 与 ChatGPT Desktop 已合并为统一产品，原有双源架构（CDP + AX API）失效。

| 子模块 | 职责 |
|---|---|
| `feature-probe.ts` | 启动时探测应用版本、可用传输（AppServer WS / CDP）、缓存路径、本地 DB |
| `unified-driver.ts` | 实现 `DesktopDriverPort`，内部自动选择 AppServer 或 CDP |
| `selector-registry.ts` | DOM 选择器按版本外部化配置，支持热更新 |
| `image-collector.ts` | 统一图片采集：AppServer 媒体事件 + Kingfisher 缓存 diff |
| `capability.ts` | 应用能力声明（模型列表、图片生成、语音等） |

**传输选择策略**：
```
启动 → FeatureProbe 探测
       ├─ AppServer WS 可用 → 主路径
       ├─ AppServer 不可用 → CDP Fallback
       └─ 均不可用 → 错误上报，等待重试
       
运行中 → 定期 re-probe（默认 5 分钟）
         AppServer 恢复 → 自动回切
         降级/回切 → 记录 runtime_events
```

### 4.2 Agent 推送层（全新）

**解决的问题**：当前架构仅支持"用户发消息 → AI 回复"单向流，无法支持 Agent 主动推送。

#### 4.2.1 Webhook 推送 API

```
POST /api/v1/push
Content-Type: application/json
Authorization: Bearer <push-token>

{
  "channel": "qq" | "weixin" | "feishu",
  "target": {
    "type": "user" | "group",
    "id": "user_openid 或 group_openid"
  },
  "message": {
    "text": "构建完成，共修改 12 个文件",
    "format": "markdown" | "plain",
    "media": [
      {
        "type": "image",
        "url": "file:///path/to/screenshot.png"
      }
    ]
  },
  "metadata": {
    "source": "codex-automation",
    "taskId": "019fc584-913c-75c2-bb91-dac225fab371",
    "priority": "normal" | "urgent"
  }
}

Response: 200 OK
{
  "pushId": "uuid",
  "status": "delivered" | "queued" | "failed",
  "deliveredAt": "2026-08-03T10:00:00Z"
}
```

#### 4.2.2 MCP Server（push-mcp）

为 Codex / Claude 等支持 MCP 协议的 Agent 提供原生推送工具：

**工具清单**：

| 工具名 | 描述 | 参数 |
|---|---|---|
| `push_message` | 推送文本/图片消息到指定渠道和目标 | `channel`, `target`, `text`, `format`, `media` |
| `push_task_report` | 推送结构化任务报告 | `channel`, `target`, `taskId`, `status`, `summary`, `details` |
| `list_push_targets` | 列出可推送的目标（群/用户） | `channel` |
| `get_push_history` | 查询推送历史 | `pushId` 或 `taskId` |

**MCP 配置示例**（在 Codex `.codex/mcp.json` 中）：
```json
{
  "mcpServers": {
    "qq-bridge-push": {
      "command": "node",
      "args": ["dist/mcp/push-server.js"],
      "env": {
        "BRIDGE_PUSH_URL": "http://127.0.0.1:3100",
        "BRIDGE_PUSH_TOKEN": "your-push-token"
      }
    }
  }
}
```

**Codex Automation 集成示例**：
```
自动化触发 → Codex Agent 执行任务 
           → 调用 push_task_report MCP 工具
           → bridge 推送到微信群
           → 用户在微信中看到任务报告
```

#### 4.2.3 PushOrchestrator

推送编排层处理所有推送请求的统一管道：

```
推送请求 → 鉴权（Token 校验）
         → 目标解析（渠道 + 用户/群 OpenID）
         → 格式化（按目标渠道适配 Markdown/富文本）
         → 限流（防止刷屏，可配置每分钟/每小时上限）
         → 入库（push_history 表记录）
         → 渠道 Sender 发送
         → 回写状态（delivered / failed）
```

### 4.3 飞书渠道适配器（全新）

| 子模块 | 职责 |
|---|---|
| `feishu-api-client.ts` | 飞书开放平台 API 封装（消息发送、事件订阅） |
| `feishu-gateway.ts` | 飞书事件回调接收（HTTP Challenge + 消息事件） |
| `feishu-sender.ts` | 出站消息发送（文本、富文本、图片、卡片） |
| `feishu-channel-adapter.ts` | 组合入站/出站，注册到 BridgeOrchestrator |

### 4.4 渠道出站格式化

每个渠道的 outbound 格式化独立模块：

| 渠道 | 模块 | 特性 |
|---|---|---|
| QQ | `qq-outbound-format.ts` | Markdown 可选、图片 base64 | 
| 微信 | `weixin-outbound-format.ts` | 纯文本为主、链接预览 |
| 飞书 | `feishu-outbound-format.ts`（新） | 富文本卡片、Markdown 原生支持 |

---

## 五、配置体系（v0.2）

### 5.1 环境变量结构

```env
# ===== 桌面驱动 =====
DESKTOP_DRIVER_TRANSPORT=auto          # auto | app-server | cdp
DESKTOP_DRIVER_CDP_PORT=9229
DESKTOP_DRIVER_SELECTOR_PROFILE=auto   # auto | v26 | v27 | custom
DESKTOP_DRIVER_PROBE_INTERVAL_MS=300000

# ===== Agent 推送 =====
PUSH_ENABLED=true
PUSH_API_TOKEN=your-secure-token
PUSH_RATE_LIMIT_PER_MIN=30
PUSH_RATE_LIMIT_PER_HOUR=500
PUSH_MCP_ENABLED=true
PUSH_MCP_LISTEN_PORT=3101

# ===== QQ Bot（保持兼容） =====
QQBOT_APP_ID=...
QQBOT_CLIENT_SECRET=...

# ===== 微信（保持兼容） =====
WEIXIN_ENABLED=true
WEIXIN_ACCOUNT_ID=default

# ===== 飞书（新增） =====
FEISHU_ENABLED=false
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret
FEISHU_VERIFICATION_TOKEN=your-verification-token
FEISHU_ENCRYPT_KEY=your-encrypt-key
FEISHU_WEBHOOK_PATH=/webhooks/feishu

# ===== Bridge 运行时（保持兼容） =====
QQ_CODEX_DATABASE_PATH=runtime/qq-codex-bridge.sqlite
QQ_CODEX_LISTEN_HOST=127.0.0.1
QQ_CODEX_LISTEN_PORT=3100
```

### 5.2 降级策略配置

```json
{
  "desktopDriver": {
    "transport": "auto",
    "fallbackChain": ["app-server", "cdp"],
    "probeIntervalMs": 300000,
    "selectorProfile": "auto",
    "customSelectorPath": null
  },
  "push": {
    "rateLimits": {
      "perMinute": 30,
      "perHour": 500,
      "perTarget": {
        "perMinute": 10
      }
    },
    "retryPolicy": {
      "maxRetries": 3,
      "backoffMs": [1000, 5000, 15000]
    }
  }
}
```

---

## 六、数据模型扩展

### 6.1 新增表

```sql
-- Agent 推送历史
CREATE TABLE IF NOT EXISTS push_history (
  push_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,           -- qq | weixin | feishu
  target_type TEXT NOT NULL,       -- user | group
  target_id TEXT NOT NULL,
  message_text TEXT,
  message_format TEXT DEFAULT 'plain',
  media_json TEXT,                 -- JSON array
  metadata_json TEXT,              -- source, taskId, priority
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | delivered | failed
  error_message TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

-- 推送目标别名（方便 Agent 按名字推送而非 OpenID）
CREATE TABLE IF NOT EXISTS push_targets (
  alias TEXT PRIMARY KEY,          -- 如 "dev-team", "boss"
  channel TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

-- 飞书网关会话
CREATE TABLE IF NOT EXISTS feishu_sessions (
  session_key TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  chat_id TEXT,
  user_open_id TEXT,
  chat_type TEXT NOT NULL,         -- p2p | group
  last_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 6.2 现有表变更

```sql
-- bridge_sessions 移除 conversation_provider 列（Phase 3）
-- 暂时保留但标记 deprecated，代码中忽略该字段

-- runtime_events 增加 push 相关事件类型
-- source 可取值新增: 'push', 'push-mcp', 'feishu-gateway'
```

---

## 七、命令体系（v0.2）

### 7.1 保留命令

| 命令 | 功能 |
|---|---|
| `/threads` `/t` | 列出对话线程 |
| `/thread use` `/tu` | 切换线程 |
| `/thread new` `/tn` | 新建线程 |
| `/thread fork` `/tf` | 分叉线程 |
| `/help` | 帮助信息 |
| `/accounts` | 查看当前账号状态 |

### 7.2 废弃命令

| 命令 | 原因 | 处理 |
|---|---|---|
| `/source` | 产品合并后无第二源 | Phase 1 标记 deprecated 并提示，Phase 3 移除 |
| `/cgpt` | ChatGPT Desktop 独立驱动废弃 | 同上 |

### 7.3 新增命令

| 命令 | 功能 |
|---|---|
| `/push <alias> <message>` | 手动触发推送到预设目标 |
| `/push targets` | 列出已配置的推送目标别名 |
| `/status` | 查看 bridge 运行状态（驱动传输、各渠道连接状态） |

---

## 八、MCP Server 详细规格

### 8.1 工具定义

```typescript
// push_message
{
  name: "push_message",
  description: "推送消息到指定 IM 渠道（QQ/微信/飞书）的用户或群",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        enum: ["qq", "weixin", "feishu"],
        description: "目标 IM 渠道"
      },
      target: {
        type: "string",
        description: "目标标识：push_targets 中的别名，或 channel:type:id 格式"
      },
      text: {
        type: "string",
        description: "消息正文，支持 Markdown"
      },
      format: {
        type: "string",
        enum: ["markdown", "plain"],
        default: "markdown"
      },
      media: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["image", "file"] },
            path: { type: "string", description: "本地文件路径" }
          }
        },
        description: "可选附件"
      }
    },
    required: ["channel", "target", "text"]
  }
}

// push_task_report
{
  name: "push_task_report",
  description: "推送结构化任务报告到指定渠道，包含状态、摘要和详情",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string", enum: ["qq", "weixin", "feishu"] },
      target: { type: "string" },
      taskId: { type: "string", description: "关联的任务 ID" },
      status: { type: "string", enum: ["success", "failed", "in_progress", "blocked"] },
      summary: { type: "string", description: "一句话摘要" },
      details: { type: "string", description: "详细内容，支持 Markdown" },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            path: { type: "string" }
          }
        },
        description: "关联产物（文件路径）"
      }
    },
    required: ["channel", "target", "status", "summary"]
  }
}

// list_push_targets
{
  name: "list_push_targets",
  description: "列出所有已配置的推送目标别名",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        enum: ["qq", "weixin", "feishu"],
        description: "可选，按渠道过滤"
      }
    }
  }
}

// get_push_history
{
  name: "get_push_history",
  description: "查询推送历史记录",
  inputSchema: {
    type: "object",
    properties: {
      pushId: { type: "string" },
      taskId: { type: "string" },
      limit: { type: "number", default: 20 }
    }
  }
}
```

### 8.2 MCP Server 实现要点

- 传输层：`stdio`（Codex/Claude 子进程模式）
- 认证：通过环境变量 `BRIDGE_PUSH_TOKEN` 传入，server 启动时注入
- 底层调用：每个 MCP 工具内部调用 `http://127.0.0.1:{BRIDGE_PORT}/api/v1/push`
- 错误处理：MCP 工具返回结构化错误（包含 pushId、渠道、失败原因）

---

## 九、非功能性需求

| 维度 | 要求 |
|---|---|
| 可用性 | 单渠道故障不影响其他渠道；驱动层降级不中断服务 |
| 安全性 | 推送 API 必须 Token 鉴权；推送目标不能通过 API 枚举未授权的 OpenID |
| 可观测性 | 所有推送记录入 push_history 表；驱动层切换记录 runtime_events |
| 性能 | 单条推送 P99 < 3s；入站消息处理 P99 < 5s |
| 限流 | 推送 API 支持全局和按目标的速率限制，防止 Agent 刷屏 |
| 兼容性 | v0.1.x 的 .env 配置在 v0.2 下无需改动即可启动（新功能默认关闭） |

---

## 十、版本迁移兼容性

| v0.1.x 配置项 | v0.2 处理 |
|---|---|
| `CODEX_APP_NAME` | 保留兼容，UnifiedDriver 自动探测 |
| `CODEX_REMOTE_DEBUGGING_PORT` | 映射为 `DESKTOP_DRIVER_CDP_PORT` |
| `BRIDGE_CONVERSATION_PROVIDER` | 忽略，统一使用 UnifiedDriver |
| `QQBOT_*` | 完全保持兼容 |
| `WEIXIN_*` | 完全保持兼容 |
| 新增 `PUSH_*` | 默认 `PUSH_ENABLED=false`，不影响现有部署 |
| 新增 `FEISHU_*` | 默认 `FEISHU_ENABLED=false` |

