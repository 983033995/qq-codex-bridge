import type { PushEgressPort } from "../../../ports/src/push.js";

export class QqPushEgress implements PushEgressPort {
  async send(): ReturnType<PushEgressPort["send"]> {
    return {
      ok: false,
      retryable: false,
      code: "channel_unsupported",
      message: "this QQ bot account does not expose a verified proactive message API"
    };
  }
}
