import { describe, expect, it } from "vitest";
import { RunCodexSmoke } from "../../packages/application/src/index.js";
import { ControllableCodexPort } from "../support/vnext-fakes.js";

describe("vNext real Codex smoke workflow", () => {
  it("creates A/B/C, starts all three before collecting, verifies routing, and interrupts", async () => {
    const codex = new ControllableCodexPort(false);
    const smoke = new RunCodexSmoke(
      codex,
      sequenceClock("2026-08-10T06:00:00.000Z", "2026-08-10T06:00:01.000Z")
    );
    const execution = smoke.execute({
      runId: "contract-run",
      cwd: "/tmp/vnext-smoke",
      completionTimeoutMs: 5_000,
      interruptProbe: {
        prompt: "Use the terminal tool to run `sleep 30`.",
        waitUntilReady: async () => undefined
      }
    });

    await codex.waitForStartCount(3);
    expect(codex.starts).toHaveLength(3);
    expect(new Set(codex.starts.map((started) => started.input.threadId)).size).toBe(3);
    for (const started of codex.starts.slice(0, 3)) {
      const marker = started.input.content.text.match(/VNEXT_SMOKE_[A-Za-z0-9_]+/)?.[0];
      expect(marker).toBeTruthy();
      codex.complete(started.handle.turnId, marker);
    }

    await codex.waitForStartCount(4);
    expect(codex.starts[3]?.input.content.text).toContain("`sleep 30`");
    const report = await execution;
    expect(report.parallelTurns.map((turn) => turn.label)).toEqual(["A", "B", "C"]);
    expect(report.parallelTurns.every((turn) => turn.finalText.includes(turn.marker))).toBe(true);
    expect(report.interruptedTurn).toMatchObject({
      status: "interrupted",
      completionRejected: true
    });
    expect(report.retainedThreadIds).toHaveLength(3);
    expect(report.createdThreads.map((thread) => thread.title)).toEqual([
      "vNext Smoke contract-run A",
      "vNext Smoke contract-run B",
      "vNext Smoke contract-run C"
    ]);
  });
});

function sequenceClock(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]!);
}
