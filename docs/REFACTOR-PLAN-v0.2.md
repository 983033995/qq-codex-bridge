# qq-codex-bridge v0.2 重构计划

> 文档版本：2026-08-03 | 配套产品说明书：`PRODUCT-SPEC-v0.2.md`

---

## 一、重构目标

1. **统一桌面驱动**：消除双源架构，用 UnifiedDesktopDriver 适配合并后的 Codex/ChatGPT 统一应用
2. **Agent 推送能力**：新增 Webhook API + MCP Server，支持 AI Agent 主动向 IM 渠道推送消息
3. **飞书渠道接入**：新增飞书适配器，扩展 IM 覆盖范围
4. **版本适配韧性**：DOM 选择器外部化、传输层自动探测与降级，应对快速版本迭代

---

## 二、模块处置总表

### 2.1 废弃模块

| 模块路径 | 行数 | 废弃原因 | 处置阶段 |
|---|---|---|---|
| `packages/adapters/chatgpt-desktop/src/ax-client.ts` | ~515 | AX API 被 AppServer + CDP 覆盖 | Phase 3 |
| `packages/adapters/chatgpt-desktop/src/driver.ts` | ~190 | ChatgptDesktopDriver 整体废弃 | Phase 3 |
| `packages/adapters/chatgpt-desktop/src/bridge-provider.ts` | ~100 | 双源 Provider 路由废弃 | Phase 3 |
| `packages/adapters/chatgpt-desktop/src/session-registry.ts` | ~50 | 合入 UnifiedDriver | Phase 3 |
| `packages/adapters/chatgpt-desktop/src/types.ts` | ~30 | 随 driver 废弃 | Phase 3 |
| `apps/chatgpt-desktop-cli/` | ~1 文件 | 独立 CLI 不再需要 | Phase 3 |

### 2.2 重构模块

| 模块路径 | 改造内容 | 阶段 |
|---|---|---|
| `packages/adapters/codex-desktop/src/codex-app-server-driver.ts` | 升级为 UnifiedDriver 主路径；补齐 switchModel；图片事件感知 | Phase 1 |
| `packages/adapters/codex-desktop/src/codex-desktop-driver.ts` | 精简为 CDP Fallback；DOM 选择器提取到 selector-registry | Phase 2 |
| `packages/adapters/codex-desktop/src/codex-local-rollout-reader.ts` | DB 路径改为自动探测 state_*.sqlite | Phase 2 |
| `packages/adapters/codex-desktop/src/codex-local-submission-reader.ts` | DB 路径改为自动探测 logs_*.sqlite | Phase 2 |
| `packages/adapters/chatgpt-desktop/src/image-cache.ts` | 迁移到 unified-desktop/；路径探测兼容双 bundle ID | Phase 1 |
| `apps/bridge-daemon/src/bootstrap.ts` | 移除双源分支；单一 UnifiedDriver 构造 | Phase 1 |
| `apps/bridge-daemon/src/config.ts` | 新增 desktopDriver/push/feishu 配置段；移除 conversationProvider | Phase 1 |
| `apps/bridge-daemon/src/main.ts` | 注册推送 API 路由；注册飞书 gateway | Phase 2 |
| `apps/bridge-daemon/src/thread-command-handler.ts` | /source 标记 deprecated (Phase 1)；移除 (Phase 3) | Phase 1-3 |
| `packages/orchestrator/src/bridge-orchestrator.ts` | egress 接口泛化为 ChatEgressPort（已完成），支持飞书 | Phase 2 |
| `packages/domain/src/session.ts` | conversationProvider 字段标记 deprecated | Phase 1 |
| `packages/store/src/sqlite.ts` | 新增 push_history / push_targets / feishu_sessions 表 | Phase 2 |

### 2.3 新增模块

| 模块路径 | 职责 | 阶段 |
|---|---|---|
| **统一桌面驱动** | | |
| `packages/adapters/unified-desktop/src/unified-driver.ts` | 组合 AppServer + CDP，实现 DesktopDriverPort | Phase 1 |
| `packages/adapters/unified-desktop/src/feature-probe.ts` | 启动探测应用版本、传输可用性、缓存路径 | Phase 1 |
| `packages/adapters/unified-desktop/src/selector-registry.ts` | DOM 选择器版本化外部配置 | Phase 2 |
| `packages/adapters/unified-desktop/src/image-collector.ts` | 统一图片采集（缓存 diff + 事件） | Phase 2 |
| `packages/domain/src/capability.ts` | 应用能力声明类型 | Phase 1 |
| `selectors/v26.json` | v26 版本 DOM 选择器配置 | Phase 2 |
| `selectors/v27.json` | v27 版本 DOM 选择器配置 | Phase 2 |
| **Agent 推送** | | |
| `packages/push/src/push-orchestrator.ts` | 推送编排（鉴权 → 路由 → 格式化 → 限流 → 发送） | Phase 2 |
| `packages/push/src/push-api-routes.ts` | HTTP 推送 API 路由 (POST /api/v1/push) | Phase 2 |
| `packages/push/src/push-formatter.ts` | 推送内容按渠道格式化 | Phase 2 |
| `packages/push/src/push-rate-limiter.ts` | 推送限流器 | Phase 2 |
| `packages/store/src/push-repo.ts` | push_history / push_targets 持久化 | Phase 2 |
| `apps/push-mcp-server/src/server.ts` | MCP Server 入口（stdio 传输） | Phase 2 |
| `apps/push-mcp-server/src/tools.ts` | MCP 工具定义与实现 | Phase 2 |
| `bin/qq-codex-push-mcp.js` | MCP Server 可执行入口 | Phase 2 |
| **飞书渠道** | | |
| `packages/adapters/feishu/src/feishu-api-client.ts` | 飞书 API 封装 | Phase 2 |
| `packages/adapters/feishu/src/feishu-gateway.ts` | 飞书事件回调接收 | Phase 2 |
| `packages/adapters/feishu/src/feishu-sender.ts` | 飞书消息发送 | Phase 2 |
| `packages/adapters/feishu/src/feishu-channel-adapter.ts` | 飞书渠道注册 | Phase 2 |
| `packages/orchestrator/src/feishu-outbound-format.ts` | 飞书出站格式化 | Phase 2 |
| `packages/ports/src/feishu.ts` | 飞书端口定义 | Phase 2 |

---

## 三、实施路径

### Phase 0 — 紧急修复（1-2 天）

**目标**：确保现有代码在合并应用上能基本运行。

| 序号 | 任务 | 影响范围 |
|---|---|---|
| 0.1 | `ax-client.ts` 中 `BUNDLE_ID` 改为 `com.openai.codex` | 1 文件 |
| 0.2 | `image-cache.ts` 缓存路径加入 `com.openai.codex` 目录探测 | 1 文件 |
| 0.3 | `codex-app-server-driver.ts` 中 `resolveDefaultCodexBinaryPath` 兼容 `ChatGPT.app` 路径 | 1 文件 |
| 0.4 | 运行现有测试确认不破坏 | 41 个测试文件 / 216 个用例 |

### Phase 1 — 统一驱动 + 兼容层（1 周）

**目标**：创建 UnifiedDesktopDriver，对外接口不变，内部自动选路。

| 序号 | 任务 | 产出 |
|---|---|---|
| 1.1 | 创建 `packages/adapters/unified-desktop/` 目录结构 | 目录骨架 |
| 1.2 | 实现 `feature-probe.ts`：探测 AppServer WS、CDP 端口、缓存路径、应用版本 | feature-probe.ts |
| 1.3 | 实现 `capability.ts`：能力声明类型定义 | capability.ts |
| 1.4 | 实现 `unified-driver.ts`：组合 AppServerDriver + CdpFallback，实现 DesktopDriverPort | unified-driver.ts |
| 1.5 | 迁移 `image-cache.ts` 到 unified-desktop/，路径探测兼容双 bundle ID | image-collector.ts（初版） |
| 1.6 | 改造 `config.ts`：新增 `desktopDriver` 配置段，`conversationProvider` 标记 deprecated | config.ts |
| 1.7 | 改造 `bootstrap.ts`：用 UnifiedDriver 替代双源初始化 | bootstrap.ts |
| 1.8 | `/source` 命令标记 deprecated，执行时返回提示 | thread-command-handler.ts |
| 1.9 | 编写 UnifiedDriver 单元测试 | tests/unit/unified-driver.test.ts |
| 1.10 | 编写 FeatureProbe 单元测试 | tests/unit/feature-probe.test.ts |

**验收标准**：
- 所有现有 41 个测试文件、216 个用例通过
- UnifiedDriver 通过 AppServer 可完成完整对话轮次
- AppServer 不可用时自动降级到 CDP
- `.env` 不配置新变量时行为与 v0.1.x 一致

### Phase 2 — 推送能力 + 飞书 + 韧性增强（2 周）

**目标**：实现 Agent 推送全链路、飞书渠道、选择器外部化。

#### 2A. Agent 推送（5 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 2A.1 | SQLite schema 新增 push_history / push_targets 表 | sqlite.ts |
| 2A.2 | 实现 `push-repo.ts`：推送记录持久化 | push-repo.ts |
| 2A.3 | 实现 `push-rate-limiter.ts`：全局和按目标限流 | push-rate-limiter.ts |
| 2A.4 | 实现 `push-formatter.ts`：按渠道格式化推送内容 | push-formatter.ts |
| 2A.5 | 实现 `push-orchestrator.ts`：鉴权 → 路由 → 格式化 → 限流 → 发送 → 入库 | push-orchestrator.ts |
| 2A.6 | 实现 `push-api-routes.ts`：POST /api/v1/push 路由 | push-api-routes.ts |
| 2A.7 | 在 main.ts 中注册推送路由 | main.ts |
| 2A.8 | 实现 MCP Server：server.ts + tools.ts | apps/push-mcp-server/ |
| 2A.9 | 编写 bin/qq-codex-push-mcp.js 入口 | bin/ |
| 2A.10 | 编写推送链路单元测试 | tests/unit/push-*.test.ts |
| 2A.11 | 编写 MCP Server 集成测试 | tests/unit/push-mcp.test.ts |

#### 2B. 飞书渠道（3 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 2B.1 | 实现 `feishu-api-client.ts`：Token 管理、消息 API | feishu-api-client.ts |
| 2B.2 | 实现 `feishu-gateway.ts`：事件订阅回调 | feishu-gateway.ts |
| 2B.3 | 实现 `feishu-sender.ts`：消息发送 | feishu-sender.ts |
| 2B.4 | 实现 `feishu-channel-adapter.ts`：渠道注册 | feishu-channel-adapter.ts |
| 2B.5 | 实现 `feishu-outbound-format.ts`：富文本/卡片格式化 | feishu-outbound-format.ts |
| 2B.6 | config.ts 新增飞书配置段 | config.ts |
| 2B.7 | bootstrap.ts / main.ts 注册飞书 gateway | bootstrap.ts, main.ts |
| 2B.8 | 编写飞书适配器单元测试 | tests/unit/feishu-*.test.ts |

#### 2C. 韧性增强（2 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 2C.1 | 实现 `selector-registry.ts`：版本化 DOM 选择器加载 | selector-registry.ts |
| 2C.2 | 提取 codex-desktop-driver.ts 中硬编码选择器到 selectors/v26.json | selectors/ |
| 2C.3 | codex-desktop-driver.ts 改为从 registry 读取选择器 | codex-desktop-driver.ts |
| 2C.4 | 实现 `image-collector.ts`：统一图片采集 | image-collector.ts |
| 2C.5 | 本地 DB 路径改为自动探测 (state_*.sqlite, logs_*.sqlite) | rollout-reader, submission-reader |
| 2C.6 | FeatureProbe 定期 re-probe + 自动回切逻辑 | feature-probe.ts |
| 2C.7 | 编写韧性相关测试 | tests/unit/ |

**验收标准**：
- Agent 可通过 Webhook API 推送消息到 QQ/微信
- Codex/Claude 可通过 MCP 工具推送任务报告
- 飞书渠道可接收消息并回复
- DOM 选择器从外部配置加载
- 驱动层降级/回切全程有 runtime_events 记录

### Phase 3 — 清理与发布（3-5 天）

| 序号 | 任务 | 产出 |
|---|---|---|
| 3.1 | 移除 `packages/adapters/chatgpt-desktop/` 整个目录 | -800 行 |
| 3.2 | 移除 `apps/chatgpt-desktop-cli/` | -1 文件 |
| 3.3 | 移除 `/source` 和 `/cgpt` 命令 | thread-command-handler.ts |
| 3.4 | DB migration：处理 session.conversationProvider 列 | sqlite.ts |
| 3.5 | 更新 README.md（新架构、推送功能、飞书、MCP 配置） | README.md |
| 3.6 | 更新 CHANGELOG.md | CHANGELOG.md |
| 3.7 | 更新 .env.example | .env.example |
| 3.8 | 更新 package.json（新 bin、版本号 0.2.0） | package.json |
| 3.9 | 全量测试 + 手动验证 | CI |
| 3.10 | 发布 v0.2.0 | Release |

---

## 四、测试计划

### 4.1 新增测试文件

| 测试文件 | 覆盖内容 |
|---|---|
| `tests/unit/unified-driver.test.ts` | UnifiedDriver 传输选择、降级、回切 |
| `tests/unit/feature-probe.test.ts` | 探测逻辑、版本解析 |
| `tests/unit/selector-registry.test.ts` | 选择器加载、版本匹配 |
| `tests/unit/image-collector.test.ts` | 图片采集、双路径探测 |
| `tests/unit/push-orchestrator.test.ts` | 推送编排全链路 |
| `tests/unit/push-api-routes.test.ts` | HTTP API 鉴权、参数校验、错误处理 |
| `tests/unit/push-rate-limiter.test.ts` | 限流逻辑 |
| `tests/unit/push-formatter.test.ts` | 各渠道格式化 |
| `tests/unit/push-mcp.test.ts` | MCP 工具调用 |
| `tests/unit/feishu-api-client.test.ts` | 飞书 API |
| `tests/unit/feishu-gateway.test.ts` | 飞书事件处理 |
| `tests/unit/feishu-sender.test.ts` | 飞书消息发送 |
| `tests/unit/feishu-outbound-format.test.ts` | 飞书格式化 |

### 4.2 回归测试

现有 41 个测试文件、216 个用例全部保持通过，特别关注：
- `bridge-orchestrator.test.ts`：验证 egress 接口泛化不破坏现有逻辑
- `http-server.test.ts`：验证新路由不影响现有路由
- `session-key.test.ts`：验证 session 兼容性
- `thread-command-handler.test.ts`：验证 deprecated 命令行为

---

## 五、风险与应对

| 风险 | 影响 | 应对措施 |
|---|---|---|
| AppServer API 在新版本中变更 | 主路径失效 | FeatureProbe 自动降级到 CDP；版本化 API 适配层 |
| DOM 结构大幅变动 | CDP fallback 失效 | 选择器外部化 + 版本配置；社区贡献新版本选择器 |
| 飞书 API 权限申请受阻 | 飞书渠道延期 | 飞书模块独立，不影响其他渠道；先实现再申请权限 |
| 推送 API 被滥用 | IM 账号被封 | Token 鉴权 + 速率限制 + 按目标限流 |
| 合并应用新增 AI 能力（如实时语音） | 需要新的采集方式 | capability.ts 预留扩展点；FeatureProbe 探测新能力 |

---

## 六、目录结构（v0.2 最终状态）

```
qq-codex-bridge/
├── apps/
│   ├── bridge-daemon/src/         # 主进程（保留 + 增强）
│   ├── weixin-gateway/src/        # 微信网关（保留）
│   └── push-mcp-server/src/       # 【新增】MCP 推送服务
│       ├── server.ts
│       └── tools.ts
├── bin/
│   ├── qq-codex-bridge.js         # 主 CLI
│   ├── qq-codex-weixin-gateway.js # 微信网关 CLI
│   └── qq-codex-push-mcp.js       # 【新增】MCP 推送 CLI
├── packages/
│   ├── adapters/
│   │   ├── unified-desktop/src/   # 【新增】统一桌面驱动
│   │   │   ├── unified-driver.ts
│   │   │   ├── feature-probe.ts
│   │   │   ├── selector-registry.ts
│   │   │   └── image-collector.ts
│   │   ├── codex-desktop/src/     # 【重构】CDP Fallback + 本地读取器
│   │   ├── qq/src/                # QQ 适配器（保留）
│   │   ├── weixin/src/            # 微信适配器（保留）
│   │   └── feishu/src/            # 【新增】飞书适配器
│   │       ├── feishu-api-client.ts
│   │       ├── feishu-gateway.ts
│   │       ├── feishu-sender.ts
│   │       └── feishu-channel-adapter.ts
│   ├── domain/src/                # 领域层（保留 + 扩展）
│   │   ├── capability.ts          # 【新增】
│   │   └── ...
│   ├── orchestrator/src/          # 编排层（保留 + 扩展）
│   │   ├── feishu-outbound-format.ts  # 【新增】
│   │   └── ...
│   ├── ports/src/                 # 端口层（保留 + 扩展）
│   │   ├── feishu.ts              # 【新增】
│   │   └── ...
│   ├── push/src/                  # 【新增】推送模块
│   │   ├── push-orchestrator.ts
│   │   ├── push-api-routes.ts
│   │   ├── push-formatter.ts
│   │   └── push-rate-limiter.ts
│   └── store/src/                 # 存储层（保留 + 扩展）
│       ├── push-repo.ts           # 【新增】
│       └── ...
├── selectors/                     # 【新增】版本化 DOM 选择器
│   ├── v26.json
│   └── v27.json
├── docs/
│   ├── PRODUCT-SPEC-v0.2.md       # 【新增】产品说明书
│   ├── REFACTOR-PLAN-v0.2.md      # 【新增】重构计划
│   └── ...
└── tests/unit/                    # 测试（保留 + 新增 13 个文件）
```

---

## 七、工作量估算

| 阶段 | 新增代码 | 改动代码 | 删除代码 | 耗时 |
|---|---|---|---|---|
| Phase 0 | ~20 行 | ~50 行 | 0 | 1-2 天 |
| Phase 1 | ~1500 行 | ~500 行 | 0 | 1 周 |
| Phase 2A（推送） | ~2500 行 | ~200 行 | 0 | 5 天 |
| Phase 2B（飞书） | ~1500 行 | ~150 行 | 0 | 3 天 |
| Phase 2C（韧性） | ~800 行 | ~400 行 | 0 | 2 天 |
| Phase 3（清理） | ~200 行 | ~300 行 | ~900 行 | 3-5 天 |
| **合计** | **~6500 行** | **~1600 行** | **~900 行** | **~4 周** |
