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
| `feature-probe.ts` | 启动和周期探测可用传输（AppServer WS / CDP） |
| `unified-driver.ts` | 实现 `DesktopDriverPort`，内部自动选择 AppServer 或 CDP |
| `selector-registry.ts` | CDP DOM 选择器按版本外部化配置；自定义文件在进程重启时加载 |
| `image-collector.ts` | 统一归一化和去重 AppServer、rollout 与 CDP 媒体引用 |
| `codex-local-db-resolver.ts` | 按版本发现 state/log DB 并验证所需表列 |

**传输选择策略**：
```
启动 → FeatureProbe 探测
       ├─ AppServer WS 可用 → 主路径
       ├─ AppServer 不可用 → CDP Fallback
       └─ 均不可用 → 错误上报，等待重试
       
运行中 → 定期 re-probe（默认 5 分钟）
         AppServer 恢复 → 下一轮对话回切
         降级/回切 → 记录 runtime_events
```

### 4.2 Agent 推送层（全新）

**解决的问题**：当前架构仅支持"用户发消息 → AI 回复"单向流，无法支持 Agent 主动推送。

#### 4.2.1 HTTP 推送 API

```
POST /api/v1/push
Content-Type: application/json
Authorization: Bearer <push-token>
Idempotency-Key: <stable-key>

{
  "target": "daily-report-group",
  "message": {
    "text": "构建完成，共修改 12 个文件",
    "format": "markdown" | "plain",
    "media": [{ "type": "image", "path": "report.png" }]
  },
  "metadata": {
    "source": "codex-automation",
    "taskId": "019fc584-913c-75c2-bb91-dac225fab371",
    "priority": "normal" | "urgent"
  }
}

Response: 202 Accepted
{
  "pushId": "uuid",
  "status": "queued",
  "duplicate": false
}
```

同一幂等键固定返回原 `pushId`，不重复入队。API 另提供 `GET /api/v1/push/:pushId` 与 `GET /api/v1/push-targets`。调用者只能传管理页登记的目标别名，不能直接传 OpenID、群号或 wxid；媒体只能来自 `PUSH_OUTBOX_ROOT` 的真实文件。

#### 4.2.2 MCP Server（stdio）

为 Codex / Claude 等支持 MCP 协议的 Agent 提供原生推送工具：

**工具清单**：

| 工具名 | 描述 | 参数 |
|---|---|---|
| `push_message` | 推送文本/图片消息到目标别名；description 内嵌各渠道排版摘要 | `target`, `text`, `format`, `media`, `idempotencyKey` |
| `push_task_report` | 推送结构化任务报告 | `target`, `taskId`, `status`, `summary`, `details` |
| `list_push_targets` | 列出可推送的公开目标信息（附带 `recommendedFormat` / `formatSummary`） | 无 |
| `get_channel_format_guide` | 查询飞书/微信/QQ 消息排版规范（可按 `channel` 或 `target` 过滤） | `channel?`, `target?` |
| `get_push_status` | 查询单个推送任务状态 | `pushId` |

推荐格式：`feishu → markdown`，`weixin → plain`，`qq` 主动推送当前不可用。详见 `docs/superpowers/specs/2026-08-05-mcp-channel-format-guide-design.md`。

**MCP 配置示例**（在 Codex `.codex/mcp.json` 中）：
```json
{
  "mcpServers": {
    "qq-bridge-push": {
      "command": "qq-codex-mcp",
      "env": {
        "MCP_PUSH_BASE_URL": "http://127.0.0.1:3100",
        "MCP_PUSH_TOKEN": "your-push-token"
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
         → 目标别名解析（服务端读取真实渠道 ID）
         → 媒体沙箱校验 + 限流
         → push_jobs 持久化入队
         → Worker claim + 渠道 PushEgress 发送
         → 回写状态（delivered / failed）
```

### 4.3 飞书渠道适配器（全新）

| 子模块 | 职责 |
|---|---|
| `feishu-message-client.ts` | 飞书消息与图片 API 的受控封装 |
| `feishu-ingress.ts` | 官方 SDK 长连接接收 `im.message.receive_v1` |
| `feishu-sender.ts` | 对话出站（文本、富文本、图片） |
| `feishu-push-egress.ts` | 主动推送出站与错误分类 |
| `feishu-channel-adapter.ts` | 组合入站/出站，注册到 BridgeOrchestrator |

### 4.4 渠道出站格式化

每个渠道的 outbound 格式化独立模块：

| 渠道 | 模块 | 特性 |
|---|---|---|
| QQ | `qq-outbound-format.ts` | Markdown 可选、图片 base64 | 
| 微信 | `weixin-outbound-format.ts` | 纯文本为主、链接预览 |
| 飞书 | `feishu-sender.ts` | 文本、post 富文本、图片、文件（`im/v1/files`） |

---

## 五、配置体系（v0.2）

### 5.1 环境变量结构

```env
# ===== 桌面驱动 =====
DESKTOP_DRIVER_TRANSPORT=auto          # auto | app-server | cdp
CODEX_REMOTE_DEBUGGING_PORT=9229
DESKTOP_DRIVER_PROBE_INTERVAL_MS=300000

# ===== Agent 推送 =====
PUSH_ENABLED=true
PUSH_TOKEN=your-secure-token-at-least-32-bytes
PUSH_ALLOW_REMOTE=false
PUSH_OUTBOX_ROOT=runtime/media/push-outbox
PUSH_RATE_LIMIT_PER_MINUTE=60

# MCP 是 stdio 子进程，不监听额外端口
MCP_PUSH_BASE_URL=http://127.0.0.1:3100
MCP_PUSH_TOKEN=your-secure-token-at-least-32-bytes

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
FEISHU_ACCOUNT_ID=default

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
    "selectorProfile": "v27",
    "selectorFile": null
  },
  "push": {
    "rateLimits": { "perMinute": 60 },
    "retryPolicy": {
      "maxRetries": 3,
      "backoffMs": [5000, 30000, 120000],
      "jitter": true
    }
  }
}
```

---

## 六、数据模型扩展

### 6.1 新增表

```sql
CREATE TABLE IF NOT EXISTS push_targets (
  alias TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  account_key TEXT NOT NULL,
  target_type TEXT NOT NULL,
  provider_target_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_jobs (
  push_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  target_alias TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | sending | retry_wait | delivered | failed
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  failure_code TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (target_alias) REFERENCES push_targets(alias)
);
```

### 6.2 现有表变更

```sql
-- bridge_sessions.conversation_provider 在 v0.2 保留以兼容存量数据库。
-- 读取 chatgpt-desktop 时映射到统一桌面行为，物理删除延后到 v0.3。

-- runtime_events 增加 push 相关事件类型
-- source 可取值新增: 'push', 'mcp-push', 'feishu-ingress'
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

### 8.1 固定工具契约

| 工具 | 必填参数 | 关键行为 |
|---|---|---|
| `push_message` | `target`, `idempotencyKey`，以及文本或媒体 | 调用者显式提供稳定幂等键 |
| `push_task_report` | `target`, `taskId`, `status`, `summary` | 未提供幂等键时按 source/target/taskId/status 生成 SHA-256 稳定键 |
| `list_push_targets` | 无 | 仅返回 alias、channel、type、accountKey 和 enabled |
| `get_push_status` | `pushId` | 返回脱敏任务状态，不返回幂等键、claim 信息和媒体真实路径 |

`push_task_report.status` 固定为 `running | completed | failed`。目标始终是服务端登记的 alias，MCP schema 不提供裸渠道 ID 字段。

### 8.2 MCP Server 实现要点

- 传输层：`stdio`（Codex/Claude 子进程模式）
- SDK：`@modelcontextprotocol/sdk` 1.29.x + `StdioServerTransport`
- 认证：`MCP_PUSH_TOKEN`，未设置时回退 `PUSH_TOKEN`；至少 32 字节
- 网络边界：`MCP_PUSH_BASE_URL` 必须是无内嵌凭据的 loopback HTTP(S) URL
- 底层调用：所有工具复用现有 Push HTTP API，不新增监听端口
- 错误处理：使用 MCP `isError: true`，错误文本不包含 Bearer Token
- stdout：只承载 MCP 协议；启动错误仅写 stderr

---

## 九、非功能性需求

| 维度 | 要求 |
|---|---|
| 可用性 | 单渠道故障不影响其他渠道；驱动层降级不中断服务 |
| 安全性 | 推送 API 必须 Token 鉴权；推送目标不能通过 API 枚举未授权的 OpenID |
| 可观测性 | 所有推送记录入 push_jobs；驱动层切换记录 runtime_events |
| 性能 | 单条推送 P99 < 3s；入站消息处理 P99 < 5s |
| 限流 | 推送 API 首版提供进程级每分钟限流；按目标限流可在后续版本扩展 |
| 兼容性 | v0.1.x 的 .env 配置在 v0.2 下无需改动即可启动（新功能默认关闭） |

---

## 十、版本迁移兼容性

| v0.1.x 配置项 | v0.2 处理 |
|---|---|
| `CODEX_APP_NAME` | 保留兼容，UnifiedDriver 自动探测 |
| `CODEX_REMOTE_DEBUGGING_PORT` | 原名保留，作为 CDP fallback 端口 |
| `BRIDGE_CONVERSATION_PROVIDER` | 旧值保留解析；默认装配统一驱动并输出弃用语义 |
| `QQBOT_*` | 完全保持兼容 |
| `WEIXIN_*` | 完全保持兼容 |
| 新增 `PUSH_*` | 默认 `PUSH_ENABLED=false`，不影响现有部署 |
| 新增 `FEISHU_*` | 默认 `FEISHU_ENABLED=false` |
