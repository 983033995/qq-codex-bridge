# Security Policy

感谢你帮助 `qq-codex-bridge` 提升安全性。

## Reporting a Vulnerability

如果你发现了安全问题，请不要直接公开提交带有利用细节的 issue。

建议至少先整理以下信息：

- 漏洞影响范围
- 触发条件
- 复现步骤
- 可能的风险级别
- 是否涉及密钥、账号、消息内容或本地文件访问

如果当前仓库没有专门的私密报告渠道，请先通过尽量克制的信息创建 issue，并避免公开：

- 可直接利用的 payload
- 真实密钥
- 用户隐私数据
- 完整攻击路径

## Sensitive Data

请不要在 issue、PR、截图或日志中提交以下内容：

- QQ Bot `AppID` / `ClientSecret`
- STT / TTS API Key、Access Key
- 本地数据库内容
- 用户私聊内容
- 本地媒体缓存文件

如果你怀疑密钥已经泄露，请优先轮换，而不是仅仅删除文件。

## Supported Areas

当前建议重点关注这些安全面：

- QQ gateway 消息接入
- 本地文件引用与媒体发送
- Codex Desktop 自动化控制
- STT/TTS 第三方服务配置
- 运行时日志与隐私泄露风险

## Disclosure Expectations

我们会尽量及时确认收到安全问题，并在修复后补充公开说明。

如果问题已经在公开渠道暴露，请在报告中明确说明，以便更快评估风险。
