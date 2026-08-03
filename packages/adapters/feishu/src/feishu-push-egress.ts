import type { PushEgressPort } from "../../../ports/src/push.js";
import { sendFeishuImage, sendFeishuText } from "./feishu-message-client.js";
import type { FeishuMessageClient } from "./feishu-types.js";

export class FeishuPushEgress implements PushEgressPort {
  constructor(private readonly client: FeishuMessageClient) {}

  async send(input: Parameters<PushEgressPort["send"]>[0]): ReturnType<PushEgressPort["send"]> {
    try {
      const unsupported = input.payload.message.media.find((media) => media.type !== "image");
      if (unsupported) {
        return {
          ok: false,
          retryable: false,
          code: "channel_unsupported",
          message: `Feishu v0.2 only supports image media, received ${unsupported.type}`
        };
      }
      if (input.payload.message.media.length !== input.resolvedMediaPaths.length) {
        return {
          ok: false,
          retryable: false,
          code: "permanent_failure",
          message: "Feishu media resolution count mismatch"
        };
      }
      let providerMessageId: string | null = null;
      if (input.payload.message.text) {
        providerMessageId = await sendFeishuText(
          this.client,
          input.target.providerTargetId,
          input.payload.message.text,
          {
            rich: input.payload.message.format === "markdown",
            uuid: input.pushId
          }
        );
      }
      for (let index = 0; index < input.resolvedMediaPaths.length; index += 1) {
        providerMessageId = await sendFeishuImage(
          this.client,
          input.target.providerTargetId,
          input.resolvedMediaPaths[index],
          `${input.pushId}-image-${index}`
        );
      }
      return { ok: true, providerMessageId };
    } catch (error) {
      return classifyFeishuError(error);
    }
  }
}

function classifyFeishuError(error: unknown): Exclude<Awaited<ReturnType<PushEgressPort["send"]>>, { ok: true }> {
  const message = error instanceof Error ? error.message : String(error);
  const status = readNumeric(error, "status") ?? readNestedStatus(error);
  const apiCode = Number(/Feishu API failed:\s*(\d+)/.exec(message)?.[1] ?? 0);
  const rateLimited = status === 429 || apiCode === 99991400;
  const permanent = (status !== null && status >= 400 && status < 500 && !rateLimited)
    || (apiCode > 0 && !rateLimited);
  return {
    ok: false,
    retryable: !permanent,
    code: rateLimited ? "rate_limited" : permanent ? "permanent_failure" : "temporary_failure",
    message
  };
}

function readNestedStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  return readNumeric((error as Record<string, unknown>).response, "status");
}

function readNumeric(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const number = Number((value as Record<string, unknown>)[key]);
  return Number.isFinite(number) ? number : null;
}
