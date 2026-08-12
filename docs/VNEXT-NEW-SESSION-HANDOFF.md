# vNext 新会话交接说明

将“可复制交接指令”完整发送到一个以当前仓库为工作区的新 Codex 会话中。新会话应自行读取完整文档，不需要重新进行产品方向讨论。

---

## 当前状态

- 已完成全仓产品、架构、数据流、线程和管理台审查；
- 已制定不兼容 v0.x 的完整目标架构；
- 已制定可执行开发计划；
- 尚未开始 vNext 业务代码开发；
- 原始工作区存在大量用户未提交修改，必须保护；
- 本轮只新增 vNext 文档。

权威文档：

```text
/Volumes/13759427003/AI/qq-codex-bridge/docs/PRODUCT-TECHNICAL-ARCHITECTURE-vNext.md
/Volumes/13759427003/AI/qq-codex-bridge/docs/VNEXT-IMPLEMENTATION-PLAN.md
/Volumes/13759427003/AI/qq-codex-bridge/docs/VNEXT-NEW-SESSION-HANDOFF.md
```

---

## 可复制交接指令

```text
你现在接手 qq-codex-bridge vNext 的完整开发工作。请持续自主推进开发、测试、文档、进度更新和验收，直到 macOS vNext Release Gate 全部满足；不要在完成一个小步骤后停下来等待我安排下一步。

仓库：
/Volumes/13759427003/AI/qq-codex-bridge

开始前必须完整阅读：
1. 项目当前生效的 AGENTS.md 指令；
2. docs/PRODUCT-TECHNICAL-ARCHITECTURE-vNext.md；
3. docs/VNEXT-IMPLEMENTATION-PLAN.md；
4. docs/VNEXT-NEW-SESSION-HANDOFF.md。

目标和授权：
- 按目标架构开发不兼容 v0.x 的 vNext；
- macOS 优先，微信、飞书优先，QQ 次之，Windows 最后；
- 你可以自主新增、修改、删除 vNext 分支中的代码、测试和文档；
- 你可以创建隔离分支/worktree、安装必要依赖、运行测试、构建和本地服务；
- 你可以按里程碑创建本地 Commit；
- 不得 Push、发 PR、修改远程系统、删除原始工作区或向真实联系人主动发消息，除非我另行授权。

最重要的工作区保护：
- 当前原始仓库有大量属于用户的未提交修改；
- 不要 reset、clean、checkout 或覆盖它们；
- 第一项工作必须按计划创建 sibling worktree 和 codex/vnext 分支；
- 后续业务开发只在新 worktree 中进行；
- 将三份 vNext 文档复制到新 worktree 并建立文档基线；
- 如果目标路径已存在，先检查，不得覆盖。

执行方式：
- 先建立 docs/VNEXT-PROGRESS.md；
- 从 M0 开始严格按 VNEXT-IMPLEMENTATION-PLAN.md 顺序推进；
- 每个任务先使用 CodeGraph 理解和做影响分析；
- 修改现有 Symbol 前必须完成上游影响分析；
- 采用小步实现、精确测试、模块测试、全量验证；
- 每个里程碑结束更新进度台账、运行全量测试并形成 Gate 报告；
- 持续工具工作时保持用户可见进度更新；
- 测试失败要修根因，不允许 skip、弱化断言或用任意超时掩盖；
- 不把未执行的真实渠道测试描述为已通过。

自主决策：
- 普通实现细节由你决定，不要频繁询问；
- 遇到非阻塞问题，记录后继续推进其他独立任务；
- 只有真实微信扫码、飞书/QQ/Router 凭据、真实外部消息、Apple 签名发布、破坏性数据操作或冻结架构冲突需要我介入；
- 需要我介入时，先完成所有不依赖该输入的工作，并一次性给出最小输入清单。

冻结产品决策：
- 每个 IM Conversation Space 默认创建并独占一个 Codex Thread；
- 不同线程并行，同一线程严格串行；
- AppServer 是主链路，CDP 仅作提交前 Recovery；
- AI 只识别意图，不直接执行；
- 高风险动作始终确认；
- 配置使用 config.json，密钥使用 macOS Keychain，运行数据使用 SQLite；
- 不保留 ChatGPT Provider、旧 .env、旧命令、旧线程引用或旧数据库兼容。

第一轮请直接完成：
1. 阅读所有权威文档；
2. 检查 Git 和工具状态；
3. 创建安全的隔离 worktree/分支；
4. 复制并提交文档基线；
5. 建立 VNEXT-PROGRESS.md；
6. 运行并记录工程基线；
7. 开始 M1，不要只输出计划复述。

macOS Release Gate 达成前，目标保持进行中。每次汇报都要包含：实际完成、验证结果、风险/阻塞、下一任务。
```

---

## 预计需要用户参与的节点

执行会话应尽量集中请求，避免零散打扰：

1. 微信真实账号扫码和专用测试聊天；
2. 飞书测试应用的 App ID、Secret 和测试会话；
3. QQ 测试 Bot 凭据；
4. 自定义 Router 的测试 Endpoint、Model 和 API Key；
5. Apple Developer 签名与 Notarization 凭据；
6. 是否允许 Push/PR/正式发布。

在这些输入到位前，Fake、Contract、Integration、管理台和本地安装工作仍应继续完成。

---

## 新会话首次验收

新会话完成第一轮后应能提供：

- 隔离 worktree 的绝对路径；
- `codex/vnext` 分支和基线 Commit；
- 原始工作区未变化的证据；
- `VNEXT-PROGRESS.md`；
- 基线 `check/test/build` 结果；
- M1 当前任务和下一步。
