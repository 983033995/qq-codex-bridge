---
name: qq-codex-runtime
description: 启动、验证和排查 qq-codex-bridge 运行时。适用于检查 QQ gateway WebSocket、Codex Desktop 远程调试端口、SQLite 会话绑定、真实消息收发链路等场景。
metadata: {"codex":{"emoji":"🛠️","repo":"qq-codex-bridge"}}
---

# QQ Codex 运行时排障

## 何时使用

当用户提到以下问题时使用本技能：

- `pnpm dev` 启不来
- QQ 机器人收不到消息
- QQ 机器人能收不能回
- Codex Desktop 没有接上 9229
- 会话绑定异常、总是重绑或线程错乱
- 想验证真实 QQ 消息是否完整走到 Codex 再回 QQ

## 启动步骤

```bash
cd /path/to/qq-codex-bridge
pnpm dev
```

预期日志：

```text
[qq-codex-bridge] codex desktop ready { launched: true|false, remoteDebuggingPort: 9229 }
[qq-codex-bridge] ready { transport: 'qq-gateway-websocket', accountKey: 'qqbot:default' }
```

## 核心检查点

### 1. Codex Desktop 远程调试端口

```bash
curl http://127.0.0.1:9229/json/version
curl http://127.0.0.1:9229/json/list
```

如果没有响应：
- 确认 Codex Desktop 已启动
- 确认使用了 `--remote-debugging-port=9229`

### 2. QQ gateway 会话文件

```bash
cat ./runtime/qq-gateway-session.json
```

预期：
- 有 `sessionId`
- 有 `lastSeq`

### 3. SQLite 会话绑定

```bash
sqlite3 ./runtime/qq-codex-bridge.sqlite \
  "select session_key, codex_thread_ref, status, last_error from bridge_sessions;"
```

### 4. 最近消息记录

```bash
sqlite3 ./runtime/qq-codex-bridge.sqlite \
  "select session_key, message_id, received_at from message_ledger order by received_at desc limit 20;"
```

## 常见问题

### QQ 能收到消息，但回复失败

优先检查：

- `msg_id` 是否为真实入站消息 ID
- 是否命中了 QQ 被动回复限制
- QQ API 返回体里是否包含业务错误码

### 能回 QQ，但落不到预期 Codex 线程

优先检查：

- 当前绑定是否为 `codex-thread:` 开头
- `/thread current` 返回是否符合预期
- Codex Desktop 左侧当前选中线程是否被正确识别

### Codex 页面无法发送消息

优先检查：

- 当前是否存在 inspectable `page` target
- composer 输入框是否可见
- 发送按钮是否可见

## 推荐验证路径

1. 启动 `pnpm dev`
2. 在 QQ 私聊发送 `/thread current`
3. 再发送普通文本消息
4. 查看 SQLite 中是否记录 inbound 和 outbound
5. 查看 Codex Desktop 左侧是否切到了预期线程

## 相关文件

- `apps/bridge-daemon/src/main.ts`
- `apps/bridge-daemon/src/thread-command-handler.ts`
- `packages/adapters/qq/src/qq-gateway-client.ts`
- `packages/adapters/qq/src/qq-api-client.ts`
- `packages/adapters/codex-desktop/src/codex-desktop-driver.ts`
