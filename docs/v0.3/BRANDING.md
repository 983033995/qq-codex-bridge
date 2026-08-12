# OmniAgent Gateway — 品牌与兼容迁移规范

## 1. 新产品名

v0.3 起用户可见产品名统一为：

> **OmniAgent Gateway**

不再使用 `QQ Codex Bridge` 作为产品名称。

## 2. 命名理由

当前产品已经同时包含：

- QQ / 微信 / 飞书多渠道入口
- Codex AppServer Conversation
- Inbound Intelligent Router
- MCP AI Control Plane
- Setup / Approval / Task / Diagnostics
- Control Center

因此原名称同时过度绑定 QQ 与 Codex，无法表达产品真实边界。

`OmniAgent Gateway` 表达的是：

- Omni：多渠道、多入口、未来可扩展。
- Agent：面向 Agent 工作流，而不是单纯 Bot 转发。
- Gateway：核心价值是本地网关、路由、生命周期和控制平面。

## 3. v0.3 命名层级

### 产品显示名

```text
OmniAgent Gateway
```

### 管理界面

```text
OmniAgent Gateway Control Center
```

### Runtime

```text
OmniAgent Gateway Runtime
```

### 智能路由

```text
Inbound Intelligent Router
中文：入站智能路由
```

### MCP Server

用户可见名称建议：

```text
OmniAgent Gateway MCP
```

## 4. CLI 目标命名

新 CLI：

```text
omniagent-gateway
```

推荐子命令：

```text
omniagent-gateway mcp
omniagent-gateway start
omniagent-gateway stop
omniagent-gateway restart
omniagent-gateway status
omniagent-gateway doctor
omniagent-gateway open
```

## 5. 兼容名称

v0.3 不直接删除：

```text
qq-codex-bridge
qq-codex-bridge-vnext
qq-codex-mcp
qq-codex-weixin-gateway
```

处理方式：

- 旧 bin 转发到统一新实现。
- 输出一次非阻断 deprecation 提示。
- 不要求老用户立即改 MCP 配置。
- 正式 release note 明确迁移方式。

## 6. npm 包名

v0.3 开发分支暂不直接强制修改 npm package identifier，因为这会同时影响：

- 已发布包
- MCP 配置
- npx 调用
- README 安装命令
- 现有自动化脚本

正式发布前需要确认 `omniagent-gateway` npm 名称可用，并决定：

1. 发布新包 `omniagent-gateway`。
2. 旧 `qq-codex-bridge` 包继续发布一个兼容版本，依赖/转发新包。
3. 设置弃用说明，但至少保留一个完整迁移周期。

## 7. GitHub 仓库名

仓库当前仍为：

```text
983033995/qq-codex-bridge
```

目标建议：

```text
983033995/omniagent-gateway
```

仓库重命名应放到 v0.3 发布窗口执行，而不是开发中途执行，原因是避免破坏：

- 当前分支/PR 链接
- CI
- 文档引用
- npm repository 字段
- 用户 clone remote

GitHub rename 后应依赖 GitHub redirect，并同步更新 package.json / README / homepage。

## 8. 本地目录迁移

旧目录：

```text
~/.qq-codex-bridge/
```

新目录：

```text
~/.omniagent-gateway/
```

迁移要求：

- 首次 v0.3 Runtime 启动自动检测旧目录。
- migration 成功后新写入全部使用新目录。
- 不立即删除旧目录；保留 rollback 依据。
- Secret 迁移必须原子化，不得输出明文日志。

## 9. 内部代码命名

新代码禁止继续引入以下领域级命名：

```text
QQBridgeService
QQCodexRuntime
qqcb*
qqCodex*
```

渠道 Adapter 自身可以使用 `qq`：

```text
QqChannelAdapter
QqSetupProvider
```

但核心领域应使用中性名称：

```text
GatewayRuntime
InboundGateway
InboundRouter
ConversationService
ChannelControlService
```

## 10. UI 文案规范

禁止新增：

```text
QQ Codex Bridge
QQ Bridge
```

允许在“兼容/迁移”页面出现旧名，并必须带说明：

```text
旧名称：qq-codex-bridge
```

## 11. Definition of Done

正式 v0.3 Release Candidate 前：

- [ ] Control UI 品牌全部改为 OmniAgent Gateway。
- [ ] 新日志/诊断不再使用 QQ Codex Bridge。
- [ ] MCP 显示名改为 OmniAgent Gateway MCP。
- [ ] 新 CLI `omniagent-gateway` 可用。
- [ ] 旧 CLI 兼容。
- [ ] 本地目录迁移通过。
- [ ] npm package migration 决策完成。
- [ ] GitHub repo rename 在发布窗口执行或明确延期原因。
