import type { ServerResponse } from "node:http";
import type {
  StructuredEvent,
  StructuredEventBus
} from "../../../packages/observability/src/index.js";

type SseConnection = {
  response: ServerResponse;
  unsubscribe(): void;
  heartbeat: NodeJS.Timeout;
  closed: boolean;
};

export class StructuredEventSseStream {
  private readonly connections = new Set<SseConnection>();
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly events: StructuredEventBus,
    options: { heartbeatIntervalMs?: number } = {}
  ) {
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? 15_000,
      "heartbeatIntervalMs"
    );
  }

  open(response: ServerResponse, lastEventId?: string): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    response.write("retry: 2000\n\n");

    let replaying = true;
    const pending: StructuredEvent[] = [];
    let connection: SseConnection | null = null;
    const unsubscribe = this.events.subscribe((event) => {
      if (replaying) {
        pending.push(event);
        return;
      }
      if (!writeEvent(response, event)) {
        connection && this.close(connection);
      }
    });

    const history = this.events.listAfter();
    const cursorIndex = lastEventId
      ? history.findIndex((event) => event.eventId === lastEventId)
      : -1;
    const replay = lastEventId && cursorIndex >= 0
      ? history.slice(cursorIndex + 1)
      : history;
    const writtenIds = new Set<string>();
    for (const event of replay) {
      writtenIds.add(event.eventId);
      if (!writeEvent(response, event)) {
        unsubscribe();
        response.end();
        return;
      }
    }
    replaying = false;
    for (const event of pending) {
      if (!writtenIds.has(event.eventId) && !writeEvent(response, event)) {
        unsubscribe();
        response.end();
        return;
      }
    }

    connection = {
      response,
      unsubscribe,
      heartbeat: setInterval(() => {
        if (!response.write(": keepalive\n\n")) {
          connection && this.close(connection);
        }
      }, this.heartbeatIntervalMs),
      closed: false
    };
    connection.heartbeat.unref();
    this.connections.add(connection);
    response.once("close", () => connection && this.close(connection));
  }

  closeAll(): void {
    for (const connection of [...this.connections]) {
      this.close(connection);
    }
  }

  private close(connection: SseConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    this.connections.delete(connection);
    clearInterval(connection.heartbeat);
    connection.unsubscribe();
    connection.response.end();
  }
}

function writeEvent(response: ServerResponse, event: StructuredEvent): boolean {
  return response.write(
    `id: ${singleLine(event.eventId)}\n` +
    `event: bridge-event\n` +
    `data: ${JSON.stringify(event)}\n\n`
  );
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
