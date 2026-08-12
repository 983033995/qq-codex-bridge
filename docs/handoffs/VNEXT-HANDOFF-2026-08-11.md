# vNext Handoff — 2026-08-11

## 当前状态

- 工作树：`/Volumes/13759427003/AI/qq-codex-bridge-vnext`
- 分支：`codex/vnext`
- M4-03 Fake Gate 已完成；M4-04 已完成限流、认证失效、媒体失败与 Worker 隔离的主体，尚未完成应用级入站 ACK 和可恢复出站 Delivery 重试调度。
- 禁止 Push/PR/真实外部消息；允许本地提交。代码理解仅使用 CodeGraph，不使用 GitNexus；编辑使用 `apply_patch`。

## 本次完成

- 微信文本与语音转写入站、Context Token、出站文本和稳定 `client_id`。
- 图片/文件/语音/视频入站 CDN 下载、AES-128-ECB 解密、安全缓存、大小/校验与降级。
- 图片/文件/视频出站上传；音频按可播放文件发送。
- Codex `mediaReferences` 本地文件回传；HTTP/Data URI 明确拒绝。
- 1800 Unicode code point 长文本稳定分段。
- Worker IPC v2 附件 Schema、独立 Delivery Result、超时 Pending Map、多账户隔离。
- SQLite 入站去重、Delivery 状态持久化、认证错误映射。
- 轮询指数退避、`Retry-After`、401/403 置登录 `invalid` 并停止重试。
- 修复旧 E2E 读取宿主机真实飞书/微信环境变量导致的不确定失败。

## 下一步（按顺序）

1. 为 `message.inbound` 增加 Daemon→Worker 应用级 ACK；只有 SQLite `ReceiveInboundMessage` 已落账或确认重复后才推进 Cursor。注意当前 Supervisor 的异步 handler 不能作为 ACK。
2. 为 `DeliveryRepository` 增加可恢复扫描，执行 `retry_wait → sending → delivered/failed`；使用原 `deliveryKey` 与分段键，限制尝试次数并采用有界指数退避。
3. 覆盖 Daemon/Worker 在 ACK 前后崩溃、重启恢复、429、5xx、单媒体失败、认证失效的 Fake iLink 故障矩阵。
4. 完成 M4-04 后更新 `docs/VNEXT-PROGRESS.md` 并本地提交。
5. M4-05 需要用户真实微信扫码与专用测试 Space；执行文本、图片、文件、语音、重启恢复和 24 小时运行。不得主动联系真实联系人。

## 已知外部阻塞

- 真实微信扫码/测试联系人或群聊授权。
- 飞书、QQ、Router 真实凭据。
- Apple Developer ID、签名与 Notarization 凭据。

## 验收命令

```bash
pnpm check
pnpm test
pnpm build
git diff --check
codegraph sync .
```

最后一次完整结果：84 test files / 426 tests PASS；`pnpm check`、生产构建、`git diff --check` 与 CodeGraph 同步均 PASS。原工作区仍为 57 项，保护指纹已复核为：`55b004726404ce5b08d61ced56c56294439e4a4721e3c5b1b2ec5d21c89b5649`。
