import { createHmac, timingSafeEqual } from "node:crypto";

const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;

export function verifyLineSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  channelSecret: string,
): boolean {
  if (!signatureHeader || !channelSecret || !SHA256_BASE64.test(signatureHeader)) return false;
  const received = Buffer.from(signatureHeader, "base64");
  if (received.toString("base64") !== signatureHeader) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}
