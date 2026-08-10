import type {
  ConfigStorePort,
  SecretStorePort
} from "../../ports/src/vnext/index.js";
import {
  ApplyConfiguration as ApplyConfigurationUseCase,
  type SecretChange
} from "../../application/src/apply-configuration.js";
import { planConfigApply, type ApplyPlan } from "./apply-planner.js";
import { calculateConfigRevision } from "./revision.js";
import { vnextConfigSchema, type VNextConfig } from "./schema.js";

export type { SecretChange } from "../../application/src/apply-configuration.js";

export async function applyConfiguration(input: {
  configStore: ConfigStorePort<VNextConfig>;
  secretStore: SecretStorePort;
  nextConfig: VNextConfig;
  secretChanges: readonly SecretChange[];
  applyPlan(plan: ApplyPlan): Promise<void>;
}): Promise<ApplyPlan> {
  return new ApplyConfigurationUseCase<VNextConfig, VNextConfig, ApplyPlan>({
    configStore: input.configStore,
    secretStore: input.secretStore,
    prepare: (current, candidate) => {
      const value = vnextConfigSchema.parse(candidate);
      return {
        snapshot: {
          value,
          revision: calculateConfigRevision(value)
        },
        plan: planConfigApply(current?.value ?? null, value)
      };
    },
    applyPlan: (plan) => input.applyPlan(plan)
  }).execute({
    candidate: input.nextConfig,
    secretChanges: input.secretChanges
  });
}
