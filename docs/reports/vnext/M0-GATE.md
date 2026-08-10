# M0 Gate Report

> 日期：2026-08-10  
> 分支：`codex/vnext`  
> Worktree：`/Volumes/13759427003/AI/qq-codex-bridge-vnext`

## 结论

M0 Gate 通过。隔离 worktree、文档基线、工程基线与执行台账均已建立；原始工作区状态在 M0 写操作前后保持一致。旧 v0.x 全量测试存在 5 个已记录的 Fake AppServer WebSocket 时序超时，不阻塞 M0，但必须在 M2-01 重建 Fake AppServer 时修复根因。

## 实际完成

- 从原始仓库 `HEAD` `52839e76ddef083fd9af314207e5576998801b76` 创建 sibling worktree 和 `codex/vnext` 分支。
- 逐字复制三份 vNext 权威文档，并通过 SHA-256 逐文件核对。
- 创建 `docs/VNEXT-PROGRESS.md`，文档基线提交为 `5305b9d`。
- 初始化新 worktree 的 CodeGraph 索引；后续仅使用 CodeGraph 做代码定位和上游影响分析。
- 建立 `docs/decisions/vnext/`。
- 安装锁文件依赖并捕获环境、类型检查、测试和构建基线。

## 验证结果

| 检查 | 结果 |
|---|---|
| 原工作区状态保护 | PASS；写操作前后均为 57 项，SHA-256 均为 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` |
| 文档复制一致性 | PASS；三份源/目标文档 SHA-256 分别一致 |
| `pnpm install --frozen-lockfile` | PASS；212 个包，未修改 lockfile |
| `pnpm check` | PASS |
| `pnpm build` | PASS |
| `pnpm test` | BASELINE FAIL；50/51 test files 通过，247/252 tests 通过；5 个失败均为 `tests/unit/codex-app-server-driver.test.ts` 的 5000ms 超时 |
| CodeGraph | PASS；155 files / 2,611 nodes / 7,127 edges，索引最新 |
| Codex/AppServer 可发现性 | PASS；Codex CLI 位于 `/Applications/ChatGPT.app/Contents/Resources/codex`，版本 `0.147.0-alpha.6.5`，运行中进程可见 |

## M0 Gate Checklist

- [x] 独立 worktree 可用。
- [x] 三份文档和进度台账已进入 vNext 分支。
- [x] 原始工作区未受影响。
- [x] 工程基线已记录。
- [x] 后续任务路径明确：进入 M1-01。

## 风险与阻塞

- v0.x Fake AppServer 在监听器注册前同步触发 `open`，造成 5 个测试超时；计划在 M2-01 以异步 `open` 的新 Fake 根治，不通过扩大超时处理。
- 真实微信、飞书、QQ、Router 和 Apple 凭据尚未提供；当前不阻塞 M1～M3 和全部 Fake/Contract/Integration 工作。
- 未执行任何真实渠道消息、远程写操作、Push 或发布操作。
