import type {
  ConfigSnapshot,
  ConfigStorePort,
  SecretStorePort
} from "../../ports/src/vnext/index.js";
import { planConfigApply, type ApplyPlan } from "./apply-planner.js";
import { calculateConfigRevision } from "./revision.js";
import { vnextConfigSchema, type VNextConfig } from "./schema.js";

export type SecretChange = {
  ref: string;
  value: string | null;
};

export async function applyConfiguration(input: {
  configStore: ConfigStorePort<VNextConfig>;
  secretStore: SecretStorePort;
  nextConfig: VNextConfig;
  secretChanges: readonly SecretChange[];
  applyPlan(plan: ApplyPlan): Promise<void>;
}): Promise<ApplyPlan> {
  const current = await input.configStore.read();
  const nextConfig = vnextConfigSchema.parse(input.nextConfig);
  const next: ConfigSnapshot<VNextConfig> = {
    value: nextConfig,
    revision: calculateConfigRevision(nextConfig)
  };
  const plan = planConfigApply(current?.value ?? null, nextConfig);
  const previousSecrets = new Map<string, string | null>();
  const changedRefs: string[] = [];

  try {
    for (const change of input.secretChanges) {
      validateSecretChange(change);
      if (!previousSecrets.has(change.ref)) {
        previousSecrets.set(change.ref, await input.secretStore.get(change.ref));
        changedRefs.push(change.ref);
      }
      if (change.value === null) {
        await input.secretStore.delete(change.ref);
      } else {
        await input.secretStore.set(change.ref, change.value);
      }
    }

    await input.configStore.writeAtomic(next);
    await input.applyPlan(plan);
    return plan;
  } catch (error) {
    try {
      await restoreConfig(input.configStore, current);
      await restoreSecrets(input.secretStore, previousSecrets, changedRefs);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Configuration apply failed and rollback was incomplete"
      );
    }
    throw error;
  }
}

async function restoreConfig(
  store: ConfigStorePort<VNextConfig>,
  snapshot: ConfigSnapshot<VNextConfig> | null
): Promise<void> {
  if (snapshot) {
    await store.writeAtomic(snapshot);
  } else {
    await store.delete();
  }
}

async function restoreSecrets(
  store: SecretStorePort,
  previous: ReadonlyMap<string, string | null>,
  refs: readonly string[]
): Promise<void> {
  for (const ref of [...refs].reverse()) {
    const value = previous.get(ref) ?? null;
    if (value === null) {
      await store.delete(ref);
    } else {
      await store.set(ref, value);
    }
  }
}

function validateSecretChange(change: SecretChange): void {
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(change.ref)) {
    throw new Error(`Invalid secret reference '${change.ref}'`);
  }
  if (change.value !== null && change.value.length === 0) {
    throw new Error(`Secret '${change.ref}' cannot be empty`);
  }
}
