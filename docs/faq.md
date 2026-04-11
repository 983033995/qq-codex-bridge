# FAQ 与故障排查

## 1. 为什么 QQ 发来的同一条消息会在 Codex 里重复出现？

常见原因：

- QQ gateway 对同一正文进行了多次派发，但 `messageId` 不同
- 桥接早期版本只按 `messageId` 去重，无法拦住“正文相同、ID 不同”的重复事件

当前项目已经加入短窗口正文去重：

- 同一会话
- 同一发送者
- 同一聊天类型
- 正文相同
- 媒体指纹相同
- 且在短时间窗口内重复到达

这类消息会被抑制，不再再次注入 Codex。

---

## 2. 为什么 QQ 最多只收到前几条，后面的图片或文件结果丢了？

常见原因：

- 任务执行时间较长，桥接过早结束了这一轮回复采集
- 某一条 draft 发送失败后，旧逻辑提前中断了整轮后续消息

当前项目已经做了两层改进：

- 延长长耗时任务的总轮询窗口
- 单条 draft 发送失败只记日志，不再中断整轮会话

如果仍然偶发丢失，优先检查：

- Codex Desktop 当前线程是否仍显示为“处理中 / 搜索中 / reconnecting”
- `delivery_jobs` 是否已经落库
- 终端是否出现 `draft delivery failed`

---

## 3. 为什么 QQ 上的代码块显示不像 Codex 里那样漂亮？

原因不是单一的：

- Codex Desktop 的富文本结构和 QQ 的 Markdown 子集渲染能力不同
- QQ 客户端对复杂 Markdown 的支持有限，尤其是代码块、表格、长文本分块

当前项目已经尽量做到：

- 从 Codex 页面中提取代码块结构
- 序列化成 fenced markdown
- 发送前做 Markdown-aware 分块

但 QQ 侧仍然不保证 1:1 复刻 Codex 的深色代码卡片。

---

## 4. 为什么 `/tu 2` 会提示找不到线程？

常见原因：

- 线程列表已经过期
- Codex Desktop 侧边栏分组状态变化
- 当前 UI 里对应线程已不在可见列表中

建议顺序：

1. 先发送 `/t`
2. 确认最新线程列表
3. 再执行 `/tu <序号>`

---

## 5. 为什么 QQ 发来的语音有时只显示附件，没有转写文本？

项目支持的优先级通常是：

1. 本地或云端 STT
2. QQ 自带 `asr_refer_text`
3. 附件占位回退

请检查：

- `.env` 里的 STT 配置是否启用
- 本地 `whisper.cpp` 是否可执行
- 是否拿到了 `voice_wav_url`
- 终端里是否有：
  - `qq stt started`
  - `qq stt completed`
  - `qq stt fallback used`
  - `qq stt failed`

---

## 6. 为什么 Codex 输入框里出现了文字，但没有真正发送？

这通常和 Codex Desktop 当前 UI 的输入框状态有关：

- `contenteditable` composer 已聚焦，但提交动作没有真正生效
- 按钮状态没有变化
- 输入框没有清空

当前桥接已经加入：

- 更稳的 composer 定位
- 发送按钮就近匹配
- 发送后状态确认
- `Enter` 补提交流程

如果仍然失败，请附上终端日志中的：

- `submit_failed`
- `CDP runtime evaluation failed`
- `Codex desktop reply did not arrive before timeout`

---

## 7. 为什么启动后提示 `thread_not_found` 或 `reply_timeout`？

### `thread_not_found`

通常表示：

- 当前侧边栏里没有找到目标线程
- `/t` 列表与切换时看到的 UI 状态已经不一致

处理建议：

- 先 `/t`
- 再 `/tu`

### `reply_timeout`

通常表示：

- 本轮回复在窗口期内没有稳定收口
- 可能仍在长时间工具执行

当前版本已经把这类问题视为更偏“可恢复错误”，不会轻易打坏整个会话。

---

## 8. 提交到 GitHub 前，如何检查是否有敏感信息？

建议最少做三件事：

1. 不提交 `.env`
2. 扫描仓库里的绝对路径和 token 模式
3. 再跑一遍 `pnpm run check && pnpm test`

可参考命令：

```bash
rg -n --hidden \
  --glob '!node_modules' \
  --glob '!.git' \
  --glob '!dist' \
  --glob '!.env' \
  '/Volumes/13759427003|/Users/yourname|ghp_|github_pat_|sk-' .
```

