---
name: qq-codex-thread-management
description: 管理 QQ 私聊与 Codex Desktop 真实线程的绑定。适用于查看最近线程、查看当前绑定、切换线程、新建线程、fork 最近几轮 QQ 对话到新线程等场景。
metadata: {"codex":{"emoji":"🧵","repo":"qq-codex-bridge"}}
---

# QQ Codex 线程管理

## 何时使用

当用户希望在 QQ 私聊里管理 Codex Desktop 左侧真实会话时使用本技能，包括：

- 查看最近线程列表
- 查看当前 QQ 私聊绑定到了哪个 Codex 线程
- 切换到另一个已有线程
- 新建一个线程并切换
- 把当前 QQ 私聊最近几轮对话 fork 到一个新线程

## 前提条件

在执行线程管理前，先确认桥接正在运行：

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
pnpm dev
```

启动成功时应出现类似日志：

```text
[qq-codex-bridge] codex desktop ready { launched: false, remoteDebuggingPort: 9229 }
[qq-codex-bridge] ready { transport: 'qq-gateway-websocket', accountKey: 'qqbot:default' }
```

## QQ 私聊命令

这些命令仅在 **QQ 私聊** 中生效，群聊不会执行线程管理。

### 查看最近 20 条线程

```text
/threads
```

### 查看当前绑定线程

```text
/thread current
```

### 切换到某个线程

先发送 `/threads`，再根据序号切换：

```text
/thread use 3
```

### 新建线程

```text
/thread new 报销流程优化
```

效果：
- 在 Codex Desktop 中创建真实新线程
- 将该 QQ 私聊绑定到这个新线程
- 用标题建立首条种子上下文

### fork 最近几轮 QQ 对话到新线程

```text
/thread fork 报销流程优化-拆分
```

效果：
- 在 Codex Desktop 中创建真实新线程
- 将当前 QQ 私聊最近几轮对话摘要写入新线程首条上下文
- 将该 QQ 私聊绑定到这个新线程

## 验证方法

### 在 QQ 中验证

按顺序执行：

1. `/threads`
2. `/thread current`
3. `/thread use 1`
4. 发送一条普通消息，确认落到切换后的线程

### 在本地数据库中验证

查看会话绑定：

```bash
sqlite3 /Volumes/13759427003/AI/qq-codex-bridge/runtime/qq-codex-bridge.sqlite \
  "select session_key, codex_thread_ref, status from bridge_sessions;"
```

预期：
- `codex_thread_ref` 为 `codex-thread:` 开头，而不是旧的 `cdp-target:`

## 排障

### `/threads` 没有返回

先检查：

- bridge 是否还在运行
- QQ 私聊消息是否真正进入 bot
- 当前回复是否使用了真实 `msg_id`

### `/thread use` 后消息仍发到旧线程

先执行：

```text
/thread current
```

如果返回的线程不对，再查看数据库绑定并确认是否已更新。

### 群聊里命令没反应

这是设计如此。线程管理只支持 QQ 私聊。
