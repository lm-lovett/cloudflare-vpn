import { describe, expect, it } from "vitest";
import {
  normalizeUuid,
  parseVlessRequest,
  uuidToBytes,
  vlessResponseHeader,
  websocketPath,
} from "../src/vless";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function encode(options: {
  uuid?: string;
  uuidBytes?: Uint8Array;
  version?: number;
  addon?: Uint8Array;
  command?: number;
  port?: number;
  address: { type: "ipv4" | "domain" | "ipv6"; value: string };
  payload?: Uint8Array;
}): Uint8Array {
  const version = options.version ?? 0;
  const uuid = options.uuidBytes ?? uuidToBytes(options.uuid ?? UUID);
  const addon = options.addon ?? new Uint8Array();
  const command = options.command ?? 1;
  const port = options.port ?? 443;
  const payload = options.payload ?? new Uint8Array();
  const address = encodeAddress(options.address);

  const out = new Uint8Array(
    1 + uuid.length + 1 + addon.length + 1 + 2 + address.length + payload.length,
  );
  let offset = 0;
  out[offset] = version;
  offset += 1;
  out.set(uuid, offset);
  offset += uuid.length;
  out[offset] = addon.length;
  offset += 1;
  out.set(addon, offset);
  offset += addon.length;
  out[offset] = command;
  offset += 1;
  out[offset] = (port >> 8) & 0xff;
  offset += 1;
  out[offset] = port & 0xff;
  offset += 1;
  out.set(address, offset);
  offset += address.length;
  out.set(payload, offset);
  return out;
}

function encodeAddress(address: {
  type: "ipv4" | "domain" | "ipv6";
  value: string;
}): Uint8Array {
  if (address.type === "ipv4") {
    const parts = address.value.split(".").map((part) => Number(part));
    return new Uint8Array([1, ...parts]);
  }
  if (address.type === "domain") {
    const bytes = new TextEncoder().encode(address.value);
    const out = new Uint8Array(2 + bytes.length);
    out[0] = 2;
    out[1] = bytes.length;
    out.set(bytes, 2);
    return out;
  }
  const groups = address.value.split(":").map((group) => Number.parseInt(group, 16));
  const out = new Uint8Array(17);
  out[0] = 3;
  for (let i = 0; i < 8; i++) {
    out[1 + i * 2] = (groups[i]! >> 8) & 0xff;
    out[2 + i * 2] = groups[i]! & 0xff;
  }
  return out;
}

describe("parseVlessRequest", () => {
  it("parses an IPv4 request and keeps the payload", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const parsed = parseVlessRequest(
      encode({
        address: { type: "ipv4", value: "1.1.1.1" },
        port: 853,
        payload,
      }),
      UUID,
    );

    expect(parsed).toEqual({
      ok: true,
      request: {
        command: 1,
        port: 853,
        address: "1.1.1.1",
        payload,
      },
    });
  });

  it("parses a domain and skips addons", () => {
    const parsed = parseVlessRequest(
      encode({
        addon: new Uint8Array([9, 8, 7]),
        address: { type: "domain", value: "www.google.com" },
        port: 443,
      }),
      UUID.toUpperCase(),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.address).toBe("www.google.com");
    expect(parsed.request.port).toBe(443);
    expect(parsed.request.payload).toEqual(new Uint8Array());
  });

  it("parses an IPv6 address", () => {
    const parsed = parseVlessRequest(
      encode({
        address: { type: "ipv6", value: "2001:db8:0:0:0:0:0:1" },
        port: 443,
      }),
      UUID,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.address).toBe("2001:db8:0:0:0:0:0:1");
  });

  it("accepts a UDP command so the worker can reject it", () => {
    const parsed = parseVlessRequest(
      encode({
        command: 2,
        address: { type: "domain", value: "dns.google" },
        port: 53,
      }),
      UUID,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.command).toBe(2);
  });

  it("returns truncated until the header is complete", () => {
    const packet = encode({
      address: { type: "domain", value: "example.com" },
    });
    expect(parseVlessRequest(packet.subarray(0, 10), UUID)).toEqual({
      ok: false,
      reason: "truncated",
    });
    expect(parseVlessRequest(packet.subarray(0, packet.length - 1), UUID)).toEqual({
      ok: false,
      reason: "truncated",
    });
    expect(parseVlessRequest(packet, UUID).ok).toBe(true);
  });

  it("rejects a wrong UUID without reading it as a bad packet", () => {
    const uuidBytes = uuidToBytes(UUID);
    uuidBytes[0] ^= 0xff;
    const parsed = parseVlessRequest(
      encode({
        uuidBytes,
        address: { type: "ipv4", value: "8.8.8.8" },
      }),
      UUID,
    );
    expect(parsed).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("rejects a wrong version, a bad address type, an empty domain, and port 0", () => {
    expect(
      parseVlessRequest(
        encode({ version: 1, address: { type: "ipv4", value: "1.1.1.1" } }),
        UUID,
      ),
    ).toEqual({ ok: false, reason: "invalid" });

    const badType = encode({ address: { type: "ipv4", value: "1.1.1.1" } });
    badType[badType.length - 5] = 9;
    expect(parseVlessRequest(badType, UUID)).toEqual({
      ok: false,
      reason: "invalid",
    });

    const emptyDomain = encode({
      address: { type: "domain", value: "a" },
    });
    const domainLengthIndex = emptyDomain.length - 2;
    emptyDomain[domainLengthIndex] = 0;
    expect(parseVlessRequest(emptyDomain.subarray(0, domainLengthIndex + 1), UUID)).toEqual({
      ok: false,
      reason: "invalid",
    });

    expect(
      parseVlessRequest(
        encode({ port: 0, address: { type: "ipv4", value: "1.1.1.1" } }),
        UUID,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an unconfigured UUID", () => {
    expect(
      parseVlessRequest(
        encode({ address: { type: "ipv4", value: "1.1.1.1" } }),
        "not-a-uuid",
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("uuid helpers", () => {
  it("normalizes UUIDs and builds the websocket path", () => {
    expect(normalizeUuid(`  ${UUID.toUpperCase()} \n`)).toBe(UUID);
    expect(normalizeUuid("1234")).toBeNull();
    expect(websocketPath(UUID)).toBe(`/${UUID}`);
    expect(vlessResponseHeader()).toEqual(new Uint8Array([0, 0]));
  });
});
