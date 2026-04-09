# QQ 私聊线程管理实施计划

1. 扩展 DesktopDriver 接口和绑定模型，使其支持列出真实线程、切换线程和创建新线程。
2. 为 Codex Desktop driver 增加边栏线程 DOM 读取、线程点击切换和“新线程”按钮驱动。
3. 扩展 transcript store，提供最近几轮 QQ 对话读取能力，供 fork 摘要构造使用。
4. 新增 QQ 私聊线程命令处理器，支持 `/threads`、`/thread current`、`/thread use`、`/thread new`、`/thread fork`。
5. 在主入口中优先处理私聊线程命令，非命令消息继续进入现有 orchestrator。
6. 补充测试并做真实联调验证。
