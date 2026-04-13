# 微信真实网关接入

这份文档对应仓库内置的**真实微信文本网关**。它参考 `qq-codex-runner` 的接法，直接对接微信 long-poll 接口：

- 网关主动轮询微信消息
- 收到文本后转发给 `qq-codex-bridge`
- bridge 的文本回复再经本地网关发送回微信

这样你不需要额外再写一层“参考 webhook 适配器”，而是可以直接把微信文本链路跑起来。

---

## 1. 启动桥接

在项目根目录准备 `.env`，至少补上这几项：

```env
QQBOT_APP_ID=你的AppID
QQBOT_CLIENT_SECRET=你的ClientSecret

WEIXIN_ENABLED=true
WEIXIN_ACCOUNT_ID=default
WEIXIN_WEBHOOK_PATH=/webhooks/weixin
WEIXIN_EGRESS_BASE_URL=http://127.0.0.1:3200
WEIXIN_EGRESS_TOKEN=your-token
```

启动 bridge：

```bash
pnpm dev
```

---

## 2. 启动真实微信网关

可以直接复用同一个 `.env`，再补上网关变量：

```env
WEIXIN_GATEWAY_LISTEN_HOST=127.0.0.1
WEIXIN_GATEWAY_LISTEN_PORT=3200
WEIXIN_GATEWAY_BRIDGE_BASE_URL=http://127.0.0.1:3100
WEIXIN_GATEWAY_BRIDGE_WEBHOOK_PATH=/webhooks/weixin
WEIXIN_GATEWAY_EXPECTED_TOKEN=your-token
WEIXIN_GATEWAY_MESSAGE_STORE_PATH=runtime/weixin-gateway-messages.ndjson
WEIXIN_GATEWAY_RECENT_MESSAGE_LIMIT=100
WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
WEIXIN_LONG_POLL_TIMEOUT_MS=35000
WEIXIN_API_TIMEOUT_MS=15000
WEIXIN_GATEWAY_STATE_FILE_PATH=runtime/weixin-gateway-state.json
WEIXIN_LOGIN_BASE_URL=https://ilinkai.weixin.qq.com
WEIXIN_BOT_TYPE=3
WEIXIN_QR_FETCH_TIMEOUT_MS=10000
WEIXIN_QR_POLL_TIMEOUT_MS=35000
WEIXIN_QR_TOTAL_TIMEOUT_MS=480000
WEIXIN_GATEWAY_STATE_WATCH_INTERVAL_MS=1000
```

启动方式：

```bash
pnpm dev:weixin-gateway
```

或者：

```bash
qq-codex-weixin-gateway
```

首次扫码登录：

```bash
qq-codex-weixin-gateway --weixin-login
```

命令会输出二维码链接。扫码确认后，登录态会写入：

```text
runtime/weixin-gateway-state.json
```

下次再启动网关时，会自动复用这份登录态并开始 long-poll。

---

## 3. 真实入站链路

真实网关启动后，会主动调用微信接口：

- `ilink/bot/getupdates`
- `ilink/bot/sendmessage`

收到微信文本后，会自动转发到：

```text
POST http://127.0.0.1:3100/webhooks/weixin
```

也就是 bridge 内部的微信 webhook。

如果你只是想联调 bridge，而不想真的连微信，仍然可以手动用旧的调试入口：

```bash
curl -X POST http://127.0.0.1:3200/inbound/text \
  -H 'content-type: application/json' \
  -d '{
    "senderId": "wxid_alice",
    "peerId": "wxid_alice",
    "messageId": "wx-msg-001",
    "text": "你好，帮我总结一下这个仓库",
    "chatType": "c2c"
  }'
```

这个入口只用于本地调试，不是主入站模式。

---

## 4. 出站协议

bridge 会把回复 POST 到参考网关的：

```text
POST /messages
```

请求头：

```text
Authorization: Bearer your-token
Content-Type: application/json
```

请求体：

```json
{
  "peerId": "wxid_alice",
  "chatType": "c2c",
  "content": "这是 Codex 的回复",
  "replyToMessageId": "wx-msg-001"
}
```

参考网关会：

1. 校验 Bearer Token
2. 记录一条出站文本
3. 调用真实微信 `sendmessage`
4. 返回 JSON：`{ "id": "..." }`

---

## 5. 查看最近出站消息

联调时可以直接看最近消息：

```bash
curl http://127.0.0.1:3200/messages
```

也可以直接看落盘文件：

```bash
tail -f runtime/weixin-gateway-messages.ndjson
```

---

## 6. 当前范围与限制

当前这套真实网关只覆盖：

- 微信**文本** long-poll 入站
- bridge 文本回复出站
- 扫码登录与本地状态持久化
- 本地联调可观测性

还没有覆盖：

- 图片、语音、文件
- 群聊 `@bot`
- 富媒体卡片

所以它当前更适合作为：

- 微信私聊文本桥接
- long-poll 基线实现
- 后续媒体扩展的起点
