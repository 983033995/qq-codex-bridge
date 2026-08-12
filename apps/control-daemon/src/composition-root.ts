import type { ComponentHealth } from "../../../packages/domain/src/vnext/index.js";
import type { ApplyPlan } from "../../../packages/config/src/index.js";
import {
  HealthRegistry,
  StructuredEventBus
} from "../../../packages/observability/src/index.js";

export type ControlDaemonComponent = {
  name: string;
  critical: boolean;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  health(): Promise<ComponentHealth>;
  reload?(): Promise<void> | void;
};

export type ControlDaemonState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

export class ControlDaemonCompositionRoot {
  readonly events: StructuredEventBus;
  readonly health: HealthRegistry;
  private readonly components = new Map<string, ControlDaemonComponent>();
  private readonly started: ControlDaemonComponent[] = [];
  private transition: Promise<void> = Promise.resolve();
  private _state: ControlDaemonState = "idle";
  private _activeRevision: string | null = null;

  constructor(options: {
    components: readonly ControlDaemonComponent[];
    events?: StructuredEventBus;
    health?: HealthRegistry;
  }) {
    this.events = options.events ?? new StructuredEventBus();
    this.health = options.health ?? new HealthRegistry();
    if (options.components.length === 0) {
      throw new Error("Control daemon requires at least one component");
    }
    for (const component of options.components) {
      const name = required(component.name, "component.name");
      if (this.components.has(name)) {
        throw new Error(`Control daemon component '${name}' is duplicated`);
      }
      const registered: ControlDaemonComponent = {
        name,
        critical: component.critical,
        start: () => component.start(),
        stop: () => component.stop(),
        health: () => component.health(),
        ...(component.reload ? { reload: () => component.reload!() } : {})
      };
      this.components.set(name, registered);
      this.health.register({
        component: name,
        critical: registered.critical,
        check: () => registered.health()
      });
    }
  }

  get state(): ControlDaemonState {
    return this._state;
  }

  get activeRevision(): string | null {
    return this._activeRevision;
  }

  start(): Promise<void> {
    return this.serialize(() => this.startNow());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopNow());
  }

  applyPlan(plan: ApplyPlan): Promise<void> {
    return this.serialize(async () => {
      this.requireRunning();
      this.events.publish({
        component: "control-daemon",
        type: "config.apply.started",
        payload: { revision: plan.revision, effects: plan.effects }
      });
      try {
        for (const effect of plan.effects) {
          if (effect.type === "hot_reload") {
            const component = this.requireComponent(effect.component);
            if (!component.reload) {
              throw new Error(`Component '${effect.component}' does not support hot reload`);
            }
            await component.reload();
            this.publishLifecycle(component.name, "reloaded");
          } else if (effect.type === "component_restart") {
            await this.restartComponent(this.requireComponent(effect.component));
          } else {
            await this.restartAllComponents();
          }
        }
        this._activeRevision = required(plan.revision, "plan.revision");
        this.events.publish({
          component: "control-daemon",
          type: "config.apply.completed",
          payload: { revision: this._activeRevision }
        });
      } catch (error) {
        this.events.publish({
          component: "control-daemon",
          type: "config.apply.failed",
          payload: { revision: plan.revision, error: errorMessage(error) }
        });
        throw error;
      }
    });
  }

  private async startNow(): Promise<void> {
    if (this._state === "running") {
      return;
    }
    this._state = "starting";
    try {
      for (const component of this.components.values()) {
        await component.start();
        this.started.push(component);
        this.publishLifecycle(component.name, "started");
      }
      this._state = "running";
      this.publishDaemonState();
    } catch (error) {
      await this.stopStartedComponents();
      this._state = "failed";
      this.publishDaemonState(error);
      throw error;
    }
  }

  private async stopNow(): Promise<void> {
    if (this._state === "idle" || this._state === "stopped") {
      this._state = "stopped";
      return;
    }
    this._state = "stopping";
    const errors = await this.stopStartedComponents();
    this._state = errors.length === 0 ? "stopped" : "failed";
    this.publishDaemonState(errors[0]);
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more control daemon components failed to stop");
    }
  }

  private async stopStartedComponents(): Promise<Error[]> {
    const errors: Error[] = [];
    for (const component of [...this.started].reverse()) {
      try {
        await component.stop();
        this.publishLifecycle(component.name, "stopped");
      } catch (error) {
        errors.push(normalizeError(error));
        this.publishLifecycle(component.name, "stop_failed", error);
      }
    }
    this.started.length = 0;
    return errors;
  }

  private async restartComponent(component: ControlDaemonComponent): Promise<void> {
    const index = this.started.findIndex((candidate) => candidate.name === component.name);
    if (index < 0) {
      throw new Error(`Component '${component.name}' is not running`);
    }
    await component.stop();
    this.started.splice(index, 1);
    this.publishLifecycle(component.name, "stopped");
    try {
      await component.start();
      this.started.splice(index, 0, component);
      this.publishLifecycle(component.name, "started");
    } catch (error) {
      this._state = "failed";
      throw error;
    }
  }

  private async restartAllComponents(): Promise<void> {
    const errors = await this.stopStartedComponents();
    if (errors.length > 0) {
      this._state = "failed";
      throw new AggregateError(errors, "Daemon restart could not stop every component");
    }
    this._state = "idle";
    await this.startNow();
  }

  private requireRunning(): void {
    if (this._state !== "running") {
      throw new Error(`Control daemon is not running (state ${this._state})`);
    }
  }

  private requireComponent(name: string): ControlDaemonComponent {
    const component = this.components.get(name);
    if (!component) {
      throw new Error(`Unknown control daemon component '${name}'`);
    }
    return component;
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const result = this.transition.then(work, work);
    this.transition = result.catch(() => undefined);
    return result;
  }

  private publishLifecycle(name: string, phase: string, error?: unknown): void {
    this.events.publish({
      component: name,
      type: `component.${phase}`,
      payload: error ? { error: errorMessage(error) } : {}
    });
  }

  private publishDaemonState(error?: unknown): void {
    this.events.publish({
      component: "control-daemon",
      type: "daemon.state.changed",
      payload: {
        state: this._state,
        ...(error ? { error: errorMessage(error) } : {})
      }
    });
  }
}

export type ShutdownSignalSource = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exitCode?: string | number | null;
};

export function installGracefulShutdown(
  daemon: Pick<ControlDaemonCompositionRoot, "stop">,
  source: ShutdownSignalSource = process
): () => void {
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void daemon.stop().catch(() => {
      source.exitCode = 1;
    });
  };
  source.once("SIGINT", shutdown);
  source.once("SIGTERM", shutdown);
  return () => {
    source.off("SIGINT", shutdown);
    source.off("SIGTERM", shutdown);
  };
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return normalizeError(error).message;
}
