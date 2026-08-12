import {
  RunHealthCheck,
  type HealthCheckReport,
  type HealthProbe
} from "../../application/src/index.js";
import type { Clock } from "../../ports/src/vnext/index.js";

export class HealthRegistry {
  private readonly probes = new Map<string, HealthProbe>();

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  register(probe: HealthProbe): () => void {
    const component = probe.component.trim();
    if (!component) {
      throw new Error("Health probe component is required");
    }
    if (this.probes.has(component)) {
      throw new Error(`Health probe '${component}' is already registered`);
    }
    const registered = { ...probe, component };
    this.probes.set(component, registered);
    return () => {
      if (this.probes.get(component) === registered) {
        this.probes.delete(component);
      }
    };
  }

  components(): string[] {
    return [...this.probes.keys()];
  }

  async check(): Promise<HealthCheckReport> {
    return new RunHealthCheck({
      probes: [...this.probes.values()],
      clock: this.clock
    }).execute();
  }
}
