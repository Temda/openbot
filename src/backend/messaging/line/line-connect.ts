import { createServer } from "node:net";
import {
  type ConnectLineInput,
  type ConnectLineResult,
  type LineAccount,
  MESSAGING_LIMITS,
  parseLinePublicUrl,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import type { MessagingCredentials, MessagingOperationFailed } from "../messaging-service";
import type { MessagingStore } from "../messaging-store";
import { lineApiFailure } from "./line-api";
import { lineCredentials } from "./line-credentials";
import type { LinePolicy, LineRuntime, LineSenderRules } from "./line-runtime";
import { LineSenderRequests } from "./line-senders";
import { LINE_WEBHOOK_PATH } from "./line-webhook-server";

export class LineConnectFailed extends Schema.TaggedError<LineConnectFailed>()("LineConnectFailed", {
  cause: Schema.Defect(),
}) {}

export interface LineConnectHooks {
  prepare(workspaceId: string, workspaceName: string): Effect.Effect<string, MessagingOperationFailed>;
  finish(connectionId: string, values: Record<string, string>): Effect.Effect<void, MessagingOperationFailed>;
}

export interface LineConnectOptions {
  runtime: LineRuntime;
  store: MessagingStore;
  credentials: MessagingCredentials;
  hooks: LineConnectHooks;
}

const REASON_LIMIT = 128;

export class LineConnect implements LinePolicy {
  readonly #runtime: LineRuntime;
  readonly #store: MessagingStore;
  readonly #credentials: MessagingCredentials;
  readonly #hooks: LineConnectHooks;
  readonly #requests = new LineSenderRequests();

  constructor(options: LineConnectOptions) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#hooks = options.hooks;
    this.#runtime.setPolicy(this);
  }

  rules(workspaceId: string): LineSenderRules {
    const record = this.#store.connectionForWorkspace("line", workspaceId);
    if (!record) return { contacts: new Map() };
    return {
      contacts: new Map(
        this.#store
          .allowedSenders(record.connectionId)
          .filter((sender) => sender.kind === "contact")
          .map((sender) => [sender.id, sender.name]),
      ),
    };
  }

  request(workspaceId: string, senderId: string): { created: boolean } | null {
    const record = this.#store.connectionForWorkspace("line", workspaceId);
    if (!record?.enabled || this.#credentials.status(record.connectionId) !== "saved") return null;
    return this.#requests.request(workspaceId, senderId);
  }

  nameRequest(workspaceId: string, senderId: string, name: string): void {
    this.#requests.rename(workspaceId, senderId, name);
  }

  accounts(): LineAccount[] {
    return this.#store
      .connections()
      .filter((record) => record.platform === "line" && this.#credentials.status(record.connectionId) !== "missing")
      .map((record) => {
        const values = lineCredentials(this.#credentials.get(record.connectionId) ?? {});
        const webhook = this.#runtime.webhook(record.workspaceId);
        return {
          workspaceId: record.workspaceId,
          webhook: webhook.state,
          webhookReason: webhook.reason,
          webhookPort: values.webhookPort,
          localWebhookUrl: `http://127.0.0.1:${values.webhookPort}${LINE_WEBHOOK_PATH}`,
          publicUrl: values.publicUrl,
          quotaExceeded: this.#runtime.quotaExceeded(record.workspaceId),
          allowedSenders: this.#store
            .allowedSenders(record.connectionId)
            .filter((sender) => sender.kind === "contact")
            .slice(0, MESSAGING_LIMITS.allowedSenders)
            .map((sender) => ({ id: sender.id, name: sender.name || sender.id })),
          pendingRequests: this.#requests.list(record.workspaceId),
        };
      });
  }

  readonly connect = Effect.fn("LineConnect.connect")(function* (this: LineConnect, input: ConnectLineInput) {
    registerSecretValue(input.channelAccessToken);
    registerSecretValue(input.channelSecret);
    const info = yield* this.#runtime
      .api(input.channelAccessToken)
      .botInfo()
      .pipe(
        Effect.mapError((failure) =>
          failureError(
            lineApiFailure(failure)?.failure === "invalid_token"
              ? "error.messaging.lineInvalidToken"
              : "error.messaging.lineUnreachable",
          ),
        ),
      );
    const record = this.#store.connectionForWorkspace("line", info.userId);
    const earlier = record ? this.#credentials.get(record.connectionId) : null;
    const earlierPort = earlier ? lineCredentials(earlier).webhookPort : 0;
    const port = earlierPort || (yield* this.#freePort());
    const connectionId = yield* this.#hooks.prepare(info.userId, info.displayName);
    yield* this.#hooks.finish(connectionId, {
      channelAccessToken: input.channelAccessToken,
      channelSecret: input.channelSecret,
      workspaceId: info.userId,
      webhookPort: String(port),
      ...(earlier?.publicUrl ? { publicUrl: earlier.publicUrl } : {}),
    });
    this.#runtime.setWebhook(info.userId, { state: "unknown", reason: null });
    const result: ConnectLineResult = { workspaceId: info.userId };
    return result;
  });

  readonly setPublicUrl = Effect.fn("LineConnect.setPublicUrl")(function* (
    this: LineConnect,
    workspaceId: string,
    publicUrl: string | null,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const values = this.#credentials.get(connectionId);
    if (!values) return yield* failure("error.messaging.lineNotConnected");
    const normalized = publicUrl === null ? null : parseLinePublicUrl(publicUrl);
    if (publicUrl !== null && normalized === null) return yield* failure("error.messaging.linePublicUrlInvalid");
    const { publicUrl: _previous, ...rest } = values;
    yield* this.#credentials.set(connectionId, normalized ? { ...rest, publicUrl: normalized } : rest);
    if (!normalized) {
      this.#runtime.setWebhook(workspaceId, { state: "unknown", reason: null });
      return;
    }
    const api = this.#runtime.api(values.channelAccessToken ?? "");
    const tested = yield* Effect.result(
      api.setWebhookEndpoint(`${normalized}${LINE_WEBHOOK_PATH}`).pipe(Effect.andThen(api.testWebhook())),
    );
    if (Result.isSuccess(tested) && tested.success.success) this.#runtime.markVerified(workspaceId);
    else
      this.#runtime.setWebhook(workspaceId, {
        state: "failed",
        reason: (Result.isSuccess(tested)
          ? tested.success.reason
          : (lineApiFailure(tested.failure)?.failure ?? "unreachable")
        ).slice(0, REASON_LIMIT),
      });
  });

  readonly answerRequest = Effect.fn("LineConnect.answerRequest")(function* (
    this: LineConnect,
    workspaceId: string,
    senderId: string,
    approve: boolean,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const request = this.#requests.take(workspaceId, senderId);
    if (!request) return yield* failure("error.messaging.lineRequestEnded");
    if (!approve) return;
    if (this.#store.allowedSenders(connectionId).length >= MESSAGING_LIMITS.allowedSenders)
      return yield* failure("error.messaging.lineTooManySenders");
    this.#store.addAllowedSender(connectionId, { id: request.senderId, kind: "contact", name: request.name });
  });

  readonly removeSender = Effect.fn("LineConnect.removeSender")(function* (
    this: LineConnect,
    workspaceId: string,
    senderId: string,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    this.#store.removeAllowedSender(connectionId, senderId);
  });

  forget(workspaceId: string): void {
    this.#requests.clear(workspaceId);
    this.#runtime.forget(workspaceId);
  }

  #freePort(): Effect.Effect<number, LineConnectFailed> {
    return Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() =>
              address && typeof address !== "string" ? resolve(address.port) : reject(new Error("No port.")),
            );
          });
        }),
      catch: () => failureError("error.messaging.lineUnsupported"),
    });
  }

  #connectionId(workspaceId: string): Effect.Effect<string, LineConnectFailed> {
    const record = this.#store.connectionForWorkspace("line", workspaceId);
    return record && this.#credentials.status(record.connectionId) !== "missing"
      ? Effect.succeed(record.connectionId)
      : failure("error.messaging.lineNotConnected");
  }
}

type LineErrorKey =
  | "error.messaging.lineNotConnected"
  | "error.messaging.lineUnsupported"
  | "error.messaging.lineInvalidToken"
  | "error.messaging.lineUnreachable"
  | "error.messaging.lineTooManySenders"
  | "error.messaging.lineRequestEnded"
  | "error.messaging.linePublicUrlInvalid";

function failureError(key: LineErrorKey): LineConnectFailed {
  return new LineConnectFailed({ cause: new Error(sourceText(key)) });
}

function failure(key: LineErrorKey): Effect.Effect<never, LineConnectFailed> {
  return Effect.fail(failureError(key));
}
