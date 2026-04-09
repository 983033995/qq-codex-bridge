import { createServer, type Server } from "node:http";

type QqWebhookServerDeps = {
  webhookPath: string;
  ingress: {
    dispatchPayload(payload: unknown): Promise<void>;
  };
};

export function createQqWebhookServer(deps: QqWebhookServerDeps): Server {
  return createServer(async (request, response) => {
    if (request.url !== deps.webhookPath) {
      response.statusCode = 404;
      response.end("not found");
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

    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await deps.ingress.dispatchPayload(payload);
      response.statusCode = 202;
      response.end("accepted");
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : "invalid request");
    }
  });
}
