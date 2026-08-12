# vNext Progress

## Snapshot

- Updated: 2026-08-12
- Branch / Worktree: `codex/vnext-m0` / `/Volumes/13759427003/AI/qq-codex-bridge-vnext-m0`
- Base commit: `38aceb3df97537b84ea72429a35903efb709822c`
- Current milestone: M1-01 — vNext 包结构
- Overall status: on_track

## Completed

- [x] v0.2 改动已在原工作区完成审查、验证并本地整理提交：`38aceb3 feat: complete v0.2 bridge refinements`。
- [x] 原工作区既有未提交修改保持原样，未被清理或复制到本 worktree。
- [x] 新建 sibling worktree：`/Volumes/13759427003/AI/qq-codex-bridge-vnext-m0`。
- [x] 创建分支：`codex/vnext-m0`。
- [x] 复制并核对三份 vNext 权威文档。
- [x] 建立本进度台账和 `docs/decisions/vnext/` 目录。

## In Progress

- 当前无进行中的 M0 实现项；M0 Gate 已完成，下一步进入 M1-01。

## Next

- [ ] M1-01 — 建立 vNext 包结构。

## Verification

| Command / Check | Result | Date |
|---|---|---|
| `git worktree add -b codex/vnext-m0 ... 38aceb3` | PASS；新 worktree 创建成功 | 2026-08-12 |
| 三份 vNext 权威文档 | PASS；已复制并完成 SHA-256 核对 | 2026-08-12 |
| 原工作区状态指纹 | PASS；创建 worktree 前后保持 `24f2e07c42ebb31586989636f200dc2ee855202cce901ca69b2365f5fedbf50f` | 2026-08-12 |
| Node / pnpm / macOS | Node `v22.23.0` / pnpm `10.27.0` / macOS `26.5.2` | 2026-08-12 |
| Codex CLI | `0.147.0-alpha.6.5` | 2026-08-12 |
| `pnpm install --frozen-lockfile` | PASS；212 个包，lockfile 未修改 | 2026-08-12 |
| 新 worktree CodeGraph | PASS；157 files / 2,685 nodes / 7,497 edges，索引最新 | 2026-08-12 |
| `pnpm check` | PASS | 2026-08-12 |
| `pnpm build` | PASS | 2026-08-12 |
| `pnpm test` 首次基线 | PASS；52 files / 279 tests | 2026-08-12 |
| `pnpm test` 稳定性复跑 | BASELINE FAIL；52 files，270/279 tests 通过；`tests/unit/codex-app-server-driver.test.ts` 9 个 Fake AppServer 时序测试超时 | 2026-08-12 |
| 单文件复跑 | BASELINE FAIL；该文件 11 tests 中 2 通过、9 超时 | 2026-08-12 |
| AppServer CLI 能力 | PASS；`codex app-server --help` 提供 stdio/ws/unix transport 与 daemon 管理命令 | 2026-08-12 |
| 运行中桌面进程 | PASS；检测到 ChatGPT/Codex 进程，ChatGPT 使用 `127.0.0.1:9341` remote debugging 参数 | 2026-08-12 |
| `codex app-server daemon version` | BLOCKED；本机无受管 daemon control socket，未宣称 daemon 已可连接 | 2026-08-12 |
| 直接 CDP HTTP 探测 | BLOCKED；当前执行环境拒绝该本机网络探测请求 | 2026-08-12 |
| `git diff --check` | PASS | 2026-08-12 |

## Risks and Blockers

| ID | Impact | Mitigation | Owner |
|---|---|---|---|
| R-M0-01 | 极高：原工作区仍有用户未提交修改，误操作可能覆盖 | 所有 vNext 工作只在本 worktree；每次关键操作后复核原工作区状态指纹 | Codex |
| R-M0-02 | 推荐路径 `/Volumes/13759427003/AI/qq-codex-bridge-vnext` 已有另一条推进中的 `codex/vnext` 工作树 | 使用独立路径 `/Volumes/13759427003/AI/qq-codex-bridge-vnext-m0`，不修改现有工作树 | Codex |
| R-M0-03 | 当前 vNext 是从已整理的 v0.2 提交启动，需确认 legacy 基线行为保持 | 先运行完整 check/test/build；不为了绿色基线修改 legacy 代码 | Codex |
| R-M0-04 | v0.2 AppServer Fake 测试基线不稳定，当前 9 个时序用例超时 | 在 M1-01/M1 Gate 重新处理 Fake 连接 `open` 时序；M0 不跳过、不放宽断言、不改 legacy 实现 | Codex |

## Architecture Decisions

- v0.2 改动先形成独立本地提交，再从该提交创建 vNext M0 worktree，保证新架构基线可追溯且不混入原始脏工作区。
- 已存在的 `/Volumes/13759427003/AI/qq-codex-bridge-vnext` 是独立进行中的 vNext 工作，不覆盖、不复用、不改写。
- 本 worktree 只承载 vNext M0 及其后续开发；未经授权不 push、发 PR、联系真实外部用户或执行正式发布。

## Latest Update

M0 Gate 已完成，下一步进入 M1-01。
