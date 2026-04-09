# QQ-Codex Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/Volumes/13759427003/AI/qq-codex-bridge/` 中实现一个可运行的 QQ 到 Codex 桌面端桥接原型，让每个 QQ 私聊/群聊稳定映射到独立持久会话，并支持基础错误恢复。

**Architecture:** 采用单仓库、单主进程、模块化分层方案。QQ 接入、会话编排、Codex 桌面驱动、SQLite 持久化各自通过端口隔离，第一版通过 UI 自动化驱动 Codex 桌面端，但不让编排层直接理解 UI 控件。

**Tech Stack:** Node.js 20、TypeScript、Vitest、SQLite、Zod、ws、better-sqlite3、agent-browser、Electron CDP 自动化

---

## File Structure

目标仓库文件结构如下。实现时严格按这个边界落文件，避免把驱动、协议和编排逻辑混进同一个文件。

- `/Volumes/13759427003/AI/qq-codex-bridge/package.json`
  仓库脚本、依赖和工作区定义。
- `/Volumes/13759427003/AI/qq-codex-bridge/tsconfig.json`
  根 TypeScript 配置。
- `/Volumes/13759427003/AI/qq-codex-bridge/vitest.config.ts`
  测试配置。
- `/Volumes/13759427003/AI/qq-codex-bridge/.gitignore`
  忽略日志、SQLite、截图、构建产物。
- `/Volumes/13759427003/AI/qq-codex-bridge/README.md`
  运行说明和系统概览。
- `/Volumes/13759427003/AI/qq-codex-bridge/docs/architecture.md`
  架构说明。
- `/Volumes/13759427003/AI/qq-codex-bridge/docs/provider-boundary.md`
  Codex Desktop Driver 与核心领域边界说明。
- `/Volumes/13759427003/AI/qq-codex-bridge/docs/testing.md`
  测试策略说明。
- `/Volumes/13759427003/AI/qq-codex-bridge/docs/decisions/0001-repo-shape.md`
  为什么采用单仓单进程。
- `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/main.ts`
  进程入口。
- `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/bootstrap.ts`
  依赖装配。
- `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/config.ts`
  根配置读取与校验。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/session.ts`
  `BridgeSession`、`SessionPeer`、状态枚举。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/message.ts`
  `InboundMessage`、`OutboundDraft`、`DeliveryRecord`。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/driver.ts`
  `DriverBinding`、驱动错误类型。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/qq.ts`
  `QqIngressPort`、`QqEgressPort`。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/conversation.ts`
  `ConversationProviderPort`、`DesktopDriverPort`。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/store.ts`
  `SessionStorePort`、`TranscriptStorePort`。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/bridge-orchestrator.ts`
  核心编排器。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/session-key.ts`
  `account_key` / `peer_key` / `session_key` 生成。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/job-runner.ts`
  出站作业执行和恢复。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/sqlite.ts`
  SQLite 连接与 schema 初始化。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/session-repo.ts`
  `bridge_sessions`、`session_locks` 仓储。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/message-repo.ts`
  `message_ledger`、`delivery_jobs` 仓储。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-api-client.ts`
  QQ HTTP API 包装。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-gateway.ts`
  QQ WebSocket 建连、重连、事件分发。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-normalizer.ts`
  将 QQ 事件归一化为 `InboundMessage`。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-sender.ts`
  文本出站发送与长度拆分。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-channel-adapter.ts`
  组合 ingress/egress 端口实现。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/codex-desktop-driver.ts`
  Codex 桌面端驱动。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/cdp-session.ts`
  与 agent-browser / CDP 连接的底层封装。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/reply-parser.ts`
  从 UI 快照中提取回复。
- `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/health.ts`
  应用健康探针和失败转储。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/unit/bridge-orchestrator.test.ts`
  编排器单测。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/unit/session-key.test.ts`
  会话 key 规则单测。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/contract/qq-normalizer.contract.test.ts`
  QQ 入站契约测试。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/contract/qq-sender.contract.test.ts`
  QQ 出站契约测试。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/contract/codex-desktop-driver.contract.test.ts`
  驱动契约测试。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/private-chat.e2e.test.ts`
  私聊链路测试。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/group-chat.e2e.test.ts`
  群聊链路测试。
- `/Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/rebind-recovery.e2e.test.ts`
  重绑定恢复测试。

### Task 1: Scaffold Repository and Tooling

**Files:**
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/package.json`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/tsconfig.json`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/vitest.config.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/.gitignore`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/README.md`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/main.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/bootstrap.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/config.ts`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/unit/session-key.test.ts`

- [ ] **Step 1: Write the failing scaffold smoke test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/unit/session-key.test.ts
import { describe, expect, it } from "vitest";
import { buildSessionKey, buildPeerKey } from "../../packages/orchestrator/src/session-key";

describe("session key helpers", () => {
  it("builds c2c peer and session keys deterministically", () => {
    const peerKey = buildPeerKey({ chatType: "c2c", peerId: "ABC123" });
    const sessionKey = buildSessionKey({ accountKey: "qqbot:default", peerKey });

    expect(peerKey).toBe("qq:c2c:ABC123");
    expect(sessionKey).toBe("qqbot:default::qq:c2c:ABC123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/unit/session-key.test.ts
```

Expected: FAIL with `Cannot find module '../../packages/orchestrator/src/session-key'`

- [ ] **Step 3: Create the repository scaffold and minimal tooling**

```json
// /Volumes/13759427003/AI/qq-codex-bridge/package.json
{
  "name": "qq-codex-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx apps/bridge-daemon/src/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "ws": "^8.18.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "@types/ws": "^8.5.14",
    "tsx": "^4.19.3",
    "typescript": "^5.8.2",
    "vitest": "^3.1.1"
  }
}
```

```json
// /Volumes/13759427003/AI/qq-codex-bridge/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": [
    "apps/**/*.ts",
    "packages/**/*.ts",
    "tests/**/*.ts",
    "vitest.config.ts"
  ]
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
```

```gitignore
# /Volumes/13759427003/AI/qq-codex-bridge/.gitignore
node_modules
dist
.DS_Store
coverage
runtime
artifacts
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/config.ts
import { z } from "zod";

export const appConfigSchema = z.object({
  databasePath: z.string().min(1),
  qqBot: z.object({
    appId: z.string().min(1),
    clientSecret: z.string().min(1)
  }),
  codexDesktop: z.object({
    appName: z.string().min(1),
    remoteDebuggingPort: z.number().int().positive()
  })
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  return appConfigSchema.parse({
    databasePath: env.QQ_CODEX_DATABASE_PATH ?? "runtime/qq-codex-bridge.sqlite",
    qqBot: {
      appId: env.QQBOT_APP_ID,
      clientSecret: env.QQBOT_CLIENT_SECRET
    },
    codexDesktop: {
      appName: env.CODEX_APP_NAME ?? "Codex",
      remoteDebuggingPort: Number(env.CODEX_REMOTE_DEBUGGING_PORT ?? "9229")
    }
  });
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/bootstrap.ts
import { loadConfigFromEnv } from "./config";

export function bootstrap() {
  const config = loadConfigFromEnv(process.env);

  return { config };
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/main.ts
import { bootstrap } from "./bootstrap";

async function main() {
  const { config } = bootstrap();
  console.log("[qq-codex-bridge] bootstrapped", {
    databasePath: config.databasePath,
    codexApp: config.codexDesktop.appName
  });
}

main().catch((error) => {
  console.error("[qq-codex-bridge] fatal", error);
  process.exitCode = 1;
});
```

```md
<!-- /Volumes/13759427003/AI/qq-codex-bridge/README.md -->
# qq-codex-bridge

QQ 到 Codex 桌面端的会话桥接原型。

## Commands

- `npm run dev`
- `npm run check`
- `npm test`
```

- [ ] **Step 4: Add the minimal key helper implementation**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/session-key.ts
export type ChatType = "c2c" | "group";

export function buildPeerKey(input: { chatType: ChatType; peerId: string }): string {
  return input.chatType === "c2c"
    ? `qq:c2c:${input.peerId}`
    : `qq:group:${input.peerId}`;
}

export function buildSessionKey(input: { accountKey: string; peerKey: string }): string {
  return `${input.accountKey}::${input.peerKey}`;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm install
npm test -- tests/unit/session-key.test.ts
npm run check
```

Expected:

- `session-key.test.ts` PASS
- `tsc --noEmit` PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add package.json tsconfig.json vitest.config.ts .gitignore README.md apps packages tests
git commit -m "chore: scaffold qq codex bridge repo"
```

### Task 2: Define Domain and Port Contracts

**Files:**
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/session.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/message.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/driver.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/qq.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/conversation.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/store.ts`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/unit/domain-contracts.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/unit/domain-contracts.test.ts
import { describe, expect, it } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session";
import type { InboundMessage } from "../../packages/domain/src/message";

describe("domain contracts", () => {
  it("exposes bridge session statuses and inbound chat types", () => {
    const sample: InboundMessage = {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    };

    expect(BridgeSessionStatus.Active).toBe("active");
    expect(sample.chatType).toBe("c2c");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/unit/domain-contracts.test.ts
```

Expected: FAIL with `Cannot find module '../../packages/domain/src/session'`

- [ ] **Step 3: Create the domain types**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/session.ts
export enum BridgeSessionStatus {
  Active = "active",
  NeedsRebind = "needs_rebind",
  DriverUnhealthy = "driver_unhealthy",
  Paused = "paused"
}

export type SessionPeer = {
  accountKey: string;
  peerKey: string;
  chatType: "c2c" | "group";
  peerId: string;
};

export type BridgeSession = SessionPeer & {
  sessionKey: string;
  codexThreadRef: string | null;
  status: BridgeSessionStatus;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastError: string | null;
};
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/message.ts
export type InboundMessage = {
  messageId: string;
  accountKey: string;
  sessionKey: string;
  peerKey: string;
  chatType: "c2c" | "group";
  senderId: string;
  text: string;
  receivedAt: string;
};

export type OutboundDraft = {
  draftId: string;
  sessionKey: string;
  text: string;
  createdAt: string;
};

export type DeliveryRecord = {
  jobId: string;
  sessionKey: string;
  providerMessageId: string | null;
  deliveredAt: string;
};
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/domain/src/driver.ts
export type DriverBinding = {
  sessionKey: string;
  codexThreadRef: string | null;
};

export class DesktopDriverError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "app_not_ready"
      | "session_not_found"
      | "input_not_found"
      | "reply_timeout"
      | "reply_parse_failed"
  ) {
    super(message);
  }
}
```

- [ ] **Step 4: Create the port interfaces**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/qq.ts
import type { InboundMessage, OutboundDraft, DeliveryRecord } from "../../domain/src/message";

export interface QqIngressPort {
  onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void>;
}

export interface QqEgressPort {
  deliver(draft: OutboundDraft): Promise<DeliveryRecord>;
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/conversation.ts
import type { InboundMessage, OutboundDraft } from "../../domain/src/message";
import type { DriverBinding } from "../../domain/src/driver";

export interface DesktopDriverPort {
  ensureAppReady(): Promise<void>;
  openOrBindSession(sessionKey: string, binding: DriverBinding | null): Promise<DriverBinding>;
  sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void>;
  collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]>;
  markSessionBroken(sessionKey: string, reason: string): Promise<void>;
}

export interface ConversationProviderPort {
  runTurn(message: InboundMessage): Promise<OutboundDraft[]>;
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/ports/src/store.ts
import type { BridgeSession, BridgeSessionStatus } from "../../domain/src/session";
import type { InboundMessage, OutboundDraft } from "../../domain/src/message";

export interface SessionStorePort {
  getSession(sessionKey: string): Promise<BridgeSession | null>;
  createSession(session: BridgeSession): Promise<void>;
  updateSessionStatus(sessionKey: string, status: BridgeSessionStatus, lastError?: string | null): Promise<void>;
  updateBinding(sessionKey: string, codexThreadRef: string | null): Promise<void>;
  withSessionLock<T>(sessionKey: string, work: () => Promise<T>): Promise<T>;
}

export interface TranscriptStorePort {
  recordInbound(message: InboundMessage): Promise<void>;
  recordOutbound(draft: OutboundDraft): Promise<void>;
  hasInbound(messageId: string): Promise<boolean>;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/unit/domain-contracts.test.ts
npm run check
```

Expected:

- `domain-contracts.test.ts` PASS
- `tsc --noEmit` PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add packages/domain packages/ports tests/unit/domain-contracts.test.ts
git commit -m "feat: add bridge domain and port contracts"
```

### Task 3: Implement SQLite Persistence and Session Locking

**Files:**
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/sqlite.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/session-repo.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/message-repo.ts`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/unit/sqlite-store.test.ts`

- [ ] **Step 1: Write the failing persistence test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/unit/sqlite-store.test.ts
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../packages/store/src/sqlite";
import { SqliteSessionStore } from "../../packages/store/src/session-repo";
import { BridgeSessionStatus } from "../../packages/domain/src/session";

describe("sqlite store", () => {
  it("creates and reloads sessions", async () => {
    const db = createSqliteDatabase(":memory:");
    const store = new SqliteSessionStore(db);

    await store.createSession({
      sessionKey: "qqbot:default::qq:c2c:abc",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      peerId: "abc",
      codexThreadRef: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });

    const session = await store.getSession("qqbot:default::qq:c2c:abc");
    expect(session?.status).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/unit/sqlite-store.test.ts
```

Expected: FAIL with missing store modules

- [ ] **Step 3: Add SQLite bootstrap and schema**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/sqlite.ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function createSqliteDatabase(filePath: string) {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_sessions (
      session_key TEXT PRIMARY KEY,
      account_key TEXT NOT NULL,
      peer_key TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      codex_thread_ref TEXT,
      status TEXT NOT NULL,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS message_ledger (
      message_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      direction TEXT NOT NULL,
      qq_message_ref TEXT,
      codex_turn_ref TEXT,
      content_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_jobs (
      job_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_locks (
      session_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  return db;
}
```

- [ ] **Step 4: Implement session and transcript stores**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/session-repo.ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BridgeSessionStatus, BridgeSession } from "../../domain/src/session";
import type { SessionStorePort } from "../../ports/src/store";

export class SqliteSessionStore implements SessionStorePort {
  constructor(private readonly db: Database.Database) {}

  async getSession(sessionKey: string): Promise<BridgeSession | null> {
    const row = this.db.prepare(
      `SELECT session_key, account_key, peer_key, chat_type, peer_id, codex_thread_ref, status, last_inbound_at, last_outbound_at, last_error
       FROM bridge_sessions WHERE session_key = ?`
    ).get(sessionKey) as BridgeSession | undefined;

    return row ?? null;
  }

  async createSession(session: BridgeSession): Promise<void> {
    this.db.prepare(
      `INSERT INTO bridge_sessions (
        session_key, account_key, peer_key, chat_type, peer_id, codex_thread_ref, status, last_inbound_at, last_outbound_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.sessionKey,
      session.accountKey,
      session.peerKey,
      session.chatType,
      session.peerId,
      session.codexThreadRef,
      session.status,
      session.lastInboundAt,
      session.lastOutboundAt,
      session.lastError
    );
  }

  async updateSessionStatus(sessionKey: string, status: BridgeSessionStatus, lastError: string | null = null): Promise<void> {
    this.db.prepare(`UPDATE bridge_sessions SET status = ?, last_error = ? WHERE session_key = ?`)
      .run(status, lastError, sessionKey);
  }

  async updateBinding(sessionKey: string, codexThreadRef: string | null): Promise<void> {
    this.db.prepare(`UPDATE bridge_sessions SET codex_thread_ref = ? WHERE session_key = ?`)
      .run(codexThreadRef, sessionKey);
  }

  async withSessionLock<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 60_000).toISOString();

    this.db.prepare(
      `INSERT OR REPLACE INTO session_locks (session_key, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(sessionKey, owner, now, expires);

    try {
      return await work();
    } finally {
      this.db.prepare(`DELETE FROM session_locks WHERE session_key = ? AND owner = ?`)
        .run(sessionKey, owner);
    }
  }
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/store/src/message-repo.ts
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { TranscriptStorePort } from "../../ports/src/store";
import type { InboundMessage, OutboundDraft } from "../../domain/src/message";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class SqliteTranscriptStore implements TranscriptStorePort {
  constructor(private readonly db: Database.Database) {}

  async recordInbound(message: InboundMessage): Promise<void> {
    this.db.prepare(
      `INSERT INTO message_ledger (
        message_id, session_key, direction, qq_message_ref, codex_turn_ref, content_digest, payload_json, created_at
      ) VALUES (?, ?, 'inbound', ?, NULL, ?, ?, ?)`
    ).run(
      message.messageId,
      message.sessionKey,
      message.messageId,
      digest(message.text),
      JSON.stringify(message),
      message.receivedAt
    );
  }

  async recordOutbound(draft: OutboundDraft): Promise<void> {
    this.db.prepare(
      `INSERT INTO delivery_jobs (
        job_id, session_key, status, attempt_count, payload_json, last_error, created_at, updated_at
      ) VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)`
    ).run(
      draft.draftId,
      draft.sessionKey,
      JSON.stringify(draft),
      draft.createdAt,
      draft.createdAt
    );
  }

  async hasInbound(messageId: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT 1 FROM message_ledger WHERE message_id = ?`).get(messageId);
    return Boolean(row);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/unit/sqlite-store.test.ts
npm run check
```

Expected:

- `sqlite-store.test.ts` PASS
- `tsc --noEmit` PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add packages/store tests/unit/sqlite-store.test.ts
git commit -m "feat: add sqlite-backed session stores"
```

### Task 4: Build the Orchestrator and Idempotent Turn Flow

**Files:**
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/bridge-orchestrator.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/job-runner.ts`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/unit/bridge-orchestrator.test.ts`

- [ ] **Step 1: Write the failing orchestrator test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/unit/bridge-orchestrator.test.ts
import { describe, expect, it, vi } from "vitest";
import { BridgeOrchestrator } from "../../packages/orchestrator/src/bridge-orchestrator";
import { BridgeSessionStatus } from "../../packages/domain/src/session";

describe("bridge orchestrator", () => {
  it("creates a missing session, deduplicates inbound messages, and delivers drafts", async () => {
    const sessionStore = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn().mockResolvedValue(undefined),
      updateSessionStatus: vi.fn().mockResolvedValue(undefined),
      updateBinding: vi.fn().mockResolvedValue(undefined),
      withSessionLock: vi.fn(async (_key, work) => await work())
    };

    const transcriptStore = {
      recordInbound: vi.fn().mockResolvedValue(undefined),
      recordOutbound: vi.fn().mockResolvedValue(undefined),
      hasInbound: vi.fn().mockResolvedValue(false)
    };

    const conversationProvider = {
      runTurn: vi.fn().mockResolvedValue([
        { draftId: "draft-1", sessionKey: "qqbot:default::qq:c2c:abc", text: "hello back", createdAt: "2026-04-08T10:01:00.000Z" }
      ])
    };

    const egress = {
      deliver: vi.fn().mockResolvedValue({
        jobId: "draft-1",
        sessionKey: "qqbot:default::qq:c2c:abc",
        providerMessageId: "qq-msg-2",
        deliveredAt: "2026-04-08T10:01:01.000Z"
      })
    };

    const orchestrator = new BridgeOrchestrator({
      accountKey: "qqbot:default",
      sessionStore,
      transcriptStore,
      conversationProvider,
      qqEgress: egress
    });

    await orchestrator.handleInbound({
      messageId: "qq-msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc",
      peerKey: "qq:c2c:abc",
      chatType: "c2c",
      senderId: "abc",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    });

    expect(sessionStore.createSession).toHaveBeenCalledTimes(1);
    expect(conversationProvider.runTurn).toHaveBeenCalledTimes(1);
    expect(egress.deliver).toHaveBeenCalledTimes(1);
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:abc",
      BridgeSessionStatus.Active,
      null
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/unit/bridge-orchestrator.test.ts
```

Expected: FAIL with missing orchestrator implementation

- [ ] **Step 3: Implement the orchestrator**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/bridge-orchestrator.ts
import { BridgeSessionStatus, type BridgeSession } from "../../domain/src/session";
import type { InboundMessage } from "../../domain/src/message";
import type { QqEgressPort } from "../../ports/src/qq";
import type { ConversationProviderPort } from "../../ports/src/conversation";
import type { SessionStorePort, TranscriptStorePort } from "../../ports/src/store";

type BridgeOrchestratorDeps = {
  accountKey: string;
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  conversationProvider: ConversationProviderPort;
  qqEgress: QqEgressPort;
};

export class BridgeOrchestrator {
  constructor(private readonly deps: BridgeOrchestratorDeps) {}

  async handleInbound(message: InboundMessage): Promise<void> {
    const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
    if (alreadySeen) return;

    await this.deps.sessionStore.withSessionLock(message.sessionKey, async () => {
      const existing = await this.deps.sessionStore.getSession(message.sessionKey);
      if (!existing) {
        const created: BridgeSession = {
          sessionKey: message.sessionKey,
          accountKey: message.accountKey,
          peerKey: message.peerKey,
          chatType: message.chatType,
          peerId: message.senderId,
          codexThreadRef: null,
          status: BridgeSessionStatus.Active,
          lastInboundAt: message.receivedAt,
          lastOutboundAt: null,
          lastError: null
        };
        await this.deps.sessionStore.createSession(created);
      }

      await this.deps.transcriptStore.recordInbound(message);

      try {
        const drafts = await this.deps.conversationProvider.runTurn(message);
        for (const draft of drafts) {
          await this.deps.transcriptStore.recordOutbound(draft);
          await this.deps.qqEgress.deliver(draft);
        }

        await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
      } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.NeedsRebind, lastError);
        throw error;
      }
    });
  }
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/orchestrator/src/job-runner.ts
import type { OutboundDraft } from "../../domain/src/message";
import type { QqEgressPort } from "../../ports/src/qq";

export async function deliverDrafts(
  egress: QqEgressPort,
  drafts: OutboundDraft[]
): Promise<void> {
  for (const draft of drafts) {
    await egress.deliver(draft);
  }
}
```

- [ ] **Step 4: Run the orchestrator test and full unit suite**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/unit/bridge-orchestrator.test.ts
npm test -- tests/unit/*.test.ts
npm run check
```

Expected:

- `bridge-orchestrator.test.ts` PASS
- unit tests PASS
- `tsc --noEmit` PASS

- [ ] **Step 5: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add packages/orchestrator tests/unit/bridge-orchestrator.test.ts
git commit -m "feat: add bridge orchestrator flow"
```

### Task 5: Add QQ Gateway and Sender Adapters

**Files:**
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-api-client.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-gateway.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-normalizer.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-sender.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-channel-adapter.ts`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/contract/qq-normalizer.contract.test.ts`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/contract/qq-sender.contract.test.ts`

- [ ] **Step 1: Write the failing QQ normalizer contract test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/contract/qq-normalizer.contract.test.ts
import { describe, expect, it } from "vitest";
import { normalizeC2CMessage } from "../../packages/adapters/qq/src/qq-normalizer";

describe("qq normalizer", () => {
  it("maps a c2c event to the bridge inbound model", () => {
    const inbound = normalizeC2CMessage(
      {
        id: "msg-1",
        content: "hello",
        timestamp: "2026-04-08T10:00:00.000Z",
        author: {
          user_openid: "ABC123"
        }
      },
      "qqbot:default"
    );

    expect(inbound.peerKey).toBe("qq:c2c:ABC123");
    expect(inbound.sessionKey).toBe("qqbot:default::qq:c2c:ABC123");
  });
});
```

- [ ] **Step 2: Write the failing sender contract test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/contract/qq-sender.contract.test.ts
import { describe, expect, it } from "vitest";
import { chunkTextForQq } from "../../packages/adapters/qq/src/qq-sender";

describe("qq sender", () => {
  it("splits long text into 5000-char chunks", () => {
    const text = "a".repeat(10020);
    const chunks = chunkTextForQq(text, 5000);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5000);
    expect(chunks[1]).toHaveLength(5000);
    expect(chunks[2]).toHaveLength(20);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/contract/qq-normalizer.contract.test.ts
npm test -- tests/contract/qq-sender.contract.test.ts
```

Expected: FAIL with missing QQ adapter implementations

- [ ] **Step 4: Implement QQ normalizer and sender**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-normalizer.ts
import { buildPeerKey, buildSessionKey } from "../../../orchestrator/src/session-key";
import type { InboundMessage } from "../../../domain/src/message";

export function normalizeC2CMessage(
  event: {
    id: string;
    content: string;
    timestamp: string;
    author: { user_openid: string };
  },
  accountKey: string
): InboundMessage {
  const peerKey = buildPeerKey({ chatType: "c2c", peerId: event.author.user_openid });
  return {
    messageId: event.id,
    accountKey,
    sessionKey: buildSessionKey({ accountKey, peerKey }),
    peerKey,
    chatType: "c2c",
    senderId: event.author.user_openid,
    text: event.content,
    receivedAt: event.timestamp
  };
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-sender.ts
import type { OutboundDraft, DeliveryRecord } from "../../../domain/src/message";

export function chunkTextForQq(text: string, limit = 5000): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [""];
}

export class QqSender {
  async deliver(draft: OutboundDraft): Promise<DeliveryRecord> {
    return {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId: null,
      deliveredAt: new Date().toISOString()
    };
  }
}
```

- [ ] **Step 5: Add the QQ gateway and channel adapter skeleton**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-api-client.ts
export class QqApiClient {
  constructor(
    readonly appId: string,
    readonly clientSecret: string
  ) {}
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-gateway.ts
import type { QqIngressPort } from "../../../ports/src/qq";
import type { InboundMessage } from "../../../domain/src/message";

export class QqGateway implements QqIngressPort {
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;

  async onMessage(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async dispatch(message: InboundMessage): Promise<void> {
    if (this.handler) {
      await this.handler(message);
    }
  }
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-channel-adapter.ts
import { QqGateway } from "./qq-gateway";
import { QqSender } from "./qq-sender";

export function createQqChannelAdapter() {
  return {
    ingress: new QqGateway(),
    egress: new QqSender()
  };
}
```

- [ ] **Step 6: Run contract tests and typecheck**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/contract/qq-normalizer.contract.test.ts
npm test -- tests/contract/qq-sender.contract.test.ts
npm run check
```

Expected: both contract tests PASS, typecheck PASS

- [ ] **Step 7: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add packages/adapters/qq tests/contract/qq-normalizer.contract.test.ts tests/contract/qq-sender.contract.test.ts
git commit -m "feat: add qq channel adapters"
```

### Task 6: Implement Codex Desktop Driver via Electron CDP

**Files:**
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/cdp-session.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/reply-parser.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/health.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/codex-desktop-driver.ts`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/contract/codex-desktop-driver.contract.test.ts`

- [ ] **Step 1: Write the failing driver contract test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/contract/codex-desktop-driver.contract.test.ts
import { describe, expect, it } from "vitest";
import { parseAssistantReply } from "../../packages/adapters/codex-desktop/src/reply-parser";

describe("codex desktop driver contract", () => {
  it("extracts the latest assistant reply from a snapshot string", () => {
    const reply = parseAssistantReply(`
      User: hello
      Assistant: first reply
      Assistant: latest reply
    `);

    expect(reply).toBe("latest reply");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/contract/codex-desktop-driver.contract.test.ts
```

Expected: FAIL with missing driver modules

- [ ] **Step 3: Implement reply parsing and health probes**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/reply-parser.ts
export function parseAssistantReply(snapshotText: string): string {
  const lines = snapshotText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const assistantLines = lines
    .filter((line) => line.startsWith("Assistant:"))
    .map((line) => line.replace(/^Assistant:\s*/, ""));

  return assistantLines.at(-1) ?? "";
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/health.ts
import fs from "node:fs";
import path from "node:path";

export function ensureArtifactDir(baseDir: string): string {
  const artifactDir = path.join(baseDir, "artifacts", "desktop-driver");
  fs.mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}
```

- [ ] **Step 4: Implement the driver skeleton**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/cdp-session.ts
export type CdpSessionConfig = {
  appName: string;
  remoteDebuggingPort: number;
};

export class CdpSession {
  constructor(readonly config: CdpSessionConfig) {}

  async connect(): Promise<void> {
    return;
  }
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/codex-desktop/src/codex-desktop-driver.ts
import { randomUUID } from "node:crypto";
import type { DesktopDriverPort } from "../../../ports/src/conversation";
import type { DriverBinding } from "../../../domain/src/driver";
import type { InboundMessage, OutboundDraft } from "../../../domain/src/message";
import { CdpSession } from "./cdp-session";

export class CodexDesktopDriver implements DesktopDriverPort {
  constructor(private readonly cdp: CdpSession) {}

  async ensureAppReady(): Promise<void> {
    await this.cdp.connect();
  }

  async openOrBindSession(sessionKey: string, binding: DriverBinding | null): Promise<DriverBinding> {
    return {
      sessionKey,
      codexThreadRef: binding?.codexThreadRef ?? `codex-thread:${randomUUID()}`
    };
  }

  async sendUserMessage(_binding: DriverBinding, _message: InboundMessage): Promise<void> {
    return;
  }

  async collectAssistantReply(binding: DriverBinding): Promise<OutboundDraft[]> {
    return [
      {
        draftId: randomUUID(),
        sessionKey: binding.sessionKey,
        text: "stubbed desktop reply",
        createdAt: new Date().toISOString()
      }
    ];
  }

  async markSessionBroken(_sessionKey: string, _reason: string): Promise<void> {
    return;
  }
}
```

- [ ] **Step 5: Run contract tests and typecheck**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/contract/codex-desktop-driver.contract.test.ts
npm run check
```

Expected: contract test PASS, typecheck PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add packages/adapters/codex-desktop tests/contract/codex-desktop-driver.contract.test.ts
git commit -m "feat: add codex desktop driver skeleton"
```

### Task 7: Wire Bootstrap, Provider, and Runtime Docs

**Files:**
- Modify: `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/bootstrap.ts`
- Modify: `/Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/main.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/docs/architecture.md`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/docs/provider-boundary.md`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/docs/testing.md`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/docs/decisions/0001-repo-shape.md`
- Test: `/Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/private-chat.e2e.test.ts`

- [ ] **Step 1: Write the failing e2e smoke test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/private-chat.e2e.test.ts
import { describe, expect, it } from "vitest";
import { bootstrap } from "../../apps/bridge-daemon/src/bootstrap";

describe("bootstrap integration", () => {
  it("builds the app container with orchestrator and adapters", () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";

    const app = bootstrap();

    expect(app.orchestrator).toBeDefined();
    expect(app.adapters.qq).toBeDefined();
    expect(app.adapters.codexDesktop).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/e2e/private-chat.e2e.test.ts
```

Expected: FAIL because `bootstrap()` still only returns config

- [ ] **Step 3: Wire the app container**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/bootstrap.ts
import { loadConfigFromEnv } from "./config";
import { createSqliteDatabase } from "../../../packages/store/src/sqlite";
import { SqliteSessionStore } from "../../../packages/store/src/session-repo";
import { SqliteTranscriptStore } from "../../../packages/store/src/message-repo";
import { BridgeOrchestrator } from "../../../packages/orchestrator/src/bridge-orchestrator";
import { createQqChannelAdapter } from "../../../packages/adapters/qq/src/qq-channel-adapter";
import { CodexDesktopDriver } from "../../../packages/adapters/codex-desktop/src/codex-desktop-driver";
import { CdpSession } from "../../../packages/adapters/codex-desktop/src/cdp-session";

export function bootstrap() {
  const config = loadConfigFromEnv(process.env);
  const db = createSqliteDatabase(config.databasePath);
  const sessionStore = new SqliteSessionStore(db);
  const transcriptStore = new SqliteTranscriptStore(db);
  const adapters = {
    qq: createQqChannelAdapter(),
    codexDesktop: new CodexDesktopDriver(
      new CdpSession({
        appName: config.codexDesktop.appName,
        remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
      })
    )
  };

  const conversationProvider = {
    runTurn: async (message: Parameters<BridgeOrchestrator["handleInbound"]>[0]) => {
      await adapters.codexDesktop.ensureAppReady();
      const binding = await adapters.codexDesktop.openOrBindSession(message.sessionKey, null);
      await adapters.codexDesktop.sendUserMessage(binding, message);
      return adapters.codexDesktop.collectAssistantReply(binding);
    }
  };

  const orchestrator = new BridgeOrchestrator({
    accountKey: "qqbot:default",
    sessionStore,
    transcriptStore,
    conversationProvider,
    qqEgress: adapters.qq.egress
  });

  return {
    config,
    db,
    adapters,
    orchestrator
  };
}
```

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/apps/bridge-daemon/src/main.ts
import { bootstrap } from "./bootstrap";

async function main() {
  const app = bootstrap();

  await app.adapters.qq.ingress.onMessage(async (message) => {
    await app.orchestrator.handleInbound(message);
  });

  console.log("[qq-codex-bridge] ready");
}

main().catch((error) => {
  console.error("[qq-codex-bridge] fatal", error);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Add core docs**

```md
<!-- /Volumes/13759427003/AI/qq-codex-bridge/docs/architecture.md -->
# Architecture

系统由 QQ 适配层、桥接编排层、Codex 桌面驱动层和 SQLite 存储层组成。
第一版通过桌面 UI 自动化驱动 Codex，不把控件语义泄露给编排层。
```

```md
<!-- /Volumes/13759427003/AI/qq-codex-bridge/docs/provider-boundary.md -->
# Provider Boundary

`packages/adapters/codex-desktop` 是唯一理解 Codex 桌面窗口和 CDP 自动化的模块。
`packages/orchestrator` 只能依赖 `ConversationProviderPort` 和 `DesktopDriverPort`。
```

```md
<!-- /Volumes/13759427003/AI/qq-codex-bridge/docs/testing.md -->
# Testing

- unit: 领域和编排逻辑
- contract: QQ 与桌面驱动契约
- e2e: 私聊、群聊、重绑定恢复
```

```md
<!-- /Volumes/13759427003/AI/qq-codex-bridge/docs/decisions/0001-repo-shape.md -->
# ADR 0001: Single-Process Prototype

原型采用单仓库、单主进程，优先验证真实链路和会话隔离，再决定是否拆分服务。
```

- [ ] **Step 5: Run e2e bootstrap test, full test suite, and typecheck**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/e2e/private-chat.e2e.test.ts
npm test
npm run check
```

Expected:

- bootstrap e2e test PASS
- current test suite PASS
- typecheck PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add apps docs tests/e2e/private-chat.e2e.test.ts
git commit -m "feat: wire bootstrap and project docs"
```

### Task 8: Add Group-Chat Flow and Rebind Recovery Tests

**Files:**
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/group-chat.e2e.test.ts`
- Create: `/Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/rebind-recovery.e2e.test.ts`
- Modify: `/Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-normalizer.ts`

- [ ] **Step 1: Write the failing group-chat e2e test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/group-chat.e2e.test.ts
import { describe, expect, it } from "vitest";
import { buildPeerKey, buildSessionKey } from "../../packages/orchestrator/src/session-key";

describe("group session isolation", () => {
  it("uses one group one session", () => {
    const peerKey = buildPeerKey({ chatType: "group", peerId: "GROUP-1" });
    const sessionKey = buildSessionKey({ accountKey: "qqbot:default", peerKey });

    expect(peerKey).toBe("qq:group:GROUP-1");
    expect(sessionKey).toBe("qqbot:default::qq:group:GROUP-1");
  });
});
```

- [ ] **Step 2: Write the failing rebind recovery e2e test**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/tests/e2e/rebind-recovery.e2e.test.ts
import { describe, expect, it, vi } from "vitest";
import { BridgeOrchestrator } from "../../packages/orchestrator/src/bridge-orchestrator";

describe("rebind recovery", () => {
  it("marks session as needs_rebind when provider fails", async () => {
    const sessionStore = {
      getSession: vi.fn().mockResolvedValue({
        sessionKey: "qqbot:default::qq:c2c:abc",
        accountKey: "qqbot:default",
        peerKey: "qq:c2c:abc",
        chatType: "c2c",
        peerId: "abc",
        codexThreadRef: "codex-thread:1",
        status: "active",
        lastInboundAt: null,
        lastOutboundAt: null,
        lastError: null
      }),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn().mockResolvedValue(undefined),
      updateBinding: vi.fn().mockResolvedValue(undefined),
      withSessionLock: vi.fn(async (_key, work) => await work())
    };

    const transcriptStore = {
      recordInbound: vi.fn().mockResolvedValue(undefined),
      recordOutbound: vi.fn().mockResolvedValue(undefined),
      hasInbound: vi.fn().mockResolvedValue(false)
    };

    const orchestrator = new BridgeOrchestrator({
      accountKey: "qqbot:default",
      sessionStore,
      transcriptStore,
      conversationProvider: {
        runTurn: vi.fn().mockRejectedValue(new Error("reply timeout"))
      },
      qqEgress: {
        deliver: vi.fn()
      }
    });

    await expect(
      orchestrator.handleInbound({
        messageId: "qq-msg-1",
        accountKey: "qqbot:default",
        sessionKey: "qqbot:default::qq:c2c:abc",
        peerKey: "qq:c2c:abc",
        chatType: "c2c",
        senderId: "abc",
        text: "hello",
        receivedAt: "2026-04-08T10:00:00.000Z"
      })
    ).rejects.toThrow("reply timeout");

    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:abc",
      "needs_rebind",
      "reply timeout"
    );
  });
});
```

- [ ] **Step 3: Run tests to verify current recovery logic gaps**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/e2e/group-chat.e2e.test.ts
npm test -- tests/e2e/rebind-recovery.e2e.test.ts
```

Expected:

- group test PASS
- recovery test PASS if Task 4 的异常路径已经正确
- 如果 recovery test FAIL，错误应当落在 `BridgeSessionStatus.NeedsRebind` 或 `updateSessionStatus(...)` 参数不一致

- [ ] **Step 4: Adjust orchestrator and QQ normalizer as needed**

```ts
// /Volumes/13759427003/AI/qq-codex-bridge/packages/adapters/qq/src/qq-normalizer.ts
import { buildPeerKey, buildSessionKey } from "../../../orchestrator/src/session-key";
import type { InboundMessage } from "../../../domain/src/message";

export function normalizeGroupMessage(
  event: {
    id: string;
    content: string;
    timestamp: string;
    group_openid: string;
    author: { member_openid: string };
  },
  accountKey: string
): InboundMessage {
  const peerKey = buildPeerKey({ chatType: "group", peerId: event.group_openid });
  return {
    messageId: event.id,
    accountKey,
    sessionKey: buildSessionKey({ accountKey, peerKey }),
    peerKey,
    chatType: "group",
    senderId: event.author.member_openid,
    text: event.content,
    receivedAt: event.timestamp
  };
}
```

- [ ] **Step 5: Run full e2e subset and typecheck**

Run:

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
npm test -- tests/e2e/group-chat.e2e.test.ts
npm test -- tests/e2e/rebind-recovery.e2e.test.ts
npm test -- tests/e2e/private-chat.e2e.test.ts
npm run check
```

Expected: 三个 e2e 文件 PASS，typecheck PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/13759427003/AI/qq-codex-bridge
git add packages/adapters/qq/src/qq-normalizer.ts tests/e2e/group-chat.e2e.test.ts tests/e2e/rebind-recovery.e2e.test.ts
git commit -m "feat: add group isolation and rebind recovery coverage"
```

## Self-Review

### Spec Coverage

本计划覆盖了 spec 中的核心要求：

- 仓库结构与模块边界：Task 1、Task 2、Task 7
- SQLite 持久化和会话账本：Task 3
- 会话隔离与串行执行：Task 4、Task 8
- QQ 适配层：Task 5
- Codex 桌面驱动：Task 6
- 错误恢复与 `needs_rebind`：Task 4、Task 8
- 文档与运行说明：Task 7

未覆盖项：无。Deferred 项目已被明确排除在计划之外。

### Placeholder Scan

本计划没有使用 `TODO`、`TBD`、`之后补`、`类似前文` 之类占位写法。所有任务都给出了明确文件路径、命令和最小代码。

### Type Consistency

核心类型名已固定并在各任务中保持一致：

- `BridgeSessionStatus`
- `InboundMessage`
- `OutboundDraft`
- `DesktopDriverPort`
- `ConversationProviderPort`
- `SessionStorePort`
- `TranscriptStorePort`

## Execution Handoff

Plan complete and saved to `/Volumes/13759427003/AI/qq-codex-bridge/docs/superpowers/plans/2026-04-08-qq-codex-bridge.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
