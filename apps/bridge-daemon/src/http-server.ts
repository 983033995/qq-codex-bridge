import { createServer, type IncomingMessage, type Server } from "node:http";

type JsonServerDeps = {
  routePath: string;
  dispatchPayload(payload: unknown): Promise<void>;
  onDispatchError?: (error: Error, payload: unknown) => void;
  allowOnlyLocal?: boolean;
};

type QqWebhookServerDeps = {
  webhookPath: string;
  ingress: {
    dispatchPayload(payload: unknown): Promise<void>;
  };
  onDispatchError?: (error: Error, payload: unknown) => void;
};

type InternalTurnEventServerDeps = {
  routePath: string;
  ingress: {
    dispatchTurnEvent(payload: unknown): Promise<void>;
  };
  onDispatchError?: (error: Error, payload: unknown) => void;
};

export function createQqWebhookServer(deps: QqWebhookServerDeps): Server {
  return createJsonServer({
    routePath: deps.webhookPath,
    dispatchPayload: deps.ingress.dispatchPayload,
    onDispatchError: deps.onDispatchError
  });
}

export function createInternalTurnEventServer(deps: InternalTurnEventServerDeps): Server {
  return createJsonServer({
    routePath: deps.routePath,
    dispatchPayload: deps.ingress.dispatchTurnEvent,
    onDispatchError: deps.onDispatchError,
    allowOnlyLocal: true
  });
}

function createJsonServer(deps: JsonServerDeps): Server {
  return createServer(async (request, response) => {
    if (request.url !== deps.routePath) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    if (deps.allowOnlyLocal && !isLocalRequest(request)) {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }

    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "invalid request");
      return;
    }

    Promise.resolve()
      .then(() => deps.dispatchPayload(payload))
      .catch((error) => {
        const normalized =
          error instanceof Error ? error : new Error(typeof error === "string" ? error : "dispatch failed");
        deps.onDispatchError?.(normalized, payload);
      });

    response.statusCode = 202;
    response.end("accepted");
  });
}

function isLocalRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (!address) {
    return false;
  }

  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
