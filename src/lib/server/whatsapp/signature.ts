import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Valida el header X-Hub-Signature-256 que manda Meta en cada webhook:
 * "sha256=" + HMAC-SHA256(rawBody, APP_SECRET) en hex.
 */
export const isValidSignature = (
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean => {
  if (!header || !header.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
};
