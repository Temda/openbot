import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { LineApi, lineApiFailure } from "../src/backend/messaging/line/line-api";
import { type LineWebhookEvent, lineInboundMessage } from "../src/backend/messaging/line/line-events";
import { LINE_MESSAGES_PER_CALL, LINE_TEXT_LIMIT, lineMessageBatches } from "../src/backend/messaging/line/line-render";
import {
  LINE_WEBHOOK_BODY_LIMIT_BYTES,
  LINE_WEBHOOK_MAX_CONNECTIONS,
  LINE_WEBHOOK_PATH,
  LineWebhookServer,
} from "../src/backend/messaging/line/line-webhook-server";

const OUT = resolve(import.meta.dirname, "../.openbot-build");
const REPORT = join(OUT, "line-webhook-e2e.json");

const channelSecret = randomBytes(16).toString("hex");
const accessToken = randomBytes(24).toString("base64url");

interface CaseResult {
  name: string;
  passed: boolean;
  observed: unknown;
}

const results: CaseResult[] = [];

async function check(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    results.push({ name, passed: true, observed: await run() });
  } catch (error) {
    results.push({ name, passed: false, observed: error instanceof Error ? error.message : String(error) });
  }
}

function sign(body: string | Uint8Array, secret = channelSecret): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function textEvent(id: string, text: string, userId = "U1234567890abcdef") {
  return {
    type: "message",
    mode: "active",
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    timestamp: 1_700_000_000_000,
    source: { type: "user", userId },
    replyToken: `reply-${id}`,
    message: { type: "text", id: `m-${id}`, text },
  };
}

function webhookBody(events: unknown[]): string {
  return JSON.stringify({ destination: "Ubotdestination", events });
}

const received: Array<{ events: readonly LineWebhookEvent[]; destination: string }> = [];
let notify: (() => void) | null = null;

function nextDelivery(): Promise<void> {
  return new Promise((resolveNext) => {
    notify = resolveNext;
  });
}

const webhook = new LineWebhookServer({
  channelSecret: () => channelSecret,
  onEvents: (events, destination) => {
    received.push({ events, destination });
    notify?.();
    notify = null;
  },
});
const webhookPort = await runCauseEffect(webhook.start());
const webhookUrl = `http://127.0.0.1:${webhookPort}${LINE_WEBHOOK_PATH}`;

interface FakeRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  retryKey: string | undefined;
  body: string;
}

const fakeRequests: FakeRequest[] = [];
let fakeAnswer: { status: number; headers?: Record<string, string>; body: unknown } | null = null;

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const fakeApi: Server = createServer((request, response) => {
  void (async () => {
    const body = await readText(request);
    fakeRequests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      retryKey: request.headers["x-line-retry-key"]?.toString(),
      body,
    });
    const answer = fakeAnswer ?? { status: 200, body: {} };
    response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    response.end(JSON.stringify(answer.body));
  })();
});
await new Promise<void>((done) => fakeApi.listen(0, "127.0.0.1", done));
const fakeAddress = fakeApi.address();
assert.ok(fakeAddress && typeof fakeAddress !== "string");
const fakePort = fakeAddress.port;
const api = new LineApi({ token: accessToken, origin: `http://127.0.0.1:${fakePort}` });

async function post(body: string, headers: Record<string, string> = {}) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    body: typeof body === "string" ? body : new Blob([body]),
    headers,
  });
  await response.text();
  return response.status;
}

async function signedPost(body: string): Promise<number> {
  return post(body, { "x-line-signature": sign(body) });
}

async function deliveredAfter(
  send: () => Promise<number>,
): Promise<{ status: number; events: readonly LineWebhookEvent[] }> {
  const before = received.length;
  const arrival = nextDelivery();
  const status = await send();
  if (received.length === before) await arrival;
  return { status, events: received[received.length - 1]?.events ?? [] };
}

async function until<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((next) => setTimeout(next, 25));
  }
}

async function nothingDelivered(send: () => Promise<number>): Promise<number> {
  const before = received.length;
  const status = await send();
  assert.equal(received.length, before, "the sink must receive nothing");
  return status;
}

await check("valid signed text message", async () => {
  const { status, events } = await deliveredAfter(() => signedPost(webhookBody([textEvent("01A", "hello")])));
  assert.equal(status, 200);
  assert.equal(events.length, 1);
  const first = events[0];
  assert.ok(first && first.type === "text");
  assert.equal(first.event.userId, "U1234567890abcdef");
  assert.equal(first.event.text, "hello");
  assert.equal(first.replyToken, "reply-01A");
  const inbound = lineInboundMessage(first.event);
  assert.equal(inbound.platformChannelId, "U1234567890abcdef");
  assert.equal(inbound.threadKey, "dm");
  assert.equal(inbound.isDirect, true);
  assert.equal(inbound.dedupKey, "01A");
  assert.equal(inbound.target.replyThreadId, "dm:m-01A");
  assert.ok(!JSON.stringify(inbound).includes("reply-01A"));
  return { status, userId: first.event.userId, text: first.event.text };
});

await check("wrong signature gives 401", async () => {
  const body = webhookBody([textEvent("02A", "x")]);
  const status = await nothingDelivered(() => post(body, { "x-line-signature": sign(body, "another-secret") }));
  assert.equal(status, 401);
  return { status };
});

await check("missing signature gives 401", async () => {
  const status = await nothingDelivered(() => post(webhookBody([textEvent("03A", "x")])));
  assert.equal(status, 401);
  return { status };
});

await check("malformed Base64 signature gives 401", async () => {
  const body = webhookBody([textEvent("04A", "x")]);
  const valid = sign(body);
  const nonCanonical = `${valid.slice(0, 42)}${valid[42] === "A" ? "B" : "A"}=`;
  const statuses: number[] = [];
  for (const signature of ["not base64!!", valid.slice(0, 20), `${valid}AA`, nonCanonical, " "])
    statuses.push(await nothingDelivered(() => post(body, { "x-line-signature": signature })));
  assert.deepEqual(statuses, [401, 401, 401, 401, 401]);
  return { statuses };
});

await check("body changed after signing gives 401", async () => {
  const body = webhookBody([textEvent("05A", "original")]);
  const status = await nothingDelivered(() =>
    post(body.replace("original", "changed"), { "x-line-signature": sign(body) }),
  );
  assert.equal(status, 401);
  return { status };
});

await check("signed invalid JSON gives 400", async () => {
  const statuses: number[] = [];
  for (const body of ["{not json", JSON.stringify({ destination: "U", events: "no" }), "[]"])
    statuses.push(await nothingDelivered(() => signedPost(body)));
  assert.deepEqual(statuses, [400, 400, 400]);
  return { statuses };
});

await check("empty events (console Verify) gives 200", async () => {
  const status = await nothingDelivered(() => signedPost(webhookBody([])));
  assert.equal(status, 200);
  return { status };
});

await check("the same webhookEventId twice reaches the sink once", async () => {
  const body = webhookBody([textEvent("06A", "again")]);
  const first = await deliveredAfter(() => signedPost(body));
  const before = received.length;
  const secondStatus = await signedPost(body);
  const marker = await deliveredAfter(() => signedPost(webhookBody([textEvent("06B", "marker")])));
  assert.equal(first.status, 200);
  assert.equal(secondStatus, 200);
  assert.equal(marker.status, 200);
  assert.equal(received.length, before + 1, "only the marker follows the duplicate");
  return { firstStatus: first.status, secondStatus, deliveriesAfterDuplicate: received.length - before };
});

await check("unsupported events are ignored with a reason", async () => {
  const events = [
    { ...textEvent("07A", "group"), source: { type: "group", groupId: "G1", userId: "U9" } },
    { ...textEvent("07B", "x"), message: { type: "sticker", id: "9", packageId: "1", stickerId: "2" } },
    { type: "follow", mode: "active", webhookEventId: "07C", timestamp: 1, source: { type: "user", userId: "U1" } },
    { ...textEvent("07D", "standby"), mode: "standby" },
    "garbage",
  ];
  const { status, events: got } = await deliveredAfter(() => signedPost(webhookBody(events)));
  assert.equal(status, 200);
  const reasons = got.map((event) => (event.type === "ignored" ? event.reason : "text"));
  assert.deepEqual(reasons, [
    "group_or_room_source",
    "unsupported_message_type",
    "unsupported_event_type",
    "standby_mode",
    "malformed_event",
  ]);
  return { status, reasons };
});

await check("a failing sink does not change the 200", async () => {
  const failing = new LineWebhookServer({
    channelSecret: () => channelSecret,
    onEvents: () => {
      throw new Error("sink failed");
    },
  });
  const port = await runCauseEffect(failing.start());
  try {
    const url = `http://127.0.0.1:${port}${LINE_WEBHOOK_PATH}`;
    const body = webhookBody([textEvent("08A", "x")]);
    const response = await fetch(url, { method: "POST", body, headers: { "x-line-signature": sign(body) } });
    await response.text();
    assert.equal(response.status, 200);
    const again = await fetch(url, { method: "POST", body: "x" });
    await again.text();
    assert.equal(again.status, 401);
    return { status: response.status, stillServing: again.status };
  } finally {
    await runCauseEffect(failing.stop());
  }
});

await check("body over the limit gives 413", async () => {
  const body = "a".repeat(LINE_WEBHOOK_BODY_LIMIT_BYTES + 1);
  const status = await nothingDelivered(() => post(body, { "x-line-signature": sign(body) }));
  assert.equal(status, 413);
  return { status, bytes: body.length };
});

function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolveExchange, rejectExchange) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk.toString("utf8");
      if (answer.includes("\r\n\r\n")) {
        socket.destroy();
        resolveExchange(answer);
      }
    });
    socket.once("error", rejectExchange);
    socket.once("close", () => resolveExchange(answer));
  });
}

await check("a declared content-length over the limit gives 413 at once", async () => {
  const before = received.length;
  const answer = await rawExchange(
    webhookPort,
    `POST ${LINE_WEBHOOK_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${LINE_WEBHOOK_BODY_LIMIT_BYTES * 2}\r\n\r\n`,
  );
  assert.match(answer, /^HTTP\/1\.1 413/u);
  assert.equal(received.length, before);
  return { statusLine: answer.split("\r\n")[0] };
});

await check("connections above the bound are dropped and a normal request still works", async () => {
  const bounded = new LineWebhookServer({ channelSecret: () => channelSecret, onEvents: () => undefined });
  const port = await runCauseEffect(bounded.start());
  const held: Socket[] = [];
  try {
    for (let index = 0; index < LINE_WEBHOOK_MAX_CONNECTIONS; index += 1)
      held.push(
        await new Promise<Socket>((opened, failed) => {
          const socket = connect(port, "127.0.0.1", () => opened(socket));
          socket.once("error", failed);
        }),
      );
    const extra = await new Promise<string>((done) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("data", () => done("answered"));
      socket.once("error", () => done("dropped"));
      socket.once("close", () => done("dropped"));
    });
    assert.equal(extra, "dropped");
    for (const socket of held) socket.destroy();
    held.length = 0;
    const body = "{}";
    const status = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${port}${LINE_WEBHOOK_PATH}`, {
        method: "POST",
        body,
        headers: { "x-line-signature": sign(body) },
      }).catch(() => null);
      await response?.text();
      return response?.status ?? null;
    });
    assert.equal(status, 400);
    return { bound: LINE_WEBHOOK_MAX_CONNECTIONS, extra, afterRelease: status };
  } finally {
    for (const socket of held) socket.destroy();
    await runCauseEffect(bounded.stop());
  }
});

await check("onSigned runs only for a correctly signed request", async () => {
  let signed = 0;
  const watched = new LineWebhookServer({
    channelSecret: () => channelSecret,
    onEvents: () => undefined,
    onSigned: () => {
      signed += 1;
    },
  });
  const port = await runCauseEffect(watched.start());
  try {
    const body = webhookBody([]);
    const url = `http://127.0.0.1:${port}${LINE_WEBHOOK_PATH}`;
    const wrong = await fetch(url, { method: "POST", body, headers: { "x-line-signature": sign(body, "other") } });
    await wrong.text();
    assert.equal(wrong.status, 401);
    assert.equal(signed, 0);
    const right = await fetch(url, { method: "POST", body, headers: { "x-line-signature": sign(body) } });
    await right.text();
    assert.equal(right.status, 200);
    assert.equal(signed, 1);
    return { wrong: wrong.status, right: right.status, signed };
  } finally {
    await runCauseEffect(watched.stop());
  }
});

await check("wrong path gives 404 and GET gives 405", async () => {
  const wrongPath = await fetch(`http://127.0.0.1:${webhookPort}/other`, { method: "POST", body: "{}" });
  const root = await fetch(`http://127.0.0.1:${webhookPort}/`);
  const get = await fetch(webhookUrl);
  await Promise.all([wrongPath.text(), root.text(), get.text()]);
  assert.deepEqual([wrongPath.status, root.status, get.status], [404, 404, 405]);
  return { wrongPath: wrongPath.status, root: root.status, get: get.status };
});

await check("reply reaches the API with the Bearer header and JSON", async () => {
  fakeRequests.length = 0;
  fakeAnswer = { status: 200, body: { sentMessages: [{ id: "100" }] } };
  const ids = await runCauseEffect(api.reply("token-1", [{ type: "text", text: "hi" }]));
  const request = fakeRequests[0];
  assert.equal(request?.method, "POST");
  assert.equal(request?.url, "/v2/bot/message/reply");
  assert.equal(request?.authorization, `Bearer ${accessToken}`);
  assert.deepEqual(JSON.parse(request?.body ?? "null"), {
    replyToken: "token-1",
    messages: [{ type: "text", text: "hi" }],
  });
  return { url: request?.url, ids };
});

await check("push carries X-Line-Retry-Key", async () => {
  fakeRequests.length = 0;
  fakeAnswer = { status: 200, body: { sentMessages: [{ id: "101" }] } };
  const retryKey = randomUUID();
  await runCauseEffect(api.push("U1", [{ type: "text", text: "hi" }], retryKey));
  const request = fakeRequests[0];
  assert.equal(request?.url, "/v2/bot/message/push");
  assert.equal(request?.retryKey, retryKey);
  assert.deepEqual(JSON.parse(request?.body ?? "null"), { to: "U1", messages: [{ type: "text", text: "hi" }] });
  return { retryKeyForwarded: request?.retryKey === retryKey };
});

await check("bot info, profile and webhook endpoint calls decode", async () => {
  fakeRequests.length = 0;
  fakeAnswer = { status: 200, body: { userId: "Ubot", basicId: "@bot", displayName: "Bot", pictureUrl: "x" } };
  const info = await runCauseEffect(api.botInfo());
  fakeAnswer = { status: 200, body: { userId: "U1", displayName: "Ann" } };
  const profile = await runCauseEffect(api.profile("U1"));
  fakeAnswer = { status: 200, body: { endpoint: "https://example.test/line/webhook", active: true } };
  const endpoint = await runCauseEffect(api.webhookEndpoint());
  fakeAnswer = { status: 200, body: {} };
  await runCauseEffect(api.setWebhookEndpoint("https://example.test/line/webhook"));
  fakeAnswer = { status: 200, body: { success: true, timestamp: "t", statusCode: 200, reason: "OK", detail: "200" } };
  const test = await runCauseEffect(api.testWebhook());
  assert.equal(info.basicId, "@bot");
  assert.equal(profile.displayName, "Ann");
  assert.equal(endpoint.active, true);
  assert.equal(test.success, true);
  assert.deepEqual(
    fakeRequests.map((request) => `${request.method} ${request.url}`),
    [
      "GET /v2/bot/info",
      "GET /v2/bot/profile/U1",
      "GET /v2/bot/channel/webhook/endpoint",
      "PUT /v2/bot/channel/webhook/endpoint",
      "POST /v2/bot/channel/webhook/test",
    ],
  );
  return { calls: fakeRequests.length };
});

async function classify(status: number, body: unknown, headers?: Record<string, string>) {
  fakeAnswer = { status, body, ...(headers ? { headers } : {}) };
  const result = await Effect.runPromise(Effect.result(api.reply("t", [{ type: "text", text: "x" }])));
  assert.equal(result._tag, "Failure");
  const error = result._tag === "Failure" ? lineApiFailure(result.failure) : null;
  assert.ok(error);
  assert.ok(!error.message.includes(accessToken));
  return { status, failure: error.failure, retryAfterMs: error.retryAfterMs };
}

await check("API errors are classified", async () => {
  const observed = [
    await classify(401, { message: "Authentication failed" }),
    await classify(429, { message: "slow down" }, { "retry-after": "7" }),
    await classify(429, { message: "You have reached your monthly limit." }),
    await classify(400, { message: "Invalid reply token" }),
    await classify(400, { message: "The request body has 1 error(s)" }),
    await classify(500, { message: "oops" }),
    await classify(409, {}),
  ];
  assert.deepEqual(
    observed.map((entry) => entry.failure),
    [
      "invalid_token",
      "rate_limited",
      "quota_exceeded",
      "invalid_reply_token",
      "rejected",
      "retryable",
      "already_accepted",
    ],
  );
  assert.equal(observed[1]?.retryAfterMs, 7000);
  return observed;
});

await check("an unreachable API is retryable", async () => {
  const dead = new LineApi({ token: accessToken, origin: "http://127.0.0.1:1" });
  const result = await Effect.runPromise(Effect.result(dead.botInfo()));
  assert.equal(result._tag, "Failure");
  const error = result._tag === "Failure" ? lineApiFailure(result.failure) : null;
  assert.equal(error?.failure, "retryable");
  return { failure: error?.failure };
});

await check("render splits a long Markdown answer", async () => {
  const paragraph = `${"**Bold** text with [a link](https://example.test) and more words. ".repeat(40)}\n\n`;
  const code = `\`\`\`ts\n${"const a = 1;\n".repeat(900)}\`\`\`\n`;
  const batches = lineMessageBatches(`# Title\n\n${paragraph.repeat(30)}${code}`);
  const messages = batches.flat();
  assert.ok(messages.length > LINE_MESSAGES_PER_CALL, "the answer needs more than one batch");
  assert.ok(batches.every((batch) => batch.length >= 1 && batch.length <= LINE_MESSAGES_PER_CALL));
  assert.ok(messages.every((message) => message.text.length > 0 && message.text.length <= LINE_TEXT_LIMIT));
  assert.ok(!messages.some((message) => message.text.includes("**") || message.text.includes("```")));
  assert.ok(messages[0]?.text.startsWith("Title"));
  return {
    batches: batches.length,
    messages: messages.length,
    longest: Math.max(...messages.map((message) => message.text.length)),
  };
});

await check("after stop the port refuses connections", async () => {
  await runCauseEffect(webhook.stop());
  const outcome = await fetch(webhookUrl, { method: "POST", body: "{}" }).then(
    (response) => `status ${response.status}`,
    () => "connection refused",
  );
  assert.equal(outcome, "connection refused");
  return { outcome };
});

await new Promise<void>((done) => {
  fakeApi.close(() => done());
  fakeApi.closeAllConnections();
});

const failed = results.filter((result) => !result.passed);
mkdirSync(OUT, { recursive: true });
writeFileSync(
  REPORT,
  `${JSON.stringify({ passed: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`,
);
process.stdout.write(
  `LINE webhook check: ${results.length - failed.length}/${results.length} passed. Report: ${REPORT}\n`,
);
for (const result of failed) process.stdout.write(`FAILED ${result.name}: ${JSON.stringify(result.observed)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
