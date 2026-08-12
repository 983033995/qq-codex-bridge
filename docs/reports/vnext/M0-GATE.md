# vNext M0 Gate 报告

日期：2026-08-12

## 结论

M0 Gate 通过，允许进入 M1-01。M0 的目标是完成隔离、文档基线和工程证据；基线中的既有测试失败已记录，未通过修改 v0.x 代码掩盖。

## Gate 清单

| 项目 | 结果 | 证据 |
|---|---|---|
| 独立 worktree | PASS | `/Volumes/13759427003/AI/qq-codex-bridge-vnext-m0` |
| 分支和基线 Commit | PASS | `codex/vnext-m0` / `38aceb3df97537b84ea72429a35903efb709822c` |
| 三份权威文档 | PASS | `docs/PRODUCT-TECHNICAL-ARCHITECTURE-vNext.md`、`docs/VNEXT-IMPLEMENTATION-PLAN.md`、`docs/VNEXT-NEW-SESSION-HANDOFF.md` 已复制并校验 |
| 进度台账 | PASS | `docs/VNEXT-PROGRESS.md` |
| ADR 目录 | PASS | `docs/decisions/vnext/` |
| 依赖安装 | PASS | `pnpm install --frozen-lockfile`；212 个包，lockfile 未修改 |
| CodeGraph | PASS | 157 files / 2,685 nodes / 7,497 edges，索引最新 |
| TypeScript 检查 | PASS | `pnpm check` |
| 构建 | PASS | `pnpm build` |
| 测试基线 | RECORDED | 首次 52 files / 279 tests 通过；稳定性复跑出现 9 个既有 AppServer Fake 时序超时 |
| 原工作区保护 | PASS | 创建前后状态指纹均为 `24f2e07c42ebb31586989636f200dc2ee855202cce901ca69b2365f5fedbf50f` |

## 已知基线问题

`tests/unit/codex-app-server-driver.test.ts` 的 9 个测试等待 Fake AppServer 的连接/请求响应时超时，单文件复跑也复现。该问题与计划中记录的 AppServer Fake 时序基线一致。M0 不修改 v0.x 代码；M1-01/M1 Gate 负责建立可复用 Fake AppServer 并修复其连接时序。

## 外部环境限制

- `codex app-server daemon version` 因本机没有 `/Users/zhangheteng/.codex/app-server-control/app-server-control.sock` 而失败。
- 直接访问 `127.0.0.1:9341/json/version` 被当前执行环境的本机网络审批策略拒绝，因此只记录桌面进程参数和 CLI 能力，不宣称 CDP HTTP 已完成探测。
- 真实微信、飞书、QQ、Router、Apple 签名和 Notarization 仍属于后续外部 Gate。

## 下一步

进入 M1-01：在本 worktree 建立 vNext App、Application、Domain、Ports 和基础设施包结构；不改变现有 v0.x 运行路径。
