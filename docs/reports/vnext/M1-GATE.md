# M1 Gate Report

> 日期：2026-08-10  
> 分支：`codex/vnext`  
> Worktree：`/Volumes/13759427003/AI/qq-codex-bridge-vnext`

## 结论

M1 Gate 通过。Domain、Ports、配置、Keychain、SQLite、Application Use Cases 与 Fake A/B/C 系统验收均满足计划要求，最终 `check/test/build` 全绿。全量验证最初复现了 5 个旧 Fake AppServer `open` 时序超时；已通过让 Fake 在连接创建后异步触发 `open` 修复根因，没有扩大超时、跳过测试或弱化断言。

## 实际完成

- 建立 vNext App、Application、Adapter 与 Infrastructure 包边界。
- 实现 vNext Domain 聚合、不变量、状态机与稳定错误分类；Domain 不依赖 Adapter 或 App。
- 定义 Channel、Codex、Router、Config、Secret、Service、Repository Ports，并提供可复用 Contract Suite。
- 实现严格 `config.json`、Revision、原子写入与 Apply 回滚；实现 macOS Keychain Adapter。
- 实现独立 `runtime-vnext.db`、Migration、约束、Repository 与重启恢复。
- 实现七个核心 Application Use Case，以及默认独占新 Thread、同 Thread 串行、不同 Thread 并行。
- 使用真实 SQLite Adapter 与 Fake Codex 完成微信 A、飞书 B、QQ C 的系统级验收。
- 修复旧 Fake AppServer 在监听器注册前触发 `open` 的测试时序根因，使全量工程测试恢复绿色。

## 验证结果

| 检查 | 结果 |
|---|---|
| Domain 依赖边界 | PASS；`packages/domain/src/vnext/` 无 Adapter、App、Application、Config 或 Store import |
| Ports Contract Suite | PASS；Port 5/5、Config 1/1、SQLite Repository 8/8 |
| Config / Keychain 失败路径 | PASS；覆盖 Schema 拒绝、原子写失败、Apply 与 Secret 回滚、Keychain 命令失败 |
| SQLite 失败路径 | PASS；覆盖约束分类、事务/Migration 回滚、JSON/FK 失败与重启恢复 |
| Fake A/B/C Integration | PASS；1 file / 2 tests |
| Fake AppServer 精确回归 | PASS；1 file / 8 tests；原 5 个超时已消除 |
| `pnpm check` | PASS |
| `pnpm test` | PASS；61 files / 319 tests |
| `pnpm build` | PASS |
| `git diff --check` | PASS |
| 原工作区状态保护 | PASS；仍为 57 项，状态 SHA-256 仍为 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` |

## M1 Gate Checklist

- [x] Domain 无 Adapter/App 依赖。
- [x] Ports 有可复用 Contract Suite。
- [x] 配置、Keychain、SQLite 均有失败路径测试。
- [x] Fake A/B/C 场景通过。
- [x] `check/test/build` 全绿。

## 风险与阻塞

- M2-01 仍需把当前时序修复扩展为可复用 Fake AppServer，补齐乱序、重复、断线、超时、Thread 与 Turn 协议模拟；这不影响 M1 Gate 已满足，但在 M2-02 前必须完成。
- 真实微信、飞书、QQ、Router 与 Apple 凭据尚未提供；当前未执行任何真实渠道消息、签名或发布操作。
