import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result } from "effect";
import type { ConnectionIdentity, MessagingTransport, TransportSink } from "../messaging-types";
import type { LineCredentials } from "./line-credentials";
import { type LineWebhookEvent, lineInboundMessage } from "./line-events";
import type { LineRuntime } from "./line-runtime";
import { LineWebhookServer } from "./line-webhook-server";

const logger = createOpenBotLogger("line");

const APPROVE_TEXT = /^(1|approve|yes)$/iu;
const DECLINE_TEXT = /^(2|deny|no)$/iu;
const PROFILE_TIMEOUT_MS = 5_000;

export interface LineTransportOptions {
  runtime: LineRuntime;
  credentials: LineCredentials;
  identity: ConnectionIdentity;
}

export class LineTransport implements MessagingTransport {
  readonly #runtime: LineRuntime;
  readonly #credentials: LineCredentials;
  readonly #workspaceId: string;
  #sink: TransportSink | null = null;
  #server: LineWebhookServer | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(options: LineTransportOptions) {
    this.#runtime = options.runtime;
    this.#credentials = options.credentials;
    this.#workspaceId = options.identity.workspaceId;
  }

  start(sink: TransportSink): void {
    this.#sink = sink;
    this.#unsubscribe = this.#runtime.onQuota(this.#workspaceId, (exceeded) => {
      if (this.#server) sink.state(exceeded ? "error" : "connected");
    });
    this.#listen(sink);
  }

  reconnect(): void {
    const sink = this.#sink;
    if (sink && !this.#server) this.#listen(sink);
  }

  readonly stop = Effect.fn("LineTransport.stop")(function* (this: LineTransport) {
    this.#sink = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const server = this.#server;
    this.#server = null;
    if (server) yield* server.stop();
  });

  #listen(sink: TransportSink): void {
    const server = new LineWebhookServer({
      port: this.#credentials.webhookPort,
      channelSecret: () => this.#credentials.channelSecret,
      onEvents: (events) => this.#events(events),
      onSigned: () => this.#runtime.markVerified(this.#workspaceId),
    });
    this.#server = server;
    sink.state("connecting");
    void Effect.runPromise(Effect.result(server.start())).then(async (result) => {
      if (this.#server !== server) {
        await Effect.runPromise(server.stop());
        return;
      }
      if (Result.isFailure(result)) {
        this.#server = null;
        logger.warn("The LINE webhook port is not available.");
        sink.state("error");
        return;
      }
      sink.state(this.#runtime.quotaExceeded(this.#workspaceId) ? "error" : "connected");
    });
  }

  async #events(events: readonly LineWebhookEvent[]): Promise<void> {
    for (const event of events) if (event.type === "text") await this.#text(event);
  }

  async #text(event: Extract<LineWebhookEvent, { type: "text" }>): Promise<void> {
    const sink = this.#sink;
    if (!sink) return;
    const { userId, messageId, text } = event.event;
    if (!this.#runtime.policy.rules(this.#workspaceId).contacts.has(userId)) return this.#request(event);
    const message = lineInboundMessage(event.event);
    const decision = APPROVE_TEXT.test(text.trim()) ? "accept" : DECLINE_TEXT.test(text.trim()) ? "decline" : null;
    const menu = decision ? this.#runtime.latestMenu(userId) : null;
    const button = menu?.menu.buttons.find((candidate) => candidate.action === decision);
    if (menu && button && (decision === "accept" || decision === "decline")) {
      sink.action({
        type: "approval",
        decision,
        token: button.token,
        actorId: userId,
        target: message.target,
        platformMessageId: menu.messageId,
      });
      return;
    }
    if (event.replyToken) this.#runtime.rememberReplyToken(messageId, event.replyToken);
    sink.message(message);
  }

  async #request(event: Extract<LineWebhookEvent, { type: "text" }>): Promise<void> {
    const { userId } = event.event;
    const request = this.#runtime.policy.request(this.#workspaceId, userId);
    if (!request?.created || !event.replyToken) return;
    const api = this.#runtime.api(this.#credentials.channelAccessToken);
    await Effect.runPromise(
      api.reply(event.replyToken, [{ type: "text", text: sourceText("status.messaging.linePairingNotice") }]).pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      ),
    );
    const name = await Effect.runPromise(
      api.profile(userId).pipe(
        Effect.map((profile) => profile.displayName),
        Effect.timeoutOrElse({ duration: PROFILE_TIMEOUT_MS, orElse: () => Effect.succeed("") }),
        Effect.orElseSucceed(() => ""),
      ),
    );
    this.#runtime.policy.nameRequest(this.#workspaceId, userId, name);
  }
}
