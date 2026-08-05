# Testing

本项目测试分为三层（全部通过 `pnpm test` 执行）：

- **unit**: 领域逻辑、格式化、配置、推送守卫等纯单元。
- **contract**: 与 QQ 网关、Codex Desktop Driver（AppServer + CDP）的契约验证（使用模拟但贴近真实协议）。
- **e2e**: 编排流程（私聊、群聊、线程、重绑定恢复），目前仍以模拟驱动为主，便于 CI 快速验证。

**重要**：`pnpm test` **仅模拟测试**，无法替代真实渠道与 Codex App 的消息触达验证。

---

## 真实渠道 + Codex App 消息触达验证（推荐手动执行）

目标：确认真实 QQ / 微信 / 飞书 消息能到达 Codex App（AppServer 优先），Codex 的回复能原路返回 IM；线程命令、媒体、推送也工作。

### 前置条件

1. 准备好至少一个真实渠道：
   - QQ：`.env` 中填写有效的 `QQBOT_APP_ID` / `QQBOT_CLIENT_SECRET`（已在平台创建机器人）。
   - 微信：运行 `pnpm weixin:login`（或 `qq-codex-weixin-gateway --weixin-login`）扫码登录，确认 `WEIXIN_ENABLED=true`。
   - 飞书：配置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 并启用事件订阅。
2. 桌面端 Codex / ChatGPT App **必须正在运行**（AppServer 会由桌面 App 自己启动）。
3. 复制 `.env.example` 为 `.env` 并至少启用一个渠道 + 真实凭证。
4. 启动真实桥接：
   ```bash
   pnpm dev
   ```
   观察日志中出现：
   - `discovered running desktop codex app-server (real touch) { url: "ws://127.0.0.1:xxxxx" }`
   - `codex desktop ready`
   - `channel ready`（weixin 或 qq）
   - `admin ready` + `ready`

   此时桥接已**连接到桌面 App 自己的 app-server**（而非孤立的 managed 实例），消息会触达你当前打开的 Codex 侧边栏线程。

5. 访问管理页：`http://127.0.0.1:3100/admin`（端口以实际运行为准），用于登记推送目标、查看事件。

### 真实验证 checklist（按顺序）

| 场景 | 如何验证（真实操作） | 预期 |
|------|---------------------|------|
| 文本往返 | 在已登录的微信/QQ 私聊发消息给机器人 | Codex App 收到并回复，回复发回 IM（保留代码块/列表） |
| 线程管理 | 发送 `/t`、`/tn 新线程标题`、`/tu 1` | 桌面 Codex 侧边栏出现/切换对应线程；新线程标题正确 |
| 图片理解 | 发送截图 | Codex 能看到图片并分析，图片结果或描述回传 |
| 语音 | 发送语音 | 转写后进入 Codex，回复返回 |
| Agent 主动推送 | 启用 `PUSH_ENABLED=true` + 强 Token；在 admin 登记目标；或用 MCP `push_message` | 消息推送到真实 IM（飞书/微信推荐，QQ 主动推送当前受限） |
| 媒体回传 | 请求 Codex 生图 | 生成的图片自动通过桥接发回 IM |
| 多账号 | 配置多个 QQ bot 或 Weixin | 不同 accountKey 独立会话 |

**关键观察点**（日志中应出现）：
- AppServer: `thread/start`、`turn/start`、`agent/delta` 等 JSON-RPC 交互。
- 入站：`[qq-codex-bridge] inbound` 或对应渠道日志。
- 出站：`deliver` + 渠道 sender 日志。
- 发现日志：`discovered running desktop codex app-server (real touch)`

### 仅用真实 AppServer（不依赖 CDP）

当前默认 `DESKTOP_DRIVER_TRANSPORT=auto`：
- 优先使用桌面 App 暴露的 AppServer（JSON-RPC WS）。
- 仅在发送确认前失败时安全降级 CDP。
- 模型切换、线程列表现在主要走 AppServer（写 `~/.codex/config.toml`）。

如需强制：
```env
DESKTOP_DRIVER_TRANSPORT=app-server
```

### 推送真实测试（Agent → IM）

1. 在 `.env` 启用：
   ```env
   PUSH_ENABLED=true
   PUSH_TOKEN=至少32字节随机串
   ```
2. 重启 bridge。
3. 在任意私聊发 `/push targets` 查看可用目标（需先在 admin 页从真实会话创建别名）。
4. 通过 MCP（Codex/Claude 配置 `qq-codex-mcp`）或 HTTP 调用 `push_message`。
5. 或直接在 IM 里 `/push <alias> 构建完成`。

飞书推荐 `format=markdown`，微信推荐 `plain`（可先调用 `get_channel_format_guide`）。

### 已知真实环境限制（必须接受）

- QQ 主动推送（HTTP/MCP）当前固定 `channel_unsupported`（腾讯未开放经验证 API）。
- 微信入站目前只支持文本 + 语音转写，图片/视频会回复占位提示。
- 飞书富文本走 post + md 渲染。
- AppServer 协议可能随 Codex 版本演进（驱动会尽力兼容 + recency_at 排序等）。

### 如何在 CI 之外做回归

- 不要依赖 `pnpm test` 判断真实触达。
- 维护一个私有的测试机器人 + 测试群/私聊。
- 定期手动或用脚本（未来可扩展 `--real-smoke`）跑 checklist。
- 重大改动后至少验证一次：文本 + `/tn` + 图片 + 一次推送。

---

**总结**：模拟测试保证逻辑正确；**真实触达必须用 `pnpm dev` + 真实凭证 + 正在运行的 Codex App** 来完成验证。当前驱动已增强自动发现桌面 App 的 app-server，优先连接它以实现真正的消息触达。
