import { VNextDomainError } from "./errors.js";
import type { ThreadBinding } from "./models.js";

export type BindingConflict = {
  kind: "space_already_bound" | "exclusive_thread_already_bound";
  conflictingBindingId: string;
};

export function findBindingConflict(
  candidate: ThreadBinding,
  bindings: readonly ThreadBinding[]
): BindingConflict | null {
  if (candidate.status !== "active") {
    return null;
  }

  for (const binding of bindings) {
    if (binding.status !== "active" || binding.bindingId === candidate.bindingId) {
      continue;
    }

    if (binding.spaceId === candidate.spaceId) {
      return {
        kind: "space_already_bound",
        conflictingBindingId: binding.bindingId
      };
    }

    if (
      binding.threadId === candidate.threadId
      && (binding.mode === "exclusive" || candidate.mode === "exclusive")
    ) {
      return {
        kind: "exclusive_thread_already_bound",
        conflictingBindingId: binding.bindingId
      };
    }
  }

  return null;
}

export function assertBindingCanActivate(
  candidate: ThreadBinding,
  bindings: readonly ThreadBinding[]
): void {
  if (candidate.status !== "active") {
    return;
  }

  const conflict = findBindingConflict(candidate, bindings);
  if (!conflict) {
    return;
  }

  throw new VNextDomainError(
    "BINDING_CONFLICT",
    conflict.kind === "space_already_bound"
      ? `Conversation space '${candidate.spaceId}' already has an active binding`
      : `Codex thread '${candidate.threadId}' already has an active exclusive binding`,
    conflict
  );
}
