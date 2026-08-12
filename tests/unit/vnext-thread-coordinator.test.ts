import { describe, expect, it } from "vitest";
import { ThreadCoordinator } from "../../packages/application/src/index.js";
import { AppServerError } from "../../packages/codex-appserver/src/index.js";
import type { ConversationSpace } from "../../packages/domain/src/vnext/index.js";
import {
  ControllableCodexPort,
  FixedClock,
  MemoryConversationSpaceRepository,
  MemoryThreadBindingRepository,
  SequenceIdGenerator
} from "../support/vnext-fakes.js";

describe("vNext Thread Coordinator", () => {
  it("creates one exclusive real Thread per new Conversation Space", async () => {
    const harness = await createHarness(["a", "b", "c"]);

    const bindings = await Promise.all(
      harness.spacesList.map((space) => harness.coordinator.ensureDefaultBinding(space.spaceId))
    );

    expect(new Set(bindings.map((binding) => binding.threadId)).size).toBe(3);
    expect(bindings.every((binding) => binding.mode === "exclusive")).toBe(true);
    expect(await harness.coordinator.getActiveBinding(harness.spacesList[0]!.spaceId))
      .toEqual(bindings[0]);
  });

  it("allows shared bindings and preserves the old binding on an exclusive conflict", async () => {
    const harness = await createHarness(["shared-a", "shared-b", "exclusive-a", "exclusive-b"]);
    const sharedThread = await harness.codex.createThread({ title: "Shared" });
    const firstShared = await harness.coordinator.bindThread({
      spaceId: harness.spacesList[0]!.spaceId,
      thread: sharedThread,
      mode: "shared"
    });
    const secondShared = await harness.coordinator.bindThread({
      spaceId: harness.spacesList[1]!.spaceId,
      thread: sharedThread,
      mode: "shared"
    });
    expect(firstShared.threadId).toBe(secondShared.threadId);
    expect(await harness.bindings.listActiveByThread(sharedThread.threadId)).toHaveLength(2);

    const exclusiveThread = await harness.codex.createThread({ title: "Exclusive" });
    await harness.coordinator.bindThread({
      spaceId: harness.spacesList[2]!.spaceId,
      thread: exclusiveThread
    });
    const previous = await harness.coordinator.createAndBind({
      spaceId: harness.spacesList[3]!.spaceId,
      title: "Previous"
    });

    await expect(harness.coordinator.bindThread({
      spaceId: harness.spacesList[3]!.spaceId,
      thread: exclusiveThread,
      replaceActive: true
    })).rejects.toMatchObject({ code: "BINDING_CONFLICT" });
    expect(await harness.coordinator.getActiveBinding(harness.spacesList[3]!.spaceId))
      .toEqual(previous);
  });

  it("refreshes cached titles and supports create, switch, rename, fork, and unbind", async () => {
    const harness = await createHarness(["owner"]);
    const spaceId = harness.spacesList[0]!.spaceId;
    const original = await harness.coordinator.ensureDefaultBinding(spaceId);
    await harness.codex.renameThread(original.threadId, "External title");

    await expect(harness.coordinator.ensureDefaultBinding(spaceId)).resolves.toMatchObject({
      threadId: original.threadId,
      threadTitle: "External title"
    });
    await expect(harness.coordinator.renameBoundThread(spaceId, "Renamed")).resolves.toMatchObject({
      threadId: original.threadId,
      threadTitle: "Renamed"
    });
    const forked = await harness.coordinator.forkBoundThread({ spaceId, title: "Forked" });
    expect(forked).toMatchObject({ threadTitle: "Forked", status: "active" });
    expect(forked.threadId).not.toBe(original.threadId);

    const switched = await harness.coordinator.switchToThread({
      spaceId,
      threadId: original.threadId
    });
    expect(switched.threadId).toBe(original.threadId);
    expect(await harness.coordinator.unbind(spaceId)).toBe(true);
    expect(await harness.coordinator.getActiveBinding(spaceId)).toBeNull();
    expect(await harness.coordinator.unbind(spaceId)).toBe(false);
  });

  it("marks a stale binding broken and creates a replacement from AppServer truth", async () => {
    const harness = await createHarness(["stale"]);
    const spaceId = harness.spacesList[0]!.spaceId;
    const stale = await harness.coordinator.ensureDefaultBinding(spaceId);
    harness.codex.threads.splice(
      harness.codex.threads.findIndex((thread) => thread.threadId === stale.threadId),
      1
    );

    const recovered = await harness.coordinator.ensureDefaultBinding(spaceId);
    expect(recovered.threadId).not.toBe(stale.threadId);
    expect(recovered.status).toBe("active");
    expect(harness.bindings.values.get(stale.bindingId)?.status).toBe("broken");
  });

  it("recovers when a Thread disappears between listing and mutation", async () => {
    const spaces = new MemoryConversationSpaceRepository();
    const bindings = new MemoryThreadBindingRepository();
    const codex = new RenameNotFoundOnceCodexPort();
    const space = sampleSpace("race");
    await spaces.save(space);
    const coordinator = new ThreadCoordinator({
      spaces,
      bindings,
      codex,
      ids: new SequenceIdGenerator("binding"),
      clock: new FixedClock()
    });
    const original = await coordinator.ensureDefaultBinding(space.spaceId);

    const recovered = await coordinator.renameBoundThread(space.spaceId, "Recovered");
    expect(recovered).toMatchObject({ threadTitle: "Recovered", status: "active" });
    expect(recovered.threadId).not.toBe(original.threadId);
    expect(bindings.values.get(original.bindingId)?.status).toBe("broken");
  });

  it("does not create an orphan Thread when replacement was not authorized", async () => {
    const harness = await createHarness(["no-replace"]);
    const spaceId = harness.spacesList[0]!.spaceId;
    await harness.coordinator.ensureDefaultBinding(spaceId);
    const count = harness.codex.threads.length;

    await expect(harness.coordinator.createAndBind({
      spaceId,
      title: "Unauthorized replacement"
    })).rejects.toMatchObject({ code: "BINDING_CONFLICT" });
    expect(harness.codex.threads).toHaveLength(count);
  });
});

async function createHarness(spaceNames: string[]) {
  const spaces = new MemoryConversationSpaceRepository();
  const bindings = new MemoryThreadBindingRepository();
  const codex = new ControllableCodexPort();
  const spacesList = spaceNames.map(sampleSpace);
  await Promise.all(spacesList.map((space) => spaces.save(space)));
  return {
    spaces,
    spacesList,
    bindings,
    codex,
    coordinator: new ThreadCoordinator({
      spaces,
      bindings,
      codex,
      ids: new SequenceIdGenerator("binding"),
      clock: new FixedClock()
    })
  };
}

function sampleSpace(name: string): ConversationSpace {
  const accountId = "weixin:personal" as ConversationSpace["accountId"];
  return {
    spaceId: `${accountId}::c2c:${name}` as ConversationSpace["spaceId"],
    channel: "weixin",
    accountId,
    providerConversationId: name,
    scope: "c2c",
    displayName: name,
    status: "active",
    lastInboundAt: null,
    lastOutboundAt: null
  };
}

class RenameNotFoundOnceCodexPort extends ControllableCodexPort {
  private failRename = true;

  override async renameThread(threadId: string, title: string): Promise<void> {
    if (this.failRename) {
      this.failRename = false;
      const index = this.threads.findIndex((thread) => thread.threadId === threadId);
      this.threads.splice(index, 1);
      throw new AppServerError("thread not found", "thread_not_found", false);
    }
    await super.renameThread(threadId, title);
  }
}
