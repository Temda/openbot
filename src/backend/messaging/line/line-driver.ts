import { randomUUID } from "node:crypto";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type { MessagingAnswerFile } from "../messaging-threads";
import {
  type ConnectionIdentity,
  type ContextEntry,
  type InboundFile,
  type MessageBody,
  type MessageTarget,
  type MessagingAdapter,
  MessagingAdapterError,
  MessagingConnectionError,
  type MessagingDriver,
  type MessagingDriverOptions,
  type MessagingPlaces,
  type RecentMessages,
  type StatusReaction,
} from "../messaging-types";
import { type LineApi, lineApiFailure } from "./line-api";
import { type LineCredentials, lineCredentials } from "./line-credentials";
import { type LineTextMessage, lineMessageBatches } from "./line-render";
import type { LineRuntime } from "./line-runtime";
import { LINE_PLACE_NOT_ALLOWED } from "./line-senders";
import { LineTransport } from "./line-transport";

const PUSH_ATTEMPTS = 3;
const PUSH_BACKOFF_MS = 500;
const PROFILE_CACHE_LIMIT = 500;
const NO_HISTORY_NOTE =
  "LINE sends no older messages to OpenBot, and OpenBot does not save them. The history of this chat is not available: ask the user when you need an earlier message.";

function messageIdOf(target: MessageTarget): string | null {
  const thread = target.replyThreadId;
  if (!thread) return null;
  const separator = thread.indexOf(":");
  return separator < 0 ? null : thread.slice(separator + 1) || null;
}

class LineAdapter implements MessagingAdapter {
  readonly platform = "line" as const;
  readonly #runtime: LineRuntime;
  readonly #credentials: LineCredentials;
  readonly #api: LineApi;
  readonly #rateLimited: MessagingDriverOptions["rateLimited"];
  readonly #names = new Map<string, string>();

  constructor(runtime: LineRuntime, credentials: LineCredentials, rateLimited: MessagingDriverOptions["rateLimited"]) {
    this.#runtime = runtime;
    this.#credentials = credentials;
    this.#api = runtime.api(credentials.channelAccessToken);
    this.#rateLimited = rateLimited;
  }

  identify(): Effect.Effect<ConnectionIdentity, MessagingAdapterError> {
    return this.#api.botInfo().pipe(
      Effect.map((info) => ({
        workspaceId: info.userId,
        workspaceName: info.displayName,
        botUserId: info.userId,
        appId: info.basicId,
        missingScopes: [],
      })),
      Effect.mapError((failure) =>
        lineApiFailure(failure)?.failure === "invalid_token"
          ? new MessagingAdapterError({ cause: new MessagingConnectionError("invalid_token") })
          : failure,
      ),
    );
  }

  readonly post = Effect.fnUntraced(function* (this: LineAdapter, target: MessageTarget, body: MessageBody) {
    const actions = new Set(body.buttons?.map((button) => button.action));
    const approval = actions.has("accept") && actions.has("decline");
    if (body.buttons?.length && !approval) return "";
    yield* this.#checkPlace(target.platformChannelId);
    const text = approval ? `${body.text}\n\n${sourceText("status.messaging.whatsappApprovalMenu")}` : body.text;
    const ids = yield* this.#send(target.platformChannelId, null, lineMessageBatches(text));
    const id = ids[0] ?? `line-${randomUUID()}`;
    if (approval && body.buttons)
      this.#runtime.rememberMenu(id, {
        userId: target.platformChannelId,
        buttons: body.buttons.map((button) => ({ action: button.action, token: button.token })),
      });
    return id;
  });

  edit(_target: MessageTarget, messageId: string, body: MessageBody): Effect.Effect<void, MessagingAdapterError> {
    return Effect.sync(() => {
      if (!body.buttons?.length) this.#runtime.forgetMenu(messageId);
    });
  }

  postPrivate(target: MessageTarget, _userId: string, text: string): Effect.Effect<void, MessagingAdapterError> {
    return this.post(target, { text }).pipe(Effect.asVoid);
  }

  react(
    _target: MessageTarget,
    _messageId: string,
    _reaction: StatusReaction,
    _on: boolean,
  ): Effect.Effect<void, MessagingAdapterError> {
    return Effect.void;
  }

  readonly postAnswer = Effect.fnUntraced(function* (
    this: LineAdapter,
    target: MessageTarget,
    markdown: string,
    _replaceMessageId: string | null,
  ) {
    yield* this.#checkPlace(target.platformChannelId);
    const messageId = messageIdOf(target);
    const token = messageId ? this.#runtime.takeReplyToken(messageId) : null;
    const ids = yield* this.#send(target.platformChannelId, token, lineMessageBatches(markdown));
    return ids[0] ?? "";
  });

  upload(
    _target: MessageTarget,
    files: MessagingAnswerFile[],
  ): Effect.Effect<{ skipped: string[]; firstId: string | null }, MessagingAdapterError> {
    return Effect.succeed({ skipped: files.map((file) => file.name), firstId: null });
  }

  history(
    _platformChannelId: string,
    _threadKey: string,
    _afterId: string | null,
    _beforeId: string,
  ): Effect.Effect<ContextEntry[], MessagingAdapterError> {
    return Effect.succeed([]);
  }

  recent(
    _platformChannelId: string,
    _threadKey: string | null,
    _limit: number,
  ): Effect.Effect<RecentMessages, MessagingAdapterError> {
    return Effect.succeed({ messages: [], note: NO_HISTORY_NOTE });
  }

  download(_file: InboundFile, _destination: string, _maxBytes: number): Effect.Effect<void, MessagingAdapterError> {
    return Effect.fail(new MessagingAdapterError({ cause: new Error("file_unavailable") }));
  }

  authorName(userId: string): Effect.Effect<string, MessagingAdapterError> {
    const saved = this.#runtime.policy.rules(this.#credentials.workspaceId).contacts.get(userId);
    if (saved) return Effect.succeed(saved);
    const cached = this.#names.get(userId);
    if (cached) return Effect.succeed(cached);
    return this.#api.profile(userId).pipe(
      Effect.map((profile) => {
        this.#remember(userId, profile.displayName);
        return profile.displayName;
      }),
      Effect.orElseSucceed(() => userId),
    );
  }

  placeName(platformChannelId: string): Effect.Effect<string, MessagingAdapterError> {
    return this.authorName(platformChannelId);
  }

  places(): Effect.Effect<MessagingPlaces, MessagingAdapterError> {
    return Effect.sync(() => ({
      places: [...this.#runtime.policy.rules(this.#credentials.workspaceId).contacts].map(([id, name]) => ({
        id,
        name: name || this.#names.get(id) || id,
        kind: "chat" as const,
      })),
    }));
  }

  mention(userId: string): string {
    return this.#names.get(userId) ?? userId;
  }

  #remember(userId: string, name: string): void {
    this.#names.delete(userId);
    this.#names.set(userId, name);
    if (this.#names.size > PROFILE_CACHE_LIMIT) {
      const oldest = this.#names.keys().next();
      if (!oldest.done) this.#names.delete(oldest.value);
    }
  }

  #checkPlace(userId: string): Effect.Effect<void, MessagingAdapterError> {
    return Effect.suspend(() =>
      this.#runtime.policy.rules(this.#credentials.workspaceId).contacts.has(userId)
        ? Effect.void
        : Effect.fail(new MessagingAdapterError({ cause: new Error(LINE_PLACE_NOT_ALLOWED) })),
    );
  }

  #send(
    userId: string,
    replyToken: string | null,
    batches: readonly (readonly LineTextMessage[])[],
  ): Effect.Effect<string[], MessagingAdapterError> {
    return Effect.gen({ self: this }, function* () {
      const ids: string[] = [];
      for (const [index, batch] of batches.entries()) {
        const sent =
          index === 0 && replyToken ? yield* this.#reply(userId, replyToken, batch) : yield* this.#push(userId, batch);
        ids.push(...sent);
      }
      return ids;
    });
  }

  #reply(
    userId: string,
    replyToken: string,
    batch: readonly LineTextMessage[],
  ): Effect.Effect<string[], MessagingAdapterError> {
    return this.#api
      .reply(replyToken, batch)
      .pipe(
        Effect.catch((failure) =>
          lineApiFailure(failure)?.failure === "invalid_reply_token" ? this.#push(userId, batch) : Effect.fail(failure),
        ),
      );
  }

  #push(userId: string, batch: readonly LineTextMessage[]): Effect.Effect<string[], MessagingAdapterError> {
    return Effect.gen({ self: this }, function* () {
      const retryKey = randomUUID();
      for (let attempt = 1; ; attempt += 1) {
        const result = yield* Effect.result(this.#api.push(userId, batch, retryKey));
        if (Result.isSuccess(result)) {
          this.#runtime.setQuotaExceeded(this.#credentials.workspaceId, false);
          return result.success;
        }
        const failure = lineApiFailure(result.failure);
        if (failure?.failure === "already_accepted") return [];
        if (failure?.failure === "retryable" && attempt < PUSH_ATTEMPTS) {
          yield* Effect.sleep(PUSH_BACKOFF_MS * attempt);
          continue;
        }
        if (failure?.failure === "quota_exceeded") this.#runtime.setQuotaExceeded(this.#credentials.workspaceId, true);
        if (failure?.failure === "rate_limited" && failure.retryAfterMs !== null)
          this.#rateLimited(new Date(Date.now() + failure.retryAfterMs).toISOString());
        return yield* Effect.fail(result.failure);
      }
    });
  }
}

export interface LineDriverOptions {
  runtime: LineRuntime;
}

export function lineDriver(options: LineDriverOptions): MessagingDriver {
  const { runtime } = options;
  return {
    platform: "line",
    requiredCredential: "channelAccessToken",
    createAdapter(credentials, driverOptions) {
      return new LineAdapter(runtime, lineCredentials(credentials), driverOptions.rateLimited);
    },
    createTransport(credentials, identity) {
      return new LineTransport({ runtime, credentials: lineCredentials(credentials), identity });
    },
  };
}
