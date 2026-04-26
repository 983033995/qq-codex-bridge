# ChatGPT Desktop Provider 与独立 CLI 设计

## 背景

当前项目通过 `Codex Desktop` 驱动层把 QQ / 微信等渠道消息转成桌面端对话，再把回复回传到渠道。前期实测已经确认 `ChatGPT Desktop` 也具备可自动化的关键能力：

- 可以通过 macOS Accessibility 找到输入框和发送按钮
- 可以对发送按钮执行 `AXPress`
- 文本回复会出现在 Accessibility UI 树的 `AXStaticText` 中，**读取字段为 `kAXDescriptionAttribute`（非 `kAXValueAttribute`）**
- 图片生成结果会落入 ChatGPT Desktop 的 Kingfisher 图片缓存
- ChatGPT Desktop 没有发现类似 Codex Desktop 的 CDP 调试入口
- ChatGPT Desktop 内核为 WKWebView 套壳 chatgpt.com，内置 `Skybridge` JS Bridge，但 WKWebView 不暴露 CDP，外部无法注入 JS；XPC `com.openai.chat-helper` 仅负责 App 生命周期，不暴露对话能力

因此，ChatGPT Desktop 不能按 Codex Desktop 的 CDP 路线复用，但可以作为一个新的本机对话 Provider 接入。

## 目标

- 抽出一个独立的 `ChatGPT Desktop` 能力层，可以被 CLI、Codex、Claude、脚本和当前桥接项目复用
- 支持文本问答和图片生成两类任务
- 在当前桥接项目中作为另一种对话源，可按渠道、会话或命令切换 `codex-desktop` / `chatgpt-desktop`
- 保持现有 QQ / 微信渠道适配层和 `BridgeOrchestrator` 的职责基本稳定
- 避免多个外部工具同时直接操作 ChatGPT Desktop UI，统一通过队列串行化

## 非目标

- 不逆向或复刻 ChatGPT 私有后端 API
- 不依赖抓包、注入、修改本地缓存来驱动会话发送
- 不承诺 ChatGPT Desktop UI 改版后零维护
- 第一版不做多窗口并发生成图片
- 第一版不强求完整复刻 ChatGPT 侧栏所有会话管理能力

## 总体架构

推荐架构是“核心库 + 本地控制者 + CLI + 桥接适配器”。

```text
Codex / Claude / shell / other apps
        |
        v
chatgpt-desktop CLI
        |
        v
chatgpt-desktop daemon 或 in-process queue
        |
        v
packages/adapters/chatgpt-desktop
        |
        v
ChatGPT Desktop.app

QQ / 微信 / 渠道 bot
        |
        v
BridgeOrchestrator
        |
        v
ProviderRouter
        |
        +-- CodexDesktopProvider
        |
        +-- ChatgptDesktopProvider
```

核心原则：**同一台机器上只能有一个逻辑控制者直接操作 ChatGPT Desktop UI**。CLI、bridge daemon、未来 MCP server 都应该通过同一个控制者排队，不能各自直接写 AppleScript / Swift 去点 UI。

## 模块划分

| 模块 | 建议路径 | 职责 |
|---|---|---|
| ChatGPT Desktop 核心驱动 | `packages/adapters/chatgpt-desktop` | 激活 App、写入 prompt、发送、读取文本、扫描图片缓存、健康检查 |
| 本地任务队列 | `packages/adapters/chatgpt-desktop/src/queue.ts` | 串行执行 turn，防止多个任务抢 UI |
| 会话注册表 | `packages/adapters/chatgpt-desktop/src/session-registry.ts` | 维护本地 `sessionKey -> chatgptThreadRef` 映射 |
| CLI 应用 | `apps/chatgpt-desktop-cli` | 暴露 `ask`、`image`、`chat`、`health` 等命令 |
| CLI bin | `bin/chatgpt-desktop.js` | 供 shell / Codex / Claude 调用 |
| Provider 路由 | `packages/orchestrator` 或 `apps/bridge-daemon` | 根据配置或命令选择 Codex / ChatGPT |
| Bridge 适配器 | `packages/adapters/chatgpt-desktop/src/bridge-provider.ts` | 把 ChatGPT 结果转成 `OutboundDraft` |

## ChatGPT Desktop 核心驱动

核心驱动不应该知道 QQ、微信、Codex 或 bridge daemon 的细节。它只暴露本机 ChatGPT Desktop 能力。

建议接口：

```ts
export type ChatgptDesktopTaskMode = "text" | "image";

export type ChatgptDesktopRunInput = {
  sessionKey?: string;
  threadRef?: string | null;
  mode: ChatgptDesktopTaskMode;
  prompt: string;
  timeoutMs?: number;
};

export type ChatgptDesktopMedia = {
  kind: "image";
  localPath: string;
  mimeType: string;
  fileSize: number;
  originalName: string;
};

export type ChatgptDesktopRunResult = {
  ok: true;
  provider: "chatgpt-desktop";
  threadRef: string | null;
  turnId: string;
  text: string;
  media: ChatgptDesktopMedia[];
  elapsedMs: number;
} | {
  ok: false;
  provider: "chatgpt-desktop";
  errorCode:
    | "app_not_ready"
    | "accessibility_denied"
    | "input_not_found"
    | "send_failed"
    | "reply_timeout"
    | "reply_parse_failed"
    | "image_not_found";
  message: string;
};
```

核心流程：

```text
ensureAppReady()
-> openOrCreateThread()
-> snapshotImageCache()
-> focusComposer()
-> setComposerText(prompt)
-> pressSendButton()
-> waitForReplyStable()
-> collectTextFromAxTree()
-> collectNewImagesFromCache()
-> return structured result
```

## 文本回复采集

文本回复第一版走 Accessibility UI 树。

采集策略：

| 步骤 | 说明 |
|---|---|
| 发送前快照 | 记录当前可见回复文本和输入框内容 |
| 发送确认 | 发送按钮从 `发送` 变为 `停止生成` 或输入框清空 / 会话推进 |
| 轮询 UI 树 | 读取 `AXStaticText` 的 **`kAXDescriptionAttribute`**（不是 `kAXValueAttribute`），排除侧栏标题、输入框原文、按钮文字 |
| 稳定判定 | `AXButton desc='发送'` 恢复可见（`停止生成` 消失），同时 AX 文本连续 N 次不变 |
| 输出结果 | 返回本轮新增 assistant 文本 |

第一版可以先只支持“当前窗口最新一轮回复”，不承诺从历史聊天中精确抽取任意 turn。

## 图片结果采集

图片生成第一版走 ChatGPT Desktop 本地 Kingfisher 缓存 diff。

缓存目录：

```text
~/Library/Caches/com.openai.chat/com.onevcat.Kingfisher.ImageCache/com.onevcat.Kingfisher.ImageCache.com.openai.chat/DiskStorage/
```

> **实测修正**：缓存文件在 `DiskStorage/` 子目录下，文件名为哈希串（无扩展名），大小约 2MB，为原始图片数据；图片生成耗时约 40s，缓存文件与"发送按钮恢复"信号同步出现。

采集策略：

| 步骤 | 说明 |
|---|---|
| 发送前缓存快照 | 记录文件名、birthtime、size、mime |
| 发送生图 prompt | prompt 中明确要求生成一张图片 |
| 等待 UI 状态 | 优先等待“图片已创建”或图片相关静态文本 |
| 缓存 diff | 找出新增文件 |
| MIME 过滤 | 用文件头或 `file` 结果过滤 PNG / JPEG / WebP |
| 复制归档 | 复制到 bridge 可访问的 `runtime/media` 或 CLI 指定输出目录 |

多张图片建议由 CLI 串行执行多轮：

```text
chatgpt-desktop images --count 3 "生成 3 张图标"
-> image round 1
-> image round 2
-> image round 3
```

不建议第一版依赖“一轮 prompt 生成多张独立图”，实测不稳定。

## 会话与数据结构

当前项目的会话字段偏 Codex 专用：

```ts
codexThreadRef
lastCodexTurnId
```

为支持多 Provider，建议逐步引入中立字段。

建议领域模型：

```ts
export type ConversationProviderKind =
  | "codex-desktop"
  | "chatgpt-desktop";

export type ConversationBinding = {
  sessionKey: string;
  provider: ConversationProviderKind;
  threadRef: string | null;
};

export type ConversationTurnRef = {
  provider: ConversationProviderKind;
  turnId: string | null;
};
```

建议数据库迁移：

| 新字段 | 说明 |
|---|---|
| `provider` | 当前会话使用的 Provider，默认 `codex-desktop` |
| `provider_thread_ref` | Provider 中立会话引用 |
| `last_provider_turn_id` | Provider 中立 turn 引用 |

兼容策略：

- 第一阶段保留 `codex_thread_ref` 和 `last_codex_turn_id`
- 新增字段为空时，从旧字段迁移或回退
- Codex provider 同时写旧字段和新字段
- ChatGPT provider 只写新字段
- 稳定后再考虑移除旧字段

## CLI 协议

CLI 默认输出 JSON，方便 Codex、Claude、shell、Node、Python 调用。

### `health`

```bash
chatgpt-desktop health --json
```

输出：

```json
{
  "ok": true,
  "appRunning": true,
  "accessibility": true,
  "cacheDirFound": true,
  "frontmost": false
}
```

### `ask`

```bash
chatgpt-desktop ask --json "请用一句话解释 MCP"
```

输出：

```json
{
  "ok": true,
  "provider": "chatgpt-desktop",
  "threadRef": "chatgpt-local:20260425-001",
  "turnId": "turn_01",
  "text": "MCP 是一种让模型连接外部工具和数据源的协议。",
  "media": [],
  "elapsedMs": 4200
}
```

### `chat`

```bash
chatgpt-desktop chat --json --session "qq:c2c:12345" "继续刚才的话题"
```

说明：

- `--session` 是调用方自己的稳定会话 key
- 驱动层通过 session registry 映射到 ChatGPT 本地 threadRef

### `image`

```bash
chatgpt-desktop image --json --out-dir runtime/media/chatgpt "一只白色机械键盘的产品图"
```

输出：

```json
{
  "ok": true,
  "provider": "chatgpt-desktop",
  "threadRef": "chatgpt-local:20260425-002",
  "turnId": "turn_01",
  "text": "图片已创建",
  "media": [
    {
      "kind": "image",
      "localPath": "/Volumes/13759427003/AI/qq-codex-bridge/runtime/media/chatgpt/image-001.png",
      "mimeType": "image/png",
      "fileSize": 172000,
      "originalName": "image-001.png"
    }
  ],
  "elapsedMs": 38000
}
```

### `images`

```bash
chatgpt-desktop images --json --count 3 --out-dir runtime/media/chatgpt "三张不同风格的 app icon"
```

说明：

- 内部串行调用 `image`
- 输出 `media` 数组
- 某一轮失败时，默认返回部分成功结果和错误列表

### 错误输出

```json
{
  "ok": false,
  "provider": "chatgpt-desktop",
  "errorCode": "reply_timeout",
  "message": "Timed out waiting for ChatGPT Desktop reply after 60000ms"
}
```

## 本地控制者与队列

第一版 CLI 可以先以进程内队列运行，但一旦要同时服务 bridge daemon、Codex 和 Claude，建议升级成本地 daemon。

推荐形态：

```text
chatgpt-desktopd
  listens on 127.0.0.1
  owns ChatGPT Desktop UI
  serializes tasks
  exposes JSON RPC or HTTP endpoints

chatgpt-desktop CLI
  thin client
  sends task to daemon
  prints JSON result
```

本地 daemon 只监听 `127.0.0.1`，默认不开放外网访问。

队列策略：

| 策略 | 说明 |
|---|---|
| 全局串行 | 同一时刻只跑一个 ChatGPT Desktop turn |
| 任务超时 | 文本默认 60s，图片默认 180s |
| 可取消 | 未来支持取消当前任务并按停止按钮 |
| 任务日志 | 每个任务保存 prompt 摘要、状态、耗时、错误 |
| 结果归档 | 图片复制到稳定目录，不直接返回缓存路径 |

## 桥接项目接入点

当前 `BridgeOrchestrator` 已经依赖 `ConversationProviderPort`，这是接入 ChatGPT Desktop 的主要入口。

现状：

```text
BridgeOrchestrator
-> conversationProvider.runTurn()
-> codexDesktop.openOrBindSession()
-> codexDesktop.sendUserMessage()
-> codexDesktop.collectAssistantReply()
```

建议改成：

```text
BridgeOrchestrator
-> conversationProvider.runTurn()
-> ProviderRouter.selectProvider(message, session)
-> selectedProvider.runTurn(message)
-> OutboundDraft[]
```

Provider 选择规则：

| 规则 | 示例 |
|---|---|
| 全局默认 | `BRIDGE_DEFAULT_PROVIDER=codex-desktop` |
| 渠道默认 | QQ 默认 Codex，微信默认 ChatGPT |
| 会话持久配置 | 某个 `sessionKey` 固定走 ChatGPT |
| 临时命令切换 | `/source chatgpt`、`/source codex` |
| 按能力路由 | 文本走 Codex，生图走 ChatGPT |

第一版最小接入可以只支持环境变量：

```text
BRIDGE_CONVERSATION_PROVIDER=codex-desktop
BRIDGE_CONVERSATION_PROVIDER=chatgpt-desktop
```

后续再加 per-session 切换命令。

## 与现有 `DesktopDriverPort` 的关系

短期可行做法：让 `ChatgptDesktopDriver` 实现 `DesktopDriverPort` 的必要方法，未支持的方法返回保守值或抛 `DesktopDriverError`。

长期推荐：把接口拆成中立 Provider 接口。

建议新增：

```ts
export interface ConversationProviderDriver {
  provider: ConversationProviderKind;
  ensureReady(): Promise<void>;
  openOrBindSession(sessionKey: string, binding: ConversationBinding | null): Promise<ConversationBinding>;
  runTurn(
    binding: ConversationBinding,
    message: InboundMessage,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]>;
  markSessionBroken(sessionKey: string, reason: string): Promise<void>;
}
```

Codex Desktop adapter 和 ChatGPT Desktop adapter 都实现这个新接口。旧的 `DesktopDriverPort` 可以先保留给 Codex 相关命令和兼容测试。

## 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| ChatGPT UI 改版 | 控件定位失败 | 多策略定位、健康检查、失败截图、版本记录 |
| 多客户端抢 UI | 结果错乱 | 单一 daemon / 全局队列 |
| 图片缓存命名无序 | 图片归因困难 | 发送前后 diff、MIME 过滤、birthtime 排序、串行生成 |
| 会话切换不稳定 | 回复进错会话 | 第一版优先新会话或本地 session registry，切换前后校验标题 |
| 用户手动操作干扰 | 自动化状态不可预期 | 执行任务时前置 App、校验输入框、失败重试 |
| Accessibility 权限缺失 | 无法操作 UI | `health` 明确提示权限状态 |
| 回复超时 | bot 无响应 | 超时返回结构化错误，bridge 标记可恢复错误 |

## 分阶段实施

### Phase 1：独立 CLI MVP

- 新增 `packages/adapters/chatgpt-desktop`
- 新增 `apps/chatgpt-desktop-cli`
- 支持 `health`、`ask`、`image`
- 输出稳定 JSON
- 图片复制到指定 `--out-dir`
- 串行执行，暂不做 daemon

验收：

- `chatgpt-desktop health --json` 能检查 App、AX 权限、缓存目录
- `chatgpt-desktop ask --json "..."` 能返回文本
- `chatgpt-desktop image --json "..."` 能返回本地图片路径

### Phase 2：Bridge 单 Provider 切换

- 新增 `ChatgptDesktopProvider`
- 增加 `BRIDGE_CONVERSATION_PROVIDER`
- bridge 可整体切换为 Codex 或 ChatGPT
- `OutboundDraft.mediaArtifacts` 支持 ChatGPT 图片结果回传

验收：

- QQ / 微信消息可以整体切换到 ChatGPT Desktop
- 文本回复能回渠道
- 生图结果能以媒体附件回渠道

### Phase 3：多 Provider 路由

- 引入 provider-neutral session 字段
- 增加 per-session provider 配置
- 支持 `/source chatgpt`、`/source codex`
- 支持按任务能力路由

验收：

- 同一渠道不同会话可选择不同 Provider
- 切换 Provider 后不会污染原有会话绑定
- Codex 旧链路行为保持不变

### Phase 4：本地 daemon / MCP

- 增加 `chatgpt-desktopd`
- CLI 变成 thin client
- bridge daemon 调本地 daemon
- 可选增加 MCP server，给 Claude / Codex 以工具形式调用

验收：

- 多个外部调用方同时请求时，任务按队列串行执行
- 单个任务失败不影响后续任务
- daemon 重启后 session registry 可恢复

## 验证策略

- 单元测试：
  - CLI 参数解析
  - JSON 输出结构
  - 图片缓存 diff 过滤
  - session registry 读写
  - ProviderRouter 选择规则
- 合同测试：
  - `ChatgptDesktopRunResult` 到 `OutboundDraft` 的转换
  - 错误码到 bridge 可恢复错误的映射
- 本机集成测试：
  - 真实 ChatGPT Desktop 文本问答
  - 真实 ChatGPT Desktop 生图
  - 连续 3 次图片串行生成
  - 人工干扰窗口焦点后的恢复能力
- 回归测试：
  - `pnpm run check`
  - `pnpm test`

## 建议的第一步实现

优先做 Phase 1。原因是它不需要立刻迁移 bridge session schema，也不会影响现有 Codex 主链路。CLI MVP 稳定后，再把它包进 bridge provider，风险会小很多。

第一批文件建议：

```text
packages/adapters/chatgpt-desktop/src/types.ts
packages/adapters/chatgpt-desktop/src/ax-client.ts
packages/adapters/chatgpt-desktop/src/image-cache.ts
packages/adapters/chatgpt-desktop/src/driver.ts
packages/adapters/chatgpt-desktop/src/session-registry.ts
apps/chatgpt-desktop-cli/src/cli.ts
bin/chatgpt-desktop.js
```

