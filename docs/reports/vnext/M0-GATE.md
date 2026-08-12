# vNext M0 Gate 报告

日期：2026-08-12

## 结论

M0 Gate 通过，允许进入 M1-01。隔离 worktree、文档基线、工程证据和执行台账均已建立；既有测试失败已记录，未通过修改 v0.x 代码掩盖。

## Gate 清单

| 项目 | 结果 | 证据 |
|---|---|---|
| 独立 worktree | PASS | `/Volumes/13759427003/AI/qq-codex-bridge-vnext-m0` |
| 分支和基线 Commit | PASS | `codex/vnext-m0` / `38aceb3df97537b84ea72429a35903efb709822c` |
| 三份权威文档 | PASS | `docs/PRODUCT-TECHNICAL-ARCHITECTURE-vNext.md`、`docs/VNEXT-IMPLEMENTATION-PLAN.md`、`docs/VNEXT-NEW-SESSION-HANDOFF.md` 已复制并核对 |
| 进度台账 | PASS | `docs/VNEXT-PROGRESS.md` |
| ADR 目录 | PASS | `docs/decisions/vnext/` |
| 依赖安装 | PASS | `pnpm install --frozen-lockfile`；212 个包，lockfile 未修改 |
| CodeGraph | PASS | 157 files / 2,685 nodes / 7,497 edges，索引最新 |
| TypeScript 检查 | PASS | `pnpm check` |
| 构建 | PASS | `pnpm build` |
| 测试基线 | RECORDED | 首次 52 files / 279 tests 通过；稳定性复跑出现 9 个既有 AppServer Fake 时序超时 |
| 原工作区保护 | PASS | 创建前后状态指纹均为 `24f2e07c42ebb31586989636f200dc2ee855202cce901ca69b2365f5fedbf50f` |

## 已知基线问题

`tests/unit/codex-app-server-driver.test.ts` 的 9 个测试等待 Fake AppServer 的连接/请求响应时超时，单文件复跑也复现。M0 不修改 v0.x 代码；后续 M2-01 的可复用 Fake AppServer 已修复这类连接时序问题，并在 M1/M2 Gate 记录全量验证证据。

## 外部环境限制

- `codex app-server daemon version` 因本机没有 `/Users/zhangheteng/.codex/app-server-control/app-server-control.sock` 而失败。
- 直接访问 `127.0.0.1:9341/json/version` 被当前执行环境的本机网络策略拒绝，因此只记录桌面进程参数和 CLI 能力，不宣称 CDP HTTP 探测完成。
- 真实微信、飞书、QQ、Router、Apple 签名和 Notarization 仍属于后续外部 Gate。

## 后续里程碑证据

M1–M4 的实现、Gate、测试和 CodeGraph 影响复核记录见 `docs/VNEXT-PROGRESS.md` 及同目录各 Gate 报告。当前 M4-05 仍等待真实微信账号 Gate 授权，不把真实渠道测试描述为已通过。
