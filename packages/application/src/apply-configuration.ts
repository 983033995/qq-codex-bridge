import type {
  ConfigSnapshot,
  ConfigStorePort,
  SecretStorePort
} from "../../ports/src/vnext/index.js";

export type SecretChange = {
  ref: string;
  value: string | null;
};

export type PreparedConfiguration<TConfig, TPlan> = {
  snapshot: ConfigSnapshot<TConfig>;
  plan: TPlan;
};

export class ApplyConfiguration<TCandidate, TConfig, TPlan> {
  constructor(private readonly deps: {
    configStore: ConfigStorePort<TConfig>;
    secretStore: SecretStorePort;
    prepare(
      current: ConfigSnapshot<TConfig> | null,
      candidate: TCandidate
    ): PreparedConfiguration<TConfig, TPlan>;
    applyPlan(plan: TPlan): Promise<void>;
  }) {}

  async execute(input: {
    candidate: TCandidate;
    secretChanges: readonly SecretChange[];
  }): Promise<TPlan> {
    const current = await this.deps.configStore.read();
    const prepared = this.deps.prepare(current, input.candidate);
    const previousSecrets = new Map<string, string | null>();
    const changedRefs: string[] = [];

    try {
      for (const change of input.secretChanges) {
        validateSecretChange(change);
        if (!previousSecrets.has(change.ref)) {
          previousSecrets.set(change.ref, await this.deps.secretStore.get(change.ref));
          changedRefs.push(change.ref);
        }
        if (change.value === null) {
          await this.deps.secretStore.delete(change.ref);
        } else {
          await this.deps.secretStore.set(change.ref, change.value);
        }
      }

      await this.deps.configStore.writeAtomic(prepared.snapshot);
      await this.deps.applyPlan(prepared.plan);
      return prepared.plan;
    } catch (error) {
      try {
        await restoreConfig(this.deps.configStore, current);
        await restoreSecrets(this.deps.secretStore, previousSecrets, changedRefs);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Configuration apply failed and rollback was incomplete"
        );
      }
      throw error;
    }
  }
}

async function restoreConfig<TConfig>(
  store: ConfigStorePort<TConfig>,
  snapshot: ConfigSnapshot<TConfig> | null
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
