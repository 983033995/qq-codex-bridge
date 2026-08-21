import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { BridgeHttpRoute } from "./http-server.js";
import { AdminRepository, redactConfig } from "../../../packages/store/src/admin-repo.js";
import type { AdminSessionRow } from "../../../packages/store/src/admin-repo.js";
import type { SqlitePushRepository } from "../../../packages/store/src/push-repo.js";
import type { PublicPushTarget, PushChannel, PushTargetType } from "../../../packages/ports/src/push.js";
import { ADMIN_HTML } from "./admin-html.js";

const KEEP_SECRET_VALUE = "__QQ_CODEX_KEEP_SECRET__";
const QQ_PUSH_UNSUPPORTED_WARNING =
  "QQ 官方机器人当前没有经过验证的主动推送 API，此目标创建后所有推送都会返回 channel_unsupported，" +
  "除非账号获得腾讯侧主动消息权限并接入真实接口。";

type AdminRoutesDeps = {
  config: AppConfig;
  repository: AdminRepository;
  startedAt: string;
  getChannels: () => string[];
  pushTargets?: Pick<
    SqlitePushRepository,
    "listAllTargets" | "saveTarget" | "disableTarget"
  >;
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
      routePath: "/admin/api/push-targets",
      methods: ["GET", "POST"],
      allowOnlyLocal: true,
      handleRequest: async (request, response) => {
        if (!deps.pushTargets) {
          writeJson(response, 503, { error: "push target registry unavailable" });
          return;
        }
        if (request.method === "GET") {
          writeJson(response, 200, { targets: await deps.pushTargets.listAllTargets() });
          return;
        }

        let input: ReturnType<typeof parseTargetInput>;
        try {
          input = parseTargetInput(await readJson(request));
        } catch (error) {
          writeJson(response, 400, {
            error: error instanceof Error ? error.message : "invalid target request"
          });
          return;
        }
        const sessions = await deps.repository.listSessions(500);
        const session = sessions.find((candidate) => candidate.sessionKey === input.sessionKey);
        if (!session) {
          writeJson(response, 404, { error: "session not found" });
          return;
        }
        const resolved = resolveTargetFromSession(session);
        if (!resolved) {
          writeJson(response, 400, { error: "session channel cannot be registered for push" });
          return;
        }
        const saved = await deps.pushTargets.saveTarget({
          alias: input.alias,
          ...resolved,
          enabled: input.enabled
        });
        writeJson(response, 201, {
          target: toPublicTarget(saved),
          ...(resolved.channel === "qq" ? { warning: QQ_PUSH_UNSUPPORTED_WARNING } : {})
        });
      }
    },
    {
      routePath: "/admin/api/push-targets/:alias",
      methods: ["DELETE"],
      allowOnlyLocal: true,
      handleRequest: async (request, response) => {
        if (!deps.pushTargets) {
          writeJson(response, 503, { error: "push target registry unavailable" });
          return;
        }
        const alias = decodeURIComponent(
          new URL(request.url ?? "/", "http://127.0.0.1").pathname.split("/").at(-1) ?? ""
        );
        if (!isValidAlias(alias)) {
          writeJson(response, 400, { error: "invalid target alias" });
          return;
        }
        const disabled = await deps.pushTargets.disableTarget(alias);
        writeJson(response, disabled ? 200 : 404, disabled ? { ok: true } : { error: "target not found" });
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
        const level = url.searchParams.get("level") ?? undefined;
        writeJson(response, 200, {
          events: await deps.repository.listRuntimeEvents(limit, level),
          deliveryErrors: await deps.repository.listDeliveryErrors(Math.min(limit, 100))
        });
      }
    }
  ];
}

function parseTargetInput(value: unknown): {
  alias: string;
  sessionKey: string;
  enabled: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid target request");
  }
  const record = value as Record<string, unknown>;
  const alias = String(record.alias ?? "").trim();
  const sessionKey = String(record.sessionKey ?? "").trim();
  if (!alias || !sessionKey) {
    throw new Error("alias and sessionKey are required");
  }
  if (!isValidAlias(alias)) {
    throw new Error("invalid target alias format (only lowercase letters, numbers, dots, dashes, and underscores allowed, e.g. wx-bot)");
  }
  return { alias, sessionKey, enabled: record.enabled !== false };
}

function isValidAlias(alias: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias);
}

function resolveTargetFromSession(session: AdminSessionRow): {
  channel: PushChannel;
  accountKey: string;
  targetType: PushTargetType;
  providerTargetId: string;
} | null {
  const [accountKey, scope, ...extra] = session.sessionKey.split("::");
  if (!accountKey || !scope || extra.length > 0 || accountKey !== session.accountKey || scope !== session.peerKey) {
    return null;
  }
  const [marker, chatType, ...targetParts] = scope.split(":");
  const providerTargetId = targetParts.join(":").trim();
  if ((chatType !== "c2c" && chatType !== "group")
    || chatType !== session.chatType
    || !providerTargetId) {
    return null;
  }
  const channel = channelForSession(accountKey, marker);
  if (!channel) {
    return null;
  }
  return {
    channel,
    accountKey,
    targetType: chatType === "group" ? "group" : "user",
    providerTargetId
  };
}

function channelForSession(accountKey: string, marker: string): PushChannel | null {
  if (accountKey.startsWith("qqbot:") && marker === "qq") {
    return "qq";
  }
  if (accountKey.startsWith("weixin:") && marker === "wx") {
    return "weixin";
  }
  if (accountKey.startsWith("feishu:") && marker === "fs") {
    return "feishu";
  }
  return null;
}

function toPublicTarget(target: {
  alias: string;
  channel: PushChannel;
  accountKey: string;
  targetType: PushTargetType;
  providerTargetId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}): PublicPushTarget {
  const { providerTargetId: _hidden, ...publicTarget } = target;
  return publicTarget;
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
