# M2 Gate Report

> 日期：2026-08-10
> 分支：`codex/vnext`
> Worktree：`/Volumes/13759427003/AI/qq-codex-bridge-vnext`

## 结论

M2 Gate 通过。Fake AppServer、真实 AppServer Adapter、Thread Coordinator、有界调度器、CDP Recovery 边界和真实 Codex Smoke 均满足计划要求。最终真实 run `m2-06-20260810-2035` 创建三个独立 Thread 并行返回各自唯一 marker，无跨线程串线；测试专属长 Turn 在 readiness probe 确认运行后被真实中断，completion 拒绝且 `thread/read` 状态为 `interrupted`。

真实 smoke 的前置失败揭示并修复了三个根因：陈旧 AppServer cwd 失效仍被发现、受管 listener 启动竞态，以及 `turn/interrupt` RPC 响应与真实终态不一致。没有跳过测试、弱化断言、自动重提已接受 Turn 或用固定等待冒充中断成功。

## 实际完成

- 建立确定性的 Fake AppServer，覆盖 Request/Response、Notification、乱序、重复、断线、超时和 Thread/Turn 操作。
- 实现独立 vNext AppServer Adapter：loopback endpoint、进程发现/受管启动、Request/Pending Turn Map、真实 ID 路由、回复/媒体归一化、重连、Dispose、Capability 与 Health。
- 跳过 cwd 已不存在的陈旧 macOS AppServer；受管实例只有在 loopback listener 就绪后才返回 endpoint，失败时终止自身创建的进程。
- 实现 Thread Coordinator 与有界 Thread Scheduler：新 Space 默认独占 Thread，同 Thread FIFO，不同 Thread 并行，队列上限、中断/取消、Unknown Turn 对账。
- 实现独立且降级可见的 CDP Recovery；只在明确提交前失败时进入，已接受 Turn 绝不重发。
- 实现真实 Codex Smoke runner，保留并列出测试 Thread；中断探针使用隔离临时目录，完成后清理。
- 修正中断语义：RPC 成功不等于中断成功；仅通知或状态明确为 `interrupted` 才拒绝 completion 并返回成功。

## 真实 Codex Smoke 证据

成功 run：`m2-06-20260810-2035`

| Label | Thread ID | Turn ID | Final Text |
|---|---|---|---|
| A | `019febab-9c8b-72f2-8810-2f2c755c5369` | `019febab-b620-7ef0-b09e-3addc636be09` | `VNEXT_SMOKE_m2_06_20260810_2035_A` |
| B | `019febab-9c8b-72f2-8810-2f4658adfc86` | `019febab-b620-7ef0-b09e-3ae4e8553b3c` | `VNEXT_SMOKE_m2_06_20260810_2035_B` |
| C | `019febab-9c8b-72f2-8810-2f63a59eea98` | `019febab-b61f-7f81-a2ed-2d04d5892be6` | `VNEXT_SMOKE_m2_06_20260810_2035_C` |
| Interrupt | `019febab-9c8b-72f2-8810-2f2c755c5369` | `019febab-d9ed-7dd2-82e4-554612f9503f` | completion rejected；status `interrupted` |

成功 run 前为定位真实竞态创建并保留了以下专用测试 Thread：

| Run | A / B / C Thread IDs |
|---|---|
| `m2-06-20260810-2020` | `019feb9e-1ccc-7003-aafe-ce8598c3f2ee` / `019feb9e-1ccc-7003-aafe-ce97164c37a6` / `019feb9e-1ccc-7003-aafe-cec45eebbbb4` |
| `m2-06-20260810-2022` | `019feba0-436b-77a2-8ee8-e272fa486aae` / `019feba0-436b-77a2-8ee8-e297d5c1a8bf` / `019feba0-436b-77a2-8ee8-e25edc1f916c` |
| `m2-06-20260810-2026` | `019feba3-f3cc-7162-bb31-d8bfea0fb865` / `019feba3-f3cc-7162-bb31-d8ada50d9459` / `019feba3-f3cc-7162-bb31-d89ccea710d2` |
| `m2-06-20260810-2030` | `019feba7-46c4-7ae0-b70e-59f8fde3f8a6` / `019feba7-46c4-7ae0-b70e-59ebc03ef3a3` / `019feba7-46c4-7ae0-b70e-59c475cb8e75` |

另保留了真实对照 Thread `vNext Smoke stderr probe`。未删除任何 Codex Thread，也未向真实联系人或外部渠道发送消息。

## 验证结果

| 检查 | 结果 |
|---|---|
| AppServer/Smoke 精确回归 | PASS；3 files / 16 tests |
| vNext Unit/Contract/Integration | PASS；18 files / 112 tests |
| 真实 Codex Smoke | PASS；3 个并行 marker 正确，中断终态确认，3 个成功 run Thread 均保留 |
| `pnpm check` | PASS |
| `pnpm test` | PASS；70 files / 369 tests |
| `pnpm build` | PASS |
| `git diff --check` | PASS |
| CodeGraph 同步与影响复核 | PASS；231 files / 4,057 nodes / 11,789 edges，索引最新 |
| 原工作区状态保护 | PASS；仍为 57 项；NUL 分隔状态 SHA-256 仍为 `55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649` |

## M2 Gate Checklist

- [x] Fake AppServer 全部时序场景通过。
- [x] A/B/C Thread 并行，回复不串线。
- [x] 同 Thread 严格 FIFO。
- [x] 提交后断线无重复提交。
- [x] Recovery 限制被测试锁定。
- [x] 真实 Codex Smoke Test 通过。

## 风险与阻塞

- AppServer WebSocket 传输仍为实验性；现有缓解包括本机精确 schema 核对、loopback 限制、Fake 故障矩阵、终态确认与提交前 CDP Recovery。
- 任务开始前已存在的陈旧 AppServer PID `22743` cwd 失效；本任务未终止或修改该非本任务进程，vNext 会安全跳过它。
- 真实微信、飞书、QQ、Router 与 Apple 凭据仍未提供；M2 不依赖这些输入，本报告未把任何真实渠道测试描述为通过。
