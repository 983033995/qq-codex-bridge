# vNext Progress

## Snapshot

- Updated: 2026-08-10
- Branch / Worktree: `codex/vnext` / `/Volumes/13759427003/AI/qq-codex-bridge-vnext`
- Current milestone: M0 — 隔离、证据与执行基线
- Overall status: on_track

## Completed

- [x] M0-01（部分）— 从原仓库 `HEAD` `52839e76ddef083fd9af314207e5576998801b76` 创建独立 sibling worktree，并复制三份 vNext 权威文档。
- [x] M0-02 — 建立本进度台账。

## In Progress

- [ ] M0-01 — 提交文档基线并复核原始工作区未变化。

## Next

- [ ] M0-03 — 捕获 Node、pnpm、macOS、Codex、CodeGraph/GitNexus 与 `check/test/build` 工程基线。
- [ ] M0-04 — 建立 `docs/decisions/vnext/`。
- [ ] M1-01 — 建立 vNext 包结构。

## Verification

| Command / Check | Result | Date |
|---|---|---|
| `git worktree add -b codex/vnext ... 52839e7` | PASS；新 worktree 创建成功 | 2026-08-10 |
| 原工作区 `git status --porcelain=v1` | 57 项；SHA-256 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |
| 原工作区 `codegraph status` | PASS；155 files / 2,665 nodes / 7,360 edges，索引最新 | 2026-08-10 |
| 原工作区 `npx gitnexus status` | 未建立 GitNexus 索引；后续使用 CodeGraph | 2026-08-10 |

## Risks and Blockers

| ID | Impact | Mitigation | Owner |
|---|---|---|---|
| R-M0-01 原工作区含 57 项用户修改 | 极高：误操作会覆盖用户工作 | 所有业务开发只在 sibling worktree；每次 M0 关键写操作后复核状态指纹 | Codex |
| R-EXT-01 真实渠道、Router 与 Apple 凭据尚未提供 | 后续真实 E2E、24 小时 Gate、签名发布将阻塞 | 先完成全部 Fake/Contract/Integration、本地安装和无需凭据的工作，届时集中请求最小输入 | User |

## Decisions

| ADR / Decision | Reason |
|---|---|
| 以 `52839e76ddef083fd9af314207e5576998801b76` 创建 `codex/vnext` | 避免把原始脏工作区的任何非 vNext 修改带入新分支 |
| 新 worktree 使用 `/Volumes/13759427003/AI/qq-codex-bridge-vnext` | 计划推荐路径不存在，满足 sibling 隔离要求 |
| 代码理解和现有 Symbol 影响分析使用 CodeGraph | 原仓库 CodeGraph 索引可用且最新；GitNexus 未建立索引 |
