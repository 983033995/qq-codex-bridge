# qq-codex-bridge

QQ 到 Codex 桌面端的会话桥接原型。

## Commands

- `npm run dev`
- `npm run check`
- `npm test`

## Skills

仓库内已补充可复用的 Codex 技能说明：

- [skills/qq-codex-thread-management/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-thread-management/SKILL.md)
- [skills/qq-codex-runtime/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-runtime/SKILL.md)
- [skills/qq-codex-media/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-media/SKILL.md)

当前这些技能覆盖的是本项目已经落地的能力：

- QQ 私聊里的真实 Codex 线程查看、切换、新建、fork
- bridge 运行时启动、QQ gateway、CDP 9229、SQLite 绑定与消息链路排障
- QQ 与 Codex 之间的富媒体双向桥接

官方 `openclaw-qqbot` 中的能力目前是部分对齐状态：

- `qqbot-media` 已有对应的 `qq-codex-media`
- `qqbot-channel`、`qqbot-remind`、`qqbot-upgrade` 还没有完成对齐，因为对应的频道 API、提醒和热更新能力尚未完整实现
