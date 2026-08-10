import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import { z, ZodError, type ZodType } from "zod";
import {
  channelConfigSchema,
  routerConfigSchema,
  vnextConfigSchema
} from "../../../packages/config/src/index.js";
import {
  VNextDomainError,
  type ComponentHealth
} from "../../../packages/domain/src/vnext/index.js";

const API_PREFIX = "/api/v1";
const SESSION_COOKIE = "qqcb_vnext_session";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 1024 * 1024;

const idSchema = z.string().trim().min(1).max(256);
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(2048).optional()
}).strict();
const emptySchema = z.object({}).strict();
const threadCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  cwd: z.string().trim().min(1).max(4096).optional()
}).strict();
const threadUpdateSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();
const bindingSchema = z.object({
  threadId: idSchema,
  mode: z.enum(["exclusive", "shared"]).default("exclusive"),
  replaceActive: z.boolean().default(false)
}).strict();
const routerTestSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
  spaceId: idSchema.optional()
}).strict();
const configPlanSchema = z.object({ candidate: vnextConfigSchema }).strict();
const secretChangeSchema = z.object({
  ref: z.string().regex(/^[a-z0-9][a-z0-9/_-]*$/),
  value: z.string().min(1).nullable()
}).strict();
const configApplySchema = z.object({
  candidate: vnextConfigSchema,
  secretChanges: z.array(secretChangeSchema).default([])
}).strict();
const diagnosticsExportSchema = z.object({ includeLogs: z.boolean().default(true) }).strict();
const pushTargetSchema = z.object({
  alias: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  spaceId: idSchema,
  enabled: z.boolean().default(true)
}).strict();

export const controlApiOperations = [
  "health.get",
  "system.status",
  "channels.list",
  "channels.create",
  "channels.test",
  "channels.restart",
  "channels.delete",
  "spaces.list",
  "spaces.get",
  "spaces.messages.list",
  "spaces.bindings.create",
  "spaces.bindings.deleteCurrent",
  "threads.list",
  "threads.create",
  "threads.update",
  "turns.list",
  "turns.interrupt",
  "router.config.get",
  "router.config.update",
  "router.test",
  "router.decisions.list",
  "config.get",
  "config.plan",
  "config.apply",
  "diagnostics.events.list",
  "diagnostics.export",
  "pushTargets.list",
  "pushTargets.create",
  "pushTargets.delete"
] as const;

export type ControlApiOperation = (typeof controlApiOperations)[number];

export type ControlApiInvocation = {
  operation: ControlApiOperation;
  params: Readonly<Record<string, string>>;
  query: unknown;
  body: unknown;
};

export interface ControlApiServices {
  execute(invocation: ControlApiInvocation): Promise<unknown>;
}

type RouteDefinition = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  operation: ControlApiOperation;
  body?: ZodType;
  query?: ZodType;
};

const routes: readonly RouteDefinition[] = [
  route("GET", "/health", "health.get"),
  route("GET", "/system/status", "system.status"),
  route("GET", "/channels", "channels.list"),
  route("POST", "/channels", "channels.create", channelConfigSchema),
  route("POST", "/channels/:id/test", "channels.test", emptySchema),
  route("POST", "/channels/:id/restart", "channels.restart", emptySchema),
  route("DELETE", "/channels/:id", "channels.delete"),
  route("GET", "/spaces", "spaces.list", undefined, paginationSchema),
  route("GET", "/spaces/:id", "spaces.get"),
  route("GET", "/spaces/:id/messages", "spaces.messages.list", undefined, paginationSchema),
  route("POST", "/spaces/:id/bindings", "spaces.bindings.create", bindingSchema),
  route("DELETE", "/spaces/:id/bindings/current", "spaces.bindings.deleteCurrent"),
  route("GET", "/threads", "threads.list", undefined, paginationSchema),
  route("POST", "/threads", "threads.create", threadCreateSchema),
  route("PATCH", "/threads/:id", "threads.update", threadUpdateSchema),
  route("GET", "/turns", "turns.list", undefined, paginationSchema),
  route("POST", "/turns/:id/interrupt", "turns.interrupt", emptySchema),
  route("GET", "/router/config", "router.config.get"),
  route("PUT", "/router/config", "router.config.update", routerConfigSchema),
  route("POST", "/router/test", "router.test", routerTestSchema),
  route("GET", "/router/decisions", "router.decisions.list", undefined, paginationSchema),
  route("GET", "/config", "config.get"),
  route("POST", "/config/plan", "config.plan", configPlanSchema),
  route("POST", "/config/apply", "config.apply", configApplySchema),
  route("GET", "/diagnostics/events", "diagnostics.events.list", undefined, paginationSchema),
  route("POST", "/diagnostics/export", "diagnostics.export", diagnosticsExportSchema),
  route("GET", "/push-targets", "pushTargets.list"),
  route("POST", "/push-targets", "pushTargets.create", pushTargetSchema),
  route("DELETE", "/push-targets/:alias", "pushTargets.delete")
];

export type ControlApiServerOptions = {
  host: string;
  port: number;
  services: ControlApiServices;
  sessionTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
  randomToken?: () => string;
};

export class ControlApiServer {
  readonly name = "management-api";
  readonly critical = true;
  private readonly sessions: LocalSessionStore;
  private readonly since: string;
  private server: Server | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: ControlApiServerOptions) {
    if (!isLoopbackHost(options.host)) {
      throw new Error("Management API host must be loopback");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error("Management API port must be an integer between 0 and 65535");
    }
    const now = options.now ?? Date.now;
    this.sessions = new LocalSessionStore({
      ttlMs: options.sessionTtlMs,
      maxSessions: options.maxSessions,
      now,
      randomToken: options.randomToken
    });
    this.since = new Date(now()).toISOString();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.port, this.options.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.server = server;
      this.lastError = null;
    } catch (error) {
      server.close();
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  async health(): Promise<ComponentHealth> {
    const ready = this.server?.listening === true;
    return {
      component: this.name,
      status: ready ? "ready" : "offline",
      code: ready ? undefined : "MANAGEMENT_API_OFFLINE",
      message: ready ? "Management API listening on loopback" : this.lastError ?? "Management API is stopped",
      since: this.since,
      suggestedAction: ready ? undefined : "Restart the control daemon"
    };
  }

  address(): AddressInfo | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address : null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    try {
      assertLocalRequest(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const pathname = normalizePath(url.pathname);
      if (request.method === "GET" && pathname === `${API_PREFIX}/session`) {
        const session = this.sessions.issue();
        response.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=${session.sessionId}; HttpOnly; SameSite=Strict; Path=${API_PREFIX}`
        );
        sendJson(response, 200, {
          data: { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() },
          requestId
        });
        return;
      }
      if (!pathname.startsWith(`${API_PREFIX}/`)) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      const session = this.sessions.authenticate(request.headers.cookie);
      if (!session) {
        throw new ApiError(401, "SESSION_REQUIRED", "A valid local session is required");
      }
      const method = request.method ?? "GET";
      if (MUTATING_METHODS.has(method)) {
        assertCsrf(request.headers["x-csrf-token"], session.csrfToken);
      }
      const relativePath = pathname.slice(API_PREFIX.length) || "/";
      const pathMatches = routes.flatMap((candidate) => {
        const params = matchPath(candidate.path, relativePath);
        return params ? [{ candidate, params }] : [];
      });
      if (pathMatches.length === 0) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      const matched = pathMatches.find(({ candidate }) => candidate.method === method);
      if (!matched) {
        response.setHeader("Allow", [...new Set(pathMatches.map(({ candidate }) => candidate.method))].join(", "));
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "HTTP method is not allowed for this route");
      }
      const queryInput = Object.fromEntries(url.searchParams.entries());
      const query = matched.candidate.query?.parse(queryInput) ?? {};
      const body = matched.candidate.body
        ? matched.candidate.body.parse(await readJsonBody(request))
        : {};
      const data = await this.options.services.execute({
        operation: matched.candidate.operation,
        params: matched.params,
        query,
        body
      });
      sendJson(response, 200, { data, requestId });
    } catch (error) {
      sendApiError(response, requestId, error);
    }
  }
}

type LocalSession = {
  sessionId: string;
  csrfToken: string;
  expiresAt: number;
};

class LocalSessionStore {
  private readonly sessions = new Map<string, LocalSession>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;

  constructor(options: {
    ttlMs?: number;
    maxSessions?: number;
    now: () => number;
    randomToken?: () => string;
  }) {
    this.ttlMs = positiveInteger(options.ttlMs ?? 12 * 60 * 60 * 1000, "sessionTtlMs");
    this.maxSessions = positiveInteger(options.maxSessions ?? 32, "maxSessions");
    this.now = options.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  }

  issue(): LocalSession {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.sessions.delete(oldest);
    }
    const session = {
      sessionId: required(this.randomToken(), "sessionId"),
      csrfToken: required(this.randomToken(), "csrfToken"),
      expiresAt: this.now() + this.ttlMs
    };
    this.sessions.set(session.sessionId, session);
    return { ...session };
  }

  authenticate(cookieHeader: string | undefined): LocalSession | null {
    this.prune();
    const sessionId = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (!sessionId) {
      return null;
    }
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function route(
  method: RouteDefinition["method"],
  path: string,
  operation: ControlApiOperation,
  body?: ZodType,
  query?: ZodType
): RouteDefinition {
  return { method, path, operation, body, query };
}

function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const patternParts = normalizePath(pattern).split("/");
  const actualParts = normalizePath(actual).split("/");
  if (patternParts.length !== actualParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!;
    const received = actualParts[index]!;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = idSchema.parse(decodePathSegment(received));
    } else if (expected !== received) {
      return null;
    }
  }
  return params;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH_ENCODING", "Path parameter encoding is invalid");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = (request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "JSON body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

function assertLocalRequest(request: IncomingMessage): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOOPBACK_REQUIRED", "Management API accepts loopback clients only");
  }
  const hostHeader = request.headers.host;
  if (!hostHeader) {
    throw new ApiError(400, "HOST_REQUIRED", "Host header is required");
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    throw new ApiError(400, "HOST_INVALID", "Host header is invalid");
  }
  if (!isLoopbackHost(hostname)) {
    throw new ApiError(403, "LOOPBACK_REQUIRED", "Management API Host must be loopback");
  }
}

function assertCsrf(header: string | string[] | undefined, expected: string): void {
  const actual = typeof header === "string" ? header : "";
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new ApiError(403, "CSRF_INVALID", "A valid CSRF token is required");
  }
}

function sendApiError(response: ServerResponse, requestId: string, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof ApiError) {
    sendJson(response, error.status, {
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      requestId
    });
    return;
  }
  if (error instanceof ZodError) {
    sendJson(response, 400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      },
      requestId
    });
    return;
  }
  if (error instanceof VNextDomainError) {
    sendJson(response, domainStatus(error), {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {})
      },
      requestId
    });
    return;
  }
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "The management operation failed" },
    requestId
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(`${JSON.stringify(value)}\n`);
}

function domainStatus(error: VNextDomainError): number {
  if (error.code === "CONFIG_INVALID" || error.code === "MEDIA_REJECTED") {
    return 400;
  }
  if (error.code === "CHANNEL_AUTH_REQUIRED") {
    return 401;
  }
  if (error.code === "CODEX_THREAD_NOT_FOUND") {
    return 404;
  }
  if (error.code === "CHANNEL_RATE_LIMITED") {
    return 429;
  }
  return 409;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    result[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return result;
}

export function isLoopbackHost(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }
  const parts = hostname.split(".").map(Number);
  return parts.length === 4
    && parts[0] === 127
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return isLoopbackHost(value.replace(/^::ffff:/, ""));
}

function normalizePath(value: string): string {
  if (!value.startsWith("/")) {
    return `/${value}`;
  }
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
