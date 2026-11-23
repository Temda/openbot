import { Effect, Schema } from "effect";
import { MessagingAdapterError } from "../messaging-types";
import { LINE_MESSAGES_PER_CALL, type LineTextMessage } from "./line-render";

export const LINE_API_ORIGIN = "https://api.line.me";
const REQUEST_TIMEOUT_MS = 15_000;
const MONTHLY_LIMIT = /monthly limit/iu;

export type LineApiFailure =
  | "invalid_token"
  | "rate_limited"
  | "quota_exceeded"
  | "invalid_reply_token"
  | "already_accepted"
  | "retryable"
  | "rejected";

export class LineApiError extends Error {
  constructor(
    readonly operation: string,
    readonly failure: LineApiFailure,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`LINE ${operation} failed: ${failure}`);
    this.name = "LineApiError";
  }
}

export function lineApiFailure(error: MessagingAdapterError): LineApiError | null {
  return error.cause instanceof LineApiError ? error.cause : null;
}

export interface LineApiOptions {
  token: string;
  origin?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

const BotInfo = Schema.Struct({ userId: Schema.String, basicId: Schema.String, displayName: Schema.String });
const Profile = Schema.Struct({ displayName: Schema.String });
const Sent = Schema.Struct({
  sentMessages: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});
const WebhookEndpoint = Schema.Struct({ endpoint: Schema.String, active: Schema.Boolean });
const WebhookTest = Schema.Struct({
  success: Schema.Boolean,
  statusCode: Schema.Number,
  reason: Schema.String,
  detail: Schema.optional(Schema.String),
});
const ErrorBody = Schema.Struct({ message: Schema.optional(Schema.String) });
const Empty = Schema.Struct({});

export type LineBotInfo = typeof BotInfo.Type;
export type LineWebhookEndpoint = typeof WebhookEndpoint.Type;
export type LineWebhookTest = typeof WebhookTest.Type;

interface RequestSpec<S extends Schema.Top> {
  operation: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  schema: S;
  body?: unknown;
  headers?: Record<string, string>;
}

export class LineApi {
  readonly #token: string;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: LineApiOptions) {
    this.#token = options.token;
    this.#origin = options.origin ?? LINE_API_ORIGIN;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  readonly botInfo = Effect.fnUntraced(function* (this: LineApi) {
    return yield* this.#call({ operation: "bot info", method: "GET", path: "/v2/bot/info", schema: BotInfo });
  });

  readonly profile = Effect.fnUntraced(function* (this: LineApi, userId: string) {
    return yield* this.#call({
      operation: "profile",
      method: "GET",
      path: `/v2/bot/profile/${encodeURIComponent(userId)}`,
      schema: Profile,
    });
  });

  readonly reply = Effect.fnUntraced(function* (
    this: LineApi,
    replyToken: string,
    messages: readonly LineTextMessage[],
  ) {
    if (messages.length === 0 || messages.length > LINE_MESSAGES_PER_CALL) return yield* this.#refuse("reply");
    const sent = yield* this.#call({
      operation: "reply",
      method: "POST",
      path: "/v2/bot/message/reply",
      body: { replyToken, messages },
      schema: Sent,
    });
    return sent.sentMessages?.map((message) => message.id) ?? [];
  });

  readonly push = Effect.fnUntraced(function* (
    this: LineApi,
    to: string,
    messages: readonly LineTextMessage[],
    retryKey: string,
  ) {
    if (messages.length === 0 || messages.length > LINE_MESSAGES_PER_CALL) return yield* this.#refuse("push");
    const sent = yield* this.#call({
      operation: "push",
      method: "POST",
      path: "/v2/bot/message/push",
      body: { to, messages },
      headers: { "x-line-retry-key": retryKey },
      schema: Sent,
    });
    return sent.sentMessages?.map((message) => message.id) ?? [];
  });

  readonly webhookEndpoint = Effect.fnUntraced(function* (this: LineApi) {
    return yield* this.#call({
      operation: "webhook endpoint",
      method: "GET",
      path: "/v2/bot/channel/webhook/endpoint",
      schema: WebhookEndpoint,
    });
  });

  readonly setWebhookEndpoint = Effect.fnUntraced(function* (this: LineApi, endpoint: string) {
    yield* this.#call({
      operation: "set webhook endpoint",
      method: "PUT",
      path: "/v2/bot/channel/webhook/endpoint",
      body: { endpoint },
      schema: Empty,
    });
  });

  readonly testWebhook = Effect.fnUntraced(function* (this: LineApi, endpoint?: string) {
    return yield* this.#call({
      operation: "webhook test",
      method: "POST",
      path: "/v2/bot/channel/webhook/test",
      body: endpoint === undefined ? {} : { endpoint },
      schema: WebhookTest,
    });
  });

  #refuse(operation: string): Effect.Effect<never, MessagingAdapterError> {
    return Effect.fail(new MessagingAdapterError({ cause: new LineApiError(operation, "rejected", null) }));
  }

  #call<S extends Schema.Top>(
    spec: RequestSpec<S>,
  ): Effect.Effect<S["Type"], MessagingAdapterError, S["DecodingServices"]> {
    return Effect.tryPromise({
      try: (signal) => this.#exchange(spec, signal),
      catch: (cause) =>
        new MessagingAdapterError({
          cause: cause instanceof LineApiError ? cause : new LineApiError(spec.operation, "retryable", null),
        }),
    }).pipe(
      Effect.flatMap((payload) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(spec.schema))(payload).pipe(
          Effect.mapError(
            () => new MessagingAdapterError({ cause: new LineApiError(spec.operation, "rejected", 200) }),
          ),
        ),
      ),
    );
  }

  async #exchange<S extends Schema.Top>(spec: RequestSpec<S>, signal: AbortSignal): Promise<string> {
    const response = await this.#fetch(`${this.#origin}${spec.path}`, {
      method: spec.method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
        ...spec.headers,
      },
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    const text = await response.text();
    if (!response.ok) throw failureOf(spec.operation, response, text);
    return text || "{}";
  }
}

function failureOf(operation: string, response: Response, text: string): LineApiError {
  const status = response.status;
  if (status === 401) return new LineApiError(operation, "invalid_token", status);
  if (status === 409) return new LineApiError(operation, "already_accepted", status);
  if (status === 429 && MONTHLY_LIMIT.test(errorMessage(text)))
    return new LineApiError(operation, "quota_exceeded", status);
  if (status === 429) return new LineApiError(operation, "rate_limited", status, retryAfterMs(response));
  if (status >= 500) return new LineApiError(operation, "retryable", status);
  if (status === 400 && /invalid reply token/iu.test(errorMessage(text)))
    return new LineApiError(operation, "invalid_reply_token", status);
  return new LineApiError(operation, "rejected", status);
}

function errorMessage(text: string): string {
  try {
    return Schema.decodeUnknownSync(ErrorBody)(JSON.parse(text)).message ?? "";
  } catch {
    return "";
  }
}

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 && response.headers.get("retry-after") ? seconds * 1000 : null;
}
