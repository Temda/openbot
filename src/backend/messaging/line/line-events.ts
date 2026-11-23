import { Option, Schema } from "effect";
import type { InboundMessage } from "../messaging-types";

export const LINE_DIRECT_THREAD = "dm";

const LineTextMessageEvent = Schema.Struct({
  type: Schema.Literal("message"),
  mode: Schema.optional(Schema.String),
  webhookEventId: Schema.String.check(Schema.isMinLength(1)),
  deliveryContext: Schema.optional(Schema.Struct({ isRedelivery: Schema.Boolean })),
  timestamp: Schema.Number,
  source: Schema.Struct({ type: Schema.Literal("user"), userId: Schema.String.check(Schema.isMinLength(1)) }),
  replyToken: Schema.optional(Schema.String),
  message: Schema.Struct({ type: Schema.Literal("text"), id: Schema.String, text: Schema.String }),
});

const LineWebhookBody = Schema.Struct({
  destination: Schema.String,
  events: Schema.Array(Schema.Unknown),
});

const LooseEvent = Schema.Struct({
  type: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
  message: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
});

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(LineWebhookBody));
const decodeTextEvent = Schema.decodeUnknownOption(LineTextMessageEvent);
const decodeLooseEvent = Schema.decodeUnknownOption(LooseEvent);

export type LineIgnoredReason =
  | "standby_mode"
  | "group_or_room_source"
  | "unsupported_source"
  | "unsupported_event_type"
  | "unsupported_message_type"
  | "malformed_event";

export interface LineTextEvent {
  webhookEventId: string;
  isRedelivery: boolean;
  timestamp: number;
  userId: string;
  messageId: string;
  text: string;
}

export type LineWebhookEvent =
  | { type: "text"; event: LineTextEvent; replyToken: string | null }
  | { type: "ignored"; reason: LineIgnoredReason };

export interface LineWebhookPayload {
  destination: string;
  events: LineWebhookEvent[];
}

export function parseLineWebhook(rawBody: Uint8Array): LineWebhookPayload | null {
  const body = decodeBody(decodeUtf8(rawBody));
  if (Option.isNone(body)) return null;
  return { destination: body.value.destination, events: body.value.events.map(lineEventOf) };
}

export function lineEventOf(value: unknown): LineWebhookEvent {
  const loose = Option.getOrNull(decodeLooseEvent(value));
  if (loose?.mode === "standby") return ignored("standby_mode");
  const text = decodeTextEvent(value);
  if (Option.isSome(text)) {
    const event = text.value;
    return {
      type: "text",
      event: {
        webhookEventId: event.webhookEventId,
        isRedelivery: event.deliveryContext?.isRedelivery ?? false,
        timestamp: event.timestamp,
        userId: event.source.userId,
        messageId: event.message.id,
        text: event.message.text,
      },
      replyToken: event.replyToken || null,
    };
  }
  return ignored(ignoredReason(loose));
}

export function lineInboundMessage(event: LineTextEvent): InboundMessage {
  return {
    dedupKey: event.webhookEventId,
    platformChannelId: event.userId,
    threadKey: LINE_DIRECT_THREAD,
    target: { platformChannelId: event.userId, replyThreadId: `${LINE_DIRECT_THREAD}:${event.messageId}` },
    platformMessageId: event.messageId,
    isDirect: true,
    requiresLink: false,
    authorId: event.userId,
    text: event.text,
    mentionedUserIds: [],
    files: [],
  };
}

function ignoredReason(loose: typeof LooseEvent.Type | null): LineIgnoredReason {
  if (loose?.type !== "message") return loose?.type === undefined ? "malformed_event" : "unsupported_event_type";
  const source = loose.source?.type;
  if (source === "group" || source === "room") return "group_or_room_source";
  if (source !== "user") return "unsupported_source";
  return loose.message?.type === "text" ? "malformed_event" : "unsupported_message_type";
}

function ignored(reason: LineIgnoredReason): LineWebhookEvent {
  return { type: "ignored", reason };
}

function decodeUtf8(rawBody: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return "";
  }
}
