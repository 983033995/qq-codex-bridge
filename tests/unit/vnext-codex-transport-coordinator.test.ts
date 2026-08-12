import { describe, expect, it, vi } from "vitest";
import { AppServerError } from "../../packages/codex-appserver/src/index.js";
import {
  CodexTransportCoordinator,
  isExplicitPreAcceptanceFailure
} from "../../packages/application/src/index.js";
import type {
  CodexPort,
  CodexRecoveryPort,
  CodexTurnHandle,
  CodexTurnResult,
  StartCodexRecoveryTurnInput
} from "../../packages/ports/src/vnext/index.js";
import { ControllableCodexPort } from "../support/vnext-fakes.js";

describe("vNext Codex transport coordinator", () => {
  it("enters Recovery only for an explicit AppServer pre-acceptance failure", async () => {
    const appServer = new PreAcceptanceFailingCodexPort();
    const recovery = new FakeRecoveryPort();
    const coordinator = new CodexTransportCoordinator({ appServer, recovery });
    const handle = await coordinator.startTurn(input());

    expect(handle.transport).toBe("cdp-recovery");
    expect(recovery.starts).toEqual([expect.objectContaining({
      threadId: "thread-1",
      threadTitle: "Thread A",
      idempotencyKey: "message-1"
    })]);
    recovery.complete("recovery-1");
    await expect(handle.completion).resolves.toMatchObject({ finalText: "recovered" });
  });

  it("never enters Recovery after AppServer returned an accepted handle", async () => {
    const appServer = new ControllableCodexPort(false);
    await appServer.createThread({ title: "Thread A" });
    const recovery = new FakeRecoveryPort();
    const coordinator = new CodexTransportCoordinator({ appServer, recovery });
    const handle = await coordinator.startTurn(input());
    appServer.fail(handle.turnId, new AppServerError(
      "connection closed after acceptance",
      "connection_closed",
      true
    ));

    await expect(handle.completion).rejects.toMatchObject({ accepted: true });
    expect(handle.transport).toBe("app-server");
    expect(recovery.starts).toEqual([]);
  });

  it("does not recover generic or explicitly accepted start errors", async () => {
    const recovery = new FakeRecoveryPort();
    const generic = stubAppServerStart(new Error("invalid input"));
    await expect(new CodexTransportCoordinator({ appServer: generic, recovery }).startTurn(input()))
      .rejects.toThrow("invalid input");

    const accepted = stubAppServerStart(new AppServerError("uncertain", "protocol_error", true));
    await expect(new CodexTransportCoordinator({ appServer: accepted, recovery }).startTurn(input()))
      .rejects.toMatchObject({ accepted: true });
    expect(recovery.starts).toEqual([]);
  });

  it("reports precise interruption as unsupported for an active Recovery turn", async () => {
    const recovery = new FakeRecoveryPort();
    const coordinator = new CodexTransportCoordinator({
      appServer: new PreAcceptanceFailingCodexPort(),
      recovery
    });
    const handle = await coordinator.startTurn(input());

    await expect(coordinator.interruptTurn(handle.threadId, handle.turnId)).rejects.toEqual(
      expect.objectContaining({
        code: "recovery_interrupt_unsupported",
        accepted: true,
        transport: "cdp-recovery"
      })
    );
    expect(recovery.starts).toHaveLength(1);
    recovery.complete(handle.turnId);
    await handle.completion;
  });

  it("recognizes only an explicit boolean false acceptance marker", () => {
    expect(isExplicitPreAcceptanceFailure({ accepted: false })).toBe(true);
    expect(isExplicitPreAcceptanceFailure({ accepted: true })).toBe(false);
    expect(isExplicitPreAcceptanceFailure({ accepted: "false" })).toBe(false);
    expect(isExplicitPreAcceptanceFailure(new Error("offline"))).toBe(false);
  });
});

function input() {
  return {
    threadId: "thread-1",
    threadTitle: "Thread A",
    idempotencyKey: "message-1",
    content: { text: "hello", mentions: [], attachments: [] }
  };
}

class PreAcceptanceFailingCodexPort extends ControllableCodexPort {
  override async startTurn(): Promise<never> {
    throw new AppServerError("AppServer unavailable", "connect_failed", false);
  }
}

class FakeRecoveryPort implements CodexRecoveryPort {
  readonly starts: StartCodexRecoveryTurnInput[] = [];
  private readonly handles = new Map<string, DeferredTurn>();

  async health() {
    return {
      component: "codex-cdp-recovery",
      status: "degraded" as const,
      message: "recovery",
      since: "2026-08-10T06:00:00.000Z",
      capabilities: {
        selectKnownThread: true as const,
        submitText: true as const,
        collectFinalReply: true as const,
        controlState: true as const,
        createThread: false as const,
        renameThread: false as const,
        forkThread: false as const,
        concurrentTurns: false as const,
        preciseTurnEvents: false as const,
        media: false as const
      }
    };
  }

  async startRecoveryTurn(input: StartCodexRecoveryTurnInput): Promise<CodexTurnHandle> {
    this.starts.push(structuredClone(input));
    const turnId = `recovery-${this.starts.length}`;
    let resolve!: (value: CodexTurnResult) => void;
    const completion = new Promise<CodexTurnResult>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.handles.set(turnId, { resolve });
    return {
      threadId: input.threadId,
      turnId,
      acceptedAt: "2026-08-10T06:00:00.000Z",
      completion
    };
  }

  async getControlState() {
    return { model: null, reasoningEffort: null, quotaSummary: null };
  }

  complete(turnId: string): void {
    this.handles.get(turnId)!.resolve({
      threadId: "thread-1",
      turnId,
      finalText: "recovered",
      mediaReferences: []
    });
  }
}

type DeferredTurn = {
  resolve(value: CodexTurnResult): void;
};

function stubAppServerStart(error: Error): CodexPort {
  const base = new ControllableCodexPort(false);
  return Object.assign(base, { startTurn: vi.fn().mockRejectedValue(error) });
}
