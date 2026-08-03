import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeHttpRoute } from "../../../apps/bridge-daemon/src/http-server.js";
import { authenticateBearer, assertPushToken } from "./push-auth.js";
import { PushRequestError } from "./push-error.js";
import type { PushOrchestrator } from "./push-orchestrator.js";

const MAX_BODY_BYTES = 256 * 1024;

export function createPushApiRoutes(deps: {
  token: string;
  orchestrator: PushOrchestrator;
}): BridgeHttpRoute[] {
  assertPushToken(deps.token);
  const authenticate = (request: IncomingMessage) =>
    authenticateBearer(headerValue(request.headers.authorization), deps.token);
  return [
    {
      routePath: "/api/v1/push",
      methods: ["POST"],
      handleRequest: async (request, response) => {
        try {
          authenticate(request);
          const idempotencyKey = headerValue(request.headers["idempotency-key"]);
          const result = await deps.orchestrator.enqueue(
            idempotencyKey ?? "",
            await readJsonBody(request, MAX_BODY_BYTES)
          );
          writeJson(response, 202, result);
        } catch (error) {
          writePushError(response, error);
        }
      }
    },
    {
      routePath: "/api/v1/push-targets",
      methods: ["GET"],
      handleRequest: async (request, response) => {
        try {
          authenticate(request);
          writeJson(response, 200, { targets: await deps.orchestrator.listTargets() });
        } catch (error) {
          writePushError(response, error);
        }
      }
    },
    {
      routePath: "/api/v1/push/:pushId",
      methods: ["GET"],
      handleRequest: async (request, response) => {
        try {
          authenticate(request);
          const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "");
          const pushId = pathname.split("/").at(-1) ?? "";
          const job = await deps.orchestrator.get(pushId);
          if (!job) {
            throw new PushRequestError(404, "not_found", "push job not found");
          }
          writeJson(response, 200, sanitizeJob(job));
        } catch (error) {
          writePushError(response, error);
        }
      }
    }
  ];
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > limit) {
      throw new PushRequestError(413, "payload_too_large", "request body exceeds 256 KiB");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PushRequestError(400, "invalid_request", "invalid JSON body");
  }
}

function sanitizeJob(job: Awaited<ReturnType<PushOrchestrator["get"]>>) {
  if (!job) {
    return null;
  }
  const { idempotencyKey: _idempotencyKey, claimedBy: _claimedBy, claimedAt: _claimedAt, ...visible } = job;
  return {
    ...visible,
    payload: {
      ...visible.payload,
      message: {
        ...visible.payload.message,
        media: visible.payload.message.media.map(({ path: _path, ...media }) => media)
      }
    }
  };
}

function writePushError(response: ServerResponse, error: unknown): void {
  const normalized = error instanceof PushRequestError
    ? error
    : new PushRequestError(500, "internal_error", error instanceof Error ? error.message : "internal error");
  writeJson(response, normalized.statusCode, {
    error: { code: normalized.code, message: normalized.message }
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
