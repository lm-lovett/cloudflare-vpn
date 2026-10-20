const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface VlessRequest {
  command: number;
  port: number;
  address: string;
  payload: Uint8Array;
}

export type ParseResult =
  | { ok: true; request: VlessRequest }
  | { ok: false; reason: "truncated" | "unauthorized" | "invalid" };

export function normalizeUuid(uuid: string): string | null {
  const trimmed = uuid.trim().toLowerCase();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

export function websocketPath(uuid: string): string {
  const normalized = normalizeUuid(uuid);
  if (!normalized) {
    throw new Error("invalid uuid");
  }
  return `/${normalized}`;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const normalized = normalizeUuid(uuid);
  if (!normalized) {
    throw new Error("invalid uuid");
  }
  const hex = normalized.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

// Layout: version, UUID, addon length, addon, command, port, address, payload.
export function parseVlessRequest(
  data: Uint8Array,
  expectedUuid: string,
): ParseResult {
  const expected = normalizeUuid(expectedUuid);
  if (!expected) return { ok: false, reason: "invalid" };
  if (data.length < 1) return { ok: false, reason: "truncated" };
  if (data[0] !== 0) return { ok: false, reason: "invalid" };
  if (data.length < 18) return { ok: false, reason: "truncated" };

  if (!timingSafeEqual(data.subarray(1, 17), uuidToBytes(expected))) {
    return { ok: false, reason: "unauthorized" };
  }

  const addonLength = data[17]!;
  let offset = 18 + addonLength;
  if (data.length < offset + 4) return { ok: false, reason: "truncated" };

  const command = data[offset]!;
  const port = (data[offset + 1]! << 8) | data[offset + 2]!;
  const addressType = data[offset + 3]!;
  offset += 4;

  if (command !== 1 && command !== 2) return { ok: false, reason: "invalid" };
  if (port === 0) return { ok: false, reason: "invalid" };

  let address: string;
  if (addressType === 1) {
    if (data.length < offset + 4) return { ok: false, reason: "truncated" };
    address = `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`;
    offset += 4;
  } else if (addressType === 2) {
    if (data.length < offset + 1) return { ok: false, reason: "truncated" };
    const length = data[offset]!;
    offset += 1;
    if (length === 0) return { ok: false, reason: "invalid" };
    if (data.length < offset + length) return { ok: false, reason: "truncated" };
    address = new TextDecoder().decode(data.subarray(offset, offset + length));
    offset += length;
  } else if (addressType === 3) {
    if (data.length < offset + 16) return { ok: false, reason: "truncated" };
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(
        ((data[offset + i]! << 8) | data[offset + i + 1]!).toString(16),
      );
    }
    address = parts.join(":");
    offset += 16;
  } else {
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    request: {
      command,
      port,
      address,
      payload: data.subarray(offset),
    },
  };
}

export function vlessResponseHeader(): Uint8Array {
  return new Uint8Array([0, 0]);
}

// Clash puts the first VLESS bytes in Sec-WebSocket-Protocol as raw URL-safe base64.
export function decodeEarlyData(header: string | null): Uint8Array | null {
  if (!header) return null;
  const token = header.split(",")[0]?.trim() ?? "";
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const padded = token + "=".repeat((4 - (token.length % 4)) % 4);
  const standard = padded.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(standard);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.byteLength > 0 ? out : null;
  } catch {
    return null;
  }
}
