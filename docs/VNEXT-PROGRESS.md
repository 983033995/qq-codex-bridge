# vNext Progress

## Snapshot

- Updated: 2026-08-10
- Branch / Worktree: `codex/vnext` / `/Volumes/13759427003/AI/qq-codex-bridge-vnext`
- Current milestone: M1 — 核心领域与基础设施
- Overall status: on_track

## Completed

- [x] M0-01 — 从原仓库 `HEAD` `52839e76ddef083fd9af314207e5576998801b76` 创建独立 sibling worktree，复制并核对三份 vNext 权威文档；文档基线 Commit `5305b9d`。
- [x] M0-02 — 建立本进度台账。
- [x] M0-03 — 捕获环境、CodeGraph、Codex 可发现性以及 `check/test/build` 工程基线；旧测试基线为 5 个 AppServer Fake 时序超时。
- [x] M0-04 — 建立 `docs/decisions/vnext/`。
- [x] M0 Gate — 通过；报告见 `docs/reports/vnext/M0-GATE.md`。
- [x] M1-01 — 建立 4 个 vNext App 与 10 个 Adapter/Application/Infrastructure 包的最小入口；现有 `domain`/`ports` 目录保留并将在后续任务内增量替换语义。

## In Progress

- [ ] M1-02 — 实现领域模型、状态机和关键不变量。

## Next

- [ ] M1-03 — 实现 Ports 与可复用 Contract Suite。
- [ ] M1-04 — 实现配置 Schema、Revision、Apply Planner 与 Keychain。

## Verification

| Command / Check | Result | Date |
|---|---|---|
| `git worktree add -b codex/vnext ... 52839e7` | PASS；新 worktree 创建成功 | 2026-08-10 |
| 原工作区 `git status --porcelain=v1` | 57 项；SHA-256 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` | 2026-08-10 |
| 原工作区 `codegraph status` | PASS；155 files / 2,665 nodes / 7,360 edges，索引最新 | 2026-08-10 |
| 新 worktree `codegraph status` | PASS；155 files / 2,611 nodes / 7,127 edges，索引最新 | 2026-08-10 |
| `pnpm install --frozen-lockfile` | PASS；212 个包，lockfile 未修改 | 2026-08-10 |
| `pnpm check` | PASS | 2026-08-10 |
| `pnpm build` | PASS | 2026-08-10 |
| `pnpm test` | BASELINE FAIL；50/51 test files、247/252 tests 通过；5 个 AppServer Fake 时序超时 | 2026-08-10 |
| Codex/AppServer 可发现性 | PASS；CLI `0.147.0-alpha.6.5`，默认 binary 存在且运行中进程可见 | 2026-08-10 |
| M1-01 `pnpm check` | PASS | 2026-08-10 |
| M1-01 `pnpm build` | PASS | 2026-08-10 |

## Risks and Blockers

| ID | Impact | Mitigation | Owner |
|---|---|---|---|
| R-M0-01 原工作区含 57 项用户修改 | 极高：误操作会覆盖用户工作 | 所有业务开发只在 sibling worktree；每次 M0 关键写操作后复核状态指纹 | Codex |
| R-M0-02 v0.x AppServer Fake 有 5 个时序超时 | 中：全量基线非绿色 | M2-01 重建异步 `open` Fake 并修复根因；不扩大超时 | Codex |
| R-EXT-01 真实渠道、Router 与 Apple 凭据尚未提供 | 后续真实 E2E、24 小时 Gate、签名发布将阻塞 | 先完成全部 Fake/Contract/Integration、本地安装和无需凭据的工作，届时集中请求最小输入 | User |

## Decisions

| ADR / Decision | Reason |
|---|---|
| 以 `52839e76ddef083fd9af314207e5576998801b76` 创建 `codex/vnext` | 避免把原始脏工作区的任何非 vNext 修改带入新分支 |
| 新 worktree 使用 `/Volumes/13759427003/AI/qq-codex-bridge-vnext` | 计划推荐路径不存在，满足 sibling 隔离要求 |
| 代码理解和现有 Symbol 影响分析仅使用 CodeGraph | 用户明确要求后续不再使用 GitNexus；新 worktree CodeGraph 已初始化且索引最新 |
