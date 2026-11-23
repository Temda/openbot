import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit, Schema, Scope } from "effect";
import { causeHelpers } from "../../effect-boundary";
import { type LineWebhookEvent, parseLineWebhook } from "./line-events";
import { verifyLineSignature } from "./line-signature";

const logger = createOpenBotLogger("line-webhook");

export const LINE_WEBHOOK_PATH = "/line/webhook";
export const LINE_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
export const LINE_SEEN_EVENTS_LIMIT = 10_000;
export const LINE_SEEN_EVENTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
export const LINE_WEBHOOK_MAX_CONNECTIONS = 16;
const DRAIN_LIMIT_BYTES = 4 * LINE_WEBHOOK_BODY_LIMIT_BYTES;

export class LineWebhookServerFailed extends Schema.TaggedError<LineWebhookServerFailed>()("LineWebhookServerFailed", {
  cause: Schema.Defect(),
}) {}

const { io: serverIo } = causeHelpers(LineWebhookServerFailed);

export interface LineWebhookServerOptions {
  host?: string | undefined;
  port?: number | undefined;
  channelSecret: () => string;
  onEvents: (events: readonly LineWebhookEvent[], destination: string) => void | PromiseLike<void>;
  onSigned?: (() => void) | undefined;
  now?: (() => number) | undefined;
  requestTimeoutMs?: number | undefined;
}

type BodyRead = { type: "body"; bytes: Buffer } | { type: "too_large" } | { type: "timeout" } | { type: "aborted" };

export class LineWebhookServer {
  readonly #options: LineWebhookServerOptions;
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();
  readonly #scope = Scope.makeUnsafe();
  #server: Server | null = null;

  constructor(options: LineWebhookServerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get port(): number {
    const address = this.#server?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }

  readonly start = Effect.fn("LineWebhookServer.start")(function* (this: LineWebhookServer) {
    if (this.#server) return this.port;
    const timeout = this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const server = createServer(
      { headersTimeout: timeout, requestTimeout: timeout, keepAliveTimeout: 5_000 },
      (request, response) => void this.#handle(request, response),
    );
    server.maxConnections = LINE_WEBHOOK_MAX_CONNECTIONS;
    const port = yield* serverIo(() => listen(server, this.#options.host ?? "127.0.0.1", this.#options.port ?? 0));
    this.#server = server;
    yield* Scope.addFinalizer(this.#scope, this.#close(server));
    logger.info("The LINE webhook server started.");
    return port;
  });

  readonly stop = Effect.fn("LineWebhookServer.stop")(function* (this: LineWebhookServer) {
    yield* Scope.close(this.#scope, Exit.void);
  });

  #close(server: Server): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      this.#server = null;
      this.#seen.clear();
      server.close(() => resume(Effect.void));
      server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== LINE_WEBHOOK_PATH) return reply(response, 404);
      if (request.method !== "POST") return reply(response, 405, { allow: "POST" });
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > LINE_WEBHOOK_BODY_LIMIT_BYTES) {
        response.once("finish", () => request.destroy());
        return reply(response, 413);
      }
      const read = await readBody(request, this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      if (read.type === "aborted") return;
      if (read.type === "too_large") return reply(response, 413);
      if (read.type === "timeout") return reply(response, 408);
      const signature = request.headers["x-line-signature"];
      const header = typeof signature === "string" ? signature : null;
      if (!verifyLineSignature(read.bytes, header, this.#options.channelSecret())) return reply(response, 401);
      this.#signed();
      const payload = parseLineWebhook(read.bytes);
      if (!payload) return reply(response, 400);
      const fresh = payload.events.filter((event) => this.#fresh(event));
      reply(response, 200);
      if (fresh.length > 0) this.#deliver(fresh, payload.destination);
    } catch {
      if (!response.headersSent) reply(response, 500);
      else response.destroy();
    }
  }

  #signed(): void {
    try {
      this.#options.onSigned?.();
    } catch {
      logger.warn("A LINE webhook hook failed.");
    }
  }

  #fresh(event: LineWebhookEvent): boolean {
    if (event.type !== "text") return true;
    const now = this.#now();
    for (const [id, seenAt] of this.#seen) {
      if (now - seenAt <= LINE_SEEN_EVENTS_MAX_AGE_MS) break;
      this.#seen.delete(id);
    }
    const id = event.event.webhookEventId;
    if (this.#seen.has(id)) return false;
    this.#seen.set(id, now);
    if (this.#seen.size > LINE_SEEN_EVENTS_LIMIT) {
      const oldest = this.#seen.keys().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
    return true;
  }

  #deliver(events: readonly LineWebhookEvent[], destination: string): void {
    const failed = () => logger.warn("A LINE webhook sink failed.");
    try {
      const result = this.#options.onEvents(events, destination);
      if (result) Promise.resolve(result).catch(failed);
    } catch {
      failed();
    }
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("The LINE webhook server has no port."));
      else resolve(address.port);
    });
  });
}

function readBody(request: IncomingMessage, timeoutMs: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    const finish = (result: BodyRead) => {
      clearTimeout(timer);
      request.removeAllListeners("data");
      resolve(result);
    };
    const timer = setTimeout(() => finish({ type: "timeout" }), timeoutMs);
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT_BYTES) {
        request.destroy();
        return finish({ type: "aborted" });
      }
      if (size > LINE_WEBHOOK_BODY_LIMIT_BYTES) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    request.once("end", () =>
      finish(tooLarge ? { type: "too_large" } : { type: "body", bytes: Buffer.concat(chunks) }),
    );
    request.once("error", () => finish({ type: "aborted" }));
    request.once("close", () => finish({ type: "aborted" }));
  });
}

function reply(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-length": "0",
    connection: status === 200 ? "keep-alive" : "close",
    ...headers,
  });
  response.end();
}
