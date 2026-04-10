# Contributing

感谢你愿意参与 `qq-codex-bridge`。

这个项目目前仍处在快速迭代阶段，欢迎提交 bug 修复、文档改进、测试补充和架构建议。为了让协作更顺畅，请先读完这份说明。

## 开发环境

建议环境：

- macOS
- Node.js 20+
- `pnpm`
- 已安装 Codex Desktop

本地启动：

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
pnpm install
cp .env.example .env
pnpm dev
```

如果你不调试真实 QQ Bot，也可以只跑测试和类型检查。

## 提交前请先做这三步

```bash
pnpm run check
pnpm test
git status --short
```

要求：

- 不要提交敏感信息
- 不要把 `.env`、运行时数据库、截图、临时下载文件提交进仓库
- 提交说明尽量聚焦一个主题，不要把无关改动混在一起

## 配置与密钥

请不要提交以下内容：

- QQ Bot `AppID` / `ClientSecret`
- STT API Key / Access Key
- 本地数据库
- 本地媒体缓存
- 调试截图和临时日志

如果你发现历史提交里已经泄露了密钥，请尽快轮换。

## 提交 Issue 之前

请尽量提供这些信息：

- 使用的是哪种 STT 模式
  - QQ ASR
  - OpenAI 兼容
  - 火山
  - 本地 `whisper.cpp`
- 是否能稳定连接 Codex Desktop 的 `9229`
- 出问题时的终端日志
- 如果和消息渲染有关，附一张 QQ 侧截图

## Pull Request 建议

一个好的 PR 最好包含：

- 改动目的
- 改动范围
- 风险点
- 验证方式
- 如果涉及 QQ 或 Codex UI 行为，附上复现步骤

## 当前最需要的贡献方向

- Codex 回复采集稳定性
- QQ 富媒体消息显示一致性
- 线程管理体验
- 文档和示例配置
- 已知问题的回归测试

## 代码风格

当前项目以这些原则为主：

- TypeScript
- 小步提交
- 先写测试，再补实现
- 尽量保持适配层和编排层边界清晰

如果你准备做较大改动，建议先开一个 issue 讨论方案。
