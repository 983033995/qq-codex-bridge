import { randomUUID } from "node:crypto";

export type StructuredEvent<T = unknown> = {
  eventId: string;
  component: string;
  type: string;
  payload: T;
  occurredAt: string;
};

export type StructuredEventInput<T = unknown> = Omit<StructuredEvent<T>, "eventId" | "occurredAt">;
export type StructuredEventListener = (event: StructuredEvent) => void;

export class StructuredEventBus {
  private readonly listeners = new Set<StructuredEventListener>();
  private readonly history: StructuredEvent[] = [];
  private readonly historyLimit: number;
  private readonly nextId: () => string;
  private readonly now: () => Date;

  constructor(options: {
    historyLimit?: number;
    nextId?: () => string;
    now?: () => Date;
  } = {}) {
    this.historyLimit = positiveInteger(options.historyLimit ?? 500, "historyLimit");
    this.nextId = options.nextId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  publish<T>(input: StructuredEventInput<T>): StructuredEvent<T> {
    const event: StructuredEvent<T> = Object.freeze({
      eventId: required(input.component ? this.nextId() : "", "eventId"),
      component: required(input.component, "component"),
      type: required(input.type, "type"),
      payload: structuredClone(input.payload),
      occurredAt: this.now().toISOString()
    });
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    for (const listener of [...this.listeners]) {
      listener(structuredClone(event));
    }
    return structuredClone(event);
  }

  subscribe(listener: StructuredEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listAfter(eventId?: string): StructuredEvent[] {
    if (!eventId) {
      return structuredClone(this.history);
    }
    const index = this.history.findIndex((event) => event.eventId === eventId);
    return index < 0 ? [] : structuredClone(this.history.slice(index + 1));
  }
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
