import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { BridgeHttpRoute } from "./http-server.js";
import { AdminRepository, redactConfig } from "../../../packages/store/src/admin-repo.js";
import { ADMIN_HTML } from "./admin-html.js";

const KEEP_SECRET_VALUE = "__QQ_CODEX_KEEP_SECRET__";

type AdminRoutesDeps = {
  config: AppConfig;
  repository: AdminRepository;
  startedAt: string;
  getChannels: () => string[];
};

export function createAdminRoutes(deps: AdminRoutesDeps): BridgeHttpRoute[] {
  return [
    {
      routePath: "/admin",
      methods: ["GET"],
      allowOnlyLocal: true,
      handleRequest: async (_request, response) => {
        writeResponse(response, 200, "text/html; charset=utf-8", ADMIN_HTML);
      }
    },
    {
      routePath: "/admin/api/status",
      methods: ["GET"],
      allowOnlyLocal: true,
      handleRequest: async (_request, response) => {
        const stats = await deps.repository.getStats();
        writeJson(response, 200, {
          startedAt: deps.startedAt,
          now: new Date().toISOString(),
          uptimeMs: Date.now() - Date.parse(deps.startedAt),
          listenHost: deps.config.runtime.listenHost,
          listenPort: deps.config.runtime.listenPort,
          adminUrl: `http://${deps.config.runtime.listenHost}:${deps.config.runtime.listenPort}/admin`,
          webhookPath: deps.config.runtime.webhookPath,
          conversationProvider: deps.config.conversationProvider,
          channels: deps.getChannels(),
          databasePath: deps.config.databasePath,
          configComplete: deps.config.qqBots.every((bot) => bot.appId && bot.clientSecret),
          stats
        });
      }
    },
    {
      routePath: "/admin/api/media",
      methods: ["GET"],
      allowOnlyLocal: true,
      handleRequest: async (request, response) => {
        const url = requestUrl(request);
        const mediaPath = url.searchParams.get("path") ?? "";
        if (!mediaPath || /^https?:\/\//i.test(mediaPath)) {
          response.statusCode = 400;
          response.end("invalid media path");
          return;
        }

        if (!(await deps.repository.hasKnownMediaPath(mediaPath))) {
          response.statusCode = 404;
          response.end("media path not found in message ledger");
          return;
        }

        const stat = fs.existsSync(mediaPath) ? fs.statSync(mediaPath) : null;
        if (!stat?.isFile()) {
          response.statusCode = 404;
          response.end("media file not found");
          return;
        }

        response.statusCode = 200;
        response.setHeader("content-type", mimeTypeForPath(mediaPath));
        response.setHeader("content-length", String(stat.size));
        fs.createReadStream(mediaPath).pipe(response);
      }
    },
    {
      routePath: "/admin/api/config",
      methods: ["GET", "POST"],
      allowOnlyLocal: true,
      handleRequest: async (request, response) => {
        if (request.method === "POST") {
          const payload = await readJson(request);
          const draft = replaceKeptSecrets(payload, deps.config);
          await deps.repository.saveConfigDraft(draft);
          await deps.repository.recordEvent({
            level: "info",
            source: "admin",
            message: "configuration draft saved",
            details: { keys: draft && typeof draft === "object" ? Object.keys(draft) : [] }
          });
          writeJson(response, 200, { ok: true });
          return;
        }

        writeJson(response, 200, {
          effective: redactConfig(deps.config),
          draft: await deps.repository.getConfigDraft()
        });
      }
    },
    {
      routePath: "/admin/api/sessions",
      methods: ["GET"],
      allowOnlyLocal: true,
      handleRequest: async (request, response) => {
        const url = requestUrl(request);
        writeJson(response, 200, {
          sessions: await deps.repository.listSessions(numberParam(url, "limit", 100))
        });
      }
    },
    {
      routePath: "/admin/api/messages",
      methods: ["GET"],
      allowOnlyLocal: true,
      handleRequest: async (request, response) => {
        const url = requestUrl(request);
        writeJson(response, 200, {
          messages: await deps.repository.listMessages({
            sessionKey: url.searchParams.get("sessionKey") ?? undefined,
            limit: numberParam(url, "limit", 100)
          })
        });
      }
    },
    {
      routePath: "/admin/api/errors",
      methods: ["GET"],
      allowOnlyLocal: true,
      handleRequest: async (request, response) => {
        const url = requestUrl(request);
        const limit = numberParam(url, "limit", 100);
        writeJson(response, 200, {
          events: await deps.repository.listRuntimeEvents(limit),
          deliveryErrors: await deps.repository.listDeliveryErrors(Math.min(limit, 100))
        });
      }
    }
  ];
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  writeResponse(response, statusCode, "application/json; charset=utf-8", JSON.stringify(value));
}

function writeResponse(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function numberParam(url: URL, key: string, fallback: number): number {
  const value = Number(url.searchParams.get(key) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function replaceKeptSecrets(value: unknown, fallback: unknown): unknown {
  if (value === KEEP_SECRET_VALUE) {
    return fallback;
  }

  if (Array.isArray(value)) {
    const fallbackArray = Array.isArray(fallback) ? fallback : [];
    return value.map((item, index) => replaceKeptSecrets(item, fallbackArray[index]));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const fallbackRecord = fallback && typeof fallback === "object" ? fallback as Record<string, unknown> : {};
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, replaceKeptSecrets(nested, fallbackRecord[key])])
  );
}

function mimeTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
