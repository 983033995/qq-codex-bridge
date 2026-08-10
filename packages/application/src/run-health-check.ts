import type { ComponentHealth } from "../../domain/src/vnext/index.js";
import type { Clock } from "../../ports/src/vnext/index.js";

export type HealthProbe = {
  component: string;
  critical: boolean;
  check(): Promise<ComponentHealth>;
};

export type HealthCheckReport = {
  status: ComponentHealth["status"];
  checkedAt: string;
  components: ComponentHealth[];
};

export class RunHealthCheck {
  constructor(private readonly deps: {
    probes: readonly HealthProbe[];
    clock: Clock;
  }) {}

  async execute(): Promise<HealthCheckReport> {
    if (this.deps.probes.length === 0) {
      throw new Error("At least one health probe is required");
    }
    const checkedAt = this.deps.clock.now().toISOString();
    const components = await Promise.all(this.deps.probes.map(async (probe) => {
      try {
        const health = await probe.check();
        if (health.component !== probe.component) {
          throw new Error(
            `Health probe '${probe.component}' returned component '${health.component}'`
          );
        }
        return health;
      } catch (error) {
        return {
          component: probe.component,
          status: "offline" as const,
          code: "HEALTH_CHECK_FAILED",
          message: error instanceof Error ? error.message : String(error),
          since: checkedAt,
          suggestedAction: `Restore ${probe.component} and retry the health check`
        };
      }
    }));

    return {
      status: aggregateStatus(this.deps.probes, components),
      checkedAt,
      components
    };
  }
}

function aggregateStatus(
  probes: readonly HealthProbe[],
  components: readonly ComponentHealth[]
): ComponentHealth["status"] {
  if (components.some((health, index) =>
    health.status === "offline" && probes[index]?.critical
  )) {
    return "offline";
  }
  if (components.some((health) => health.status === "action_required")) {
    return "action_required";
  }
  if (components.some((health) =>
    health.status === "degraded" || health.status === "offline"
  )) {
    return "degraded";
  }
  return "ready";
}
