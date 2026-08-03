import { timingSafeEqual } from "node:crypto";
import { PushRequestError } from "./push-error.js";

export function assertPushToken(token: string): void {
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("push token must contain at least 32 bytes");
  }
}

export function authenticateBearer(header: string | undefined, expectedToken: string): void {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  const actual = Buffer.from(match?.[1] ?? "", "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  const comparable = actual.length === expected.length ? actual : Buffer.alloc(expected.length);
  const valid = actual.length === expected.length && timingSafeEqual(comparable, expected);
  if (!valid) {
    throw new PushRequestError(401, "unauthorized", "invalid bearer token");
  }
}
