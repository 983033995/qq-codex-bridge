# 微信文本通道接入

这份文档对应仓库内置的**参考微信文本网关**。它的定位不是绑定某个特定微信实现，而是提供一套稳定的本地 HTTP 协议，先把：

- 微信侧文本入站
- `qq-codex-bridge` 编排
- 微信侧文本出站

这条链路跑通。

后面你换成真实的微信提供方时，只要让它对接这套协议，不需要重写 bridge。

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

## 2. 启动参考微信网关

可以直接复用同一个 `.env`，再补上网关变量：

```env
WEIXIN_GATEWAY_LISTEN_HOST=127.0.0.1
WEIXIN_GATEWAY_LISTEN_PORT=3200
WEIXIN_GATEWAY_BRIDGE_BASE_URL=http://127.0.0.1:3100
WEIXIN_GATEWAY_BRIDGE_WEBHOOK_PATH=/webhooks/weixin
WEIXIN_GATEWAY_EXPECTED_TOKEN=your-token
WEIXIN_GATEWAY_MESSAGE_STORE_PATH=runtime/weixin-gateway-messages.ndjson
WEIXIN_GATEWAY_RECENT_MESSAGE_LIMIT=100
```

启动方式：

```bash
pnpm dev:weixin-gateway
```

或者：

```bash
qq-codex-weixin-gateway
```

---

## 3. 入站协议

向参考网关发送微信文本消息：

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

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `senderId` | 是 | 微信发送者标识 |
| `peerId` | 否 | 会话对象标识；私聊默认回落到 `senderId` |
| `messageId` | 是 | 外部消息唯一 ID |
| `text` | 是 | 文本正文 |
| `chatType` | 否 | `c2c` 或 `group`，默认 `c2c` |
| `receivedAt` | 否 | ISO 时间戳 |
| `accountKey` | 否 | 多账号场景下可覆盖默认账号键 |

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
3. 返回 JSON：`{ "id": "..." }`

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

## 6. 当前范围

这套参考网关当前只覆盖：

- 微信**文本**入站
- bridge 文本回复出站
- 本地联调可观测性

还没有覆盖：

- 图片、语音、文件
- 群聊 `@bot`
- 真实微信提供方鉴权/签名适配
- 富媒体卡片

所以它更适合作为：

- 本地联调入口
- 真实微信服务前面的协议适配层
- 后续媒体扩展的基线
