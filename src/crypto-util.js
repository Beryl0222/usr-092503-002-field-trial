import { createHash, createHmac, randomBytes } from "node:crypto";

/** 以稳定顺序序列化对象，使哈希与字段书写顺序无关。 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const parts = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hmacHex(secret, text) {
  return createHmac("sha256", secret).update(text, "utf8").digest("hex");
}

export function randomToken() {
  return randomBytes(24).toString("hex");
}

/** 由内容派生短标识，保证同一命令重放得到同一编号。 */
export function shortId(prefix, text) {
  return `${prefix}_${sha256Hex(text).slice(0, 12)}`;
}
