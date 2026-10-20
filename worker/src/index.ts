import { connect } from "cloudflare:sockets";
import {
  decodeEarlyData,
  normalizeUuid,
  parseVlessRequest,
  vlessResponseHeader,
  websocketPath,
  type VlessRequest,
} from "./vless";

export interface Env {
  UUID?: string;
}

const MAX_HEADER_BYTES = 64 * 1024;

class MessageQueue {
  private readonly pending: Uint8Array[] = [];
  private readonly waiters: Array<(value: Uint8Array | null) => void> = [];
  private closed = false;

  push(data: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(data);
    else this.pending.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter(null);
    this.waiters.length = 0;
  }

  read(): Promise<Uint8Array | null> {
    const next = this.pending.shift();
    if (next) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function isBlob(data: unknown): data is Blob {
  return (
    typeof data === "object" &&
    data !== null &&
    Object.prototype.toString.call(data) === "[object Blob]" &&
    "arrayBuffer" in data
  );
}

async function toBytes(data: unknown): Promise<Uint8Array<ArrayBuffer> | null> {
  if (typeof data === "string") return null;
  if (isBlob(data)) return copyBytes(new Uint8Array(await data.arrayBuffer()));
  if (
    data instanceof ArrayBuffer ||
    Object.prototype.toString.call(data) === "[object ArrayBuffer]"
  ) {
    return copyBytes(new Uint8Array(data as ArrayBuffer));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return copyBytes(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  return null;
}

function closeQuietly(ws: WebSocket, code = 1000, reason = ""): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

async function closeSocket(socket: ReturnType<typeof connect>): Promise<void> {
  try {
    await socket.close();
  } catch {
    // already closed
  }
}

async function readRequest(
  queue: MessageQueue,
  uuid: string,
): Promise<VlessRequest | "closed" | "rejected" | "too-large"> {
  let buffered = new Uint8Array(0);
  while (true) {
    const chunk = await queue.read();
    if (!chunk) return "closed";
    buffered = concat(buffered, chunk);
    if (buffered.length > MAX_HEADER_BYTES) return "too-large";

    const parsed = parseVlessRequest(buffered, uuid);
    if (parsed.ok) return parsed.request;
    if (parsed.reason !== "truncated") return "rejected";
  }
}

async function relay(
  ws: WebSocket,
  queue: MessageQueue,
  socket: ReturnType<typeof connect>,
  initial: Uint8Array,
): Promise<void> {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const clientToRemote = (async () => {
    try {
      if (initial.byteLength > 0) await writer.write(initial);
      while (true) {
        const chunk = await queue.read();
        if (!chunk) break;
        await writer.write(chunk);
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // remote already closed
      }
    }
  })();

  const remoteToClient = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        ws.send(value);
      }
    } finally {
      queue.close();
      closeQuietly(ws);
    }
  })();

  try {
    await Promise.allSettled([clientToRemote, remoteToClient]);
  } finally {
    queue.close();
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    await closeSocket(socket);
    closeQuietly(ws);
  }
}

async function proxyConnection(
  ws: WebSocket,
  uuid: string,
  early: Uint8Array | null,
): Promise<void> {
  const queue = new MessageQueue();
  if (early) queue.push(early);
  let incoming = Promise.resolve();
  ws.addEventListener("message", (event: MessageEvent) => {
    incoming = incoming.then(async () => {
      const bytes = await toBytes(event.data);
      if (!bytes) {
        queue.close();
        closeQuietly(ws, 1003, "binary only");
        return;
      }
      queue.push(bytes);
    }).catch(() => {
      queue.close();
      closeQuietly(ws, 1003, "binary only");
    });
  });
  ws.addEventListener("close", () => queue.close());
  ws.addEventListener("error", () => queue.close());

  const request = await readRequest(queue, uuid);
  if (request === "closed") {
    closeQuietly(ws);
    return;
  }
  if (request === "too-large") {
    closeQuietly(ws, 1009, "header too large");
    return;
  }
  if (request === "rejected" || request.command !== 1) {
    closeQuietly(ws, request === "rejected" ? 1008 : 1003, "rejected");
    return;
  }

  let socket: ReturnType<typeof connect>;
  try {
    socket = connect({ hostname: request.address, port: request.port });
  } catch {
    closeQuietly(ws, 1011, "connect failed");
    return;
  }

  // Reply before the outbound handshake finishes so the client can send the
  // next flight while Cloudflare is still connecting to the target.
  try {
    ws.send(vlessResponseHeader());
  } catch {
    await closeSocket(socket);
    return;
  }

  await relay(ws, queue, socket, request.payload);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const uuid = env.UUID ? normalizeUuid(env.UUID) : null;
    if (!uuid) {
      return new Response("proxy is not configured", { status: 500 });
    }

    const url = new URL(request.url);
    if (url.pathname !== websocketPath(uuid)) {
      return new Response("not found", { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket required", { status: 426 });
    }

    const earlyProtocol = request.headers.get("Sec-WebSocket-Protocol");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    ctx.waitUntil(
      proxyConnection(server, uuid, decodeEarlyData(earlyProtocol)).catch(() => {
        closeQuietly(server, 1011, "proxy failed");
      }),
    );
    const headers = new Headers();
    const selectedProtocol = earlyProtocol?.split(",")[0]?.trim();
    if (selectedProtocol) headers.set("Sec-WebSocket-Protocol", selectedProtocol);
    return new Response(null, { status: 101, webSocket: client, headers });
  },
} satisfies ExportedHandler<Env>;
