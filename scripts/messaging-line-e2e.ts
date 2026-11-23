import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LineAccount, MessagingConnection } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { teeLogLines } from "@openbot/logging";
import { gc } from "bun";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { LineApiError } from "../src/backend/messaging/line/line-api";
import { lineDriver } from "../src/backend/messaging/line/line-driver";
import { LineRuntime } from "../src/backend/messaging/line/line-runtime";
import { MessagingService } from "../src/backend/messaging/messaging-service";
import type { MessageTarget, MessagingAdapter } from "../src/backend/messaging/messaging-types";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { MessagingCredentialStore } from "../src/main/messaging-credential-store";
import type { SecretCipher } from "../src/main/provider-credential-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build");
const REPORT = join(OUT, "messaging-line-e2e.json");
const root = await mkdtemp(join(tmpdir(), "openbot-line-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const credentialsPath = join(userData, "messaging-credentials.json");

const CHANNEL_TOKEN = randomBytes(24).toString("base64url");
const REJECTED_TOKEN = randomBytes(24).toString("base64url");
const CHANNEL_SECRET = randomBytes(16).toString("hex");
const BOT_ID = `U${randomBytes(16).toString("hex")}`;
const BOT_NAME = "E2E Official Account";
const SECRET_TEXT = `private-text-${randomBytes(6).toString("hex")}`;

const userId = (letter: string) => `U${letter.repeat(32)}`;
const ALICE = userId("a");
const BOB = userId("b");
const CARL = userId("c");
const DORA = userId("d");
const ERIN = userId("e");
const FRED = userId("f");
const HANA = userId("1");
const NAMES = new Map([
  [ALICE, "Alice"],
  [BOB, "Bob"],
  [CARL, "Carl"],
  [DORA, "Dora"],
  [ERIN, "Erin"],
  [FRED, "Fred"],
  [HANA, "Hana"],
]);

interface Step {
  name: string;
  passed: boolean;
  observed?: unknown;
  error?: string;
}

const report: { steps: Step[]; passed: boolean; unverified: string[] } = {
  steps: [],
  passed: false,
  unverified: [
    "The real LINE platform: a local fake stands in for api.line.me, and the signed webhooks come from this script, not from LINE servers.",
    "An agent turn: no provider runs. The answer path is checked with an adapter that shares the runtime of the live connection.",
    "A public tunnel: the public address is a fake https name, and the fake API sends the test request to the local port.",
  ],
};

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  const entry: Step = { name, passed: false };
  report.steps.push(entry);
  try {
    entry.observed = await run();
    entry.passed = true;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function until<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}.`);
    await new Promise((resume) => setTimeout(resume, 25));
  }
}

interface ApiCall {
  method: string;
  path: string;
  authorization: string | undefined;
  retryKey: string | undefined;
  body: { replyToken?: string; to?: string; messages?: { type: string; text: string }[]; endpoint?: string };
}

const calls: ApiCall[] = [];
const behavior: {
  replyInvalid: boolean;
  push: "ok" | "retry-once" | "quota" | "already";
  pushFailedOnce: boolean;
  test: "ok" | "fail";
  hostPort: number;
} = {
  replyInvalid: false,
  push: "ok",
  pushFailedOnce: false,
  test: "ok",
  hostPort: 0,
};

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sign(body: string, secret = CHANNEL_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

async function sendWebhook(port: number, events: unknown[], secret = CHANNEL_SECRET): Promise<number> {
  const body = JSON.stringify({ destination: BOT_ID, events });
  const response = await fetch(`http://127.0.0.1:${port}/line/webhook`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-line-signature": sign(body, secret) },
  });
  await response.text();
  return response.status;
}

const fakeApi: Server = createHttpServer((request, response) => {
  void (async () => {
    const text = await readText(request);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const call: ApiCall = {
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
      retryKey: request.headers["x-line-retry-key"]?.toString(),
      body: text ? JSON.parse(text) : {},
    };
    calls.push(call);
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (call.authorization !== `Bearer ${CHANNEL_TOKEN}`) return answer(401, { message: "Authentication failed" });
    if (path === "/v2/bot/info") return answer(200, { userId: BOT_ID, basicId: "@e2e-oa", displayName: BOT_NAME });
    if (path.startsWith("/v2/bot/profile/")) {
      const name = NAMES.get(decodeURIComponent(path.slice("/v2/bot/profile/".length)));
      return name ? answer(200, { displayName: name }) : answer(404, { message: "Not found" });
    }
    if (path === "/v2/bot/message/reply") {
      if (behavior.replyInvalid) return answer(400, { message: "Invalid reply token" });
      return answer(200, { sentMessages: (call.body.messages ?? []).map(() => ({ id: randomUUID() })) });
    }
    if (path === "/v2/bot/message/push") {
      if (behavior.push === "quota") return answer(429, { message: "You have reached your monthly limit." });
      if (behavior.push === "already") return answer(409, { message: "The retry key is accepted" });
      if (behavior.push === "retry-once" && !behavior.pushFailedOnce) {
        behavior.pushFailedOnce = true;
        return answer(500, { message: "oops" });
      }
      return answer(200, { sentMessages: (call.body.messages ?? []).map(() => ({ id: randomUUID() })) });
    }
    if (path === "/v2/bot/channel/webhook/endpoint") return answer(200, {});
    if (path === "/v2/bot/channel/webhook/test") {
      if (behavior.test === "fail")
        return answer(200, { success: false, statusCode: 502, reason: "COULD_NOT_CONNECT", detail: "no route" });
      await sendWebhook(behavior.hostPort, []);
      return answer(200, { success: true, statusCode: 200, reason: "OK" });
    }
    return answer(404, { message: "unknown" });
  })();
});
await new Promise<void>((done) => fakeApi.listen(0, "127.0.0.1", done));
const fakeAddress = fakeApi.address();
assert.ok(fakeAddress && typeof fakeAddress !== "string");
const apiOrigin = `http://127.0.0.1:${fakeAddress.port}`;

const cipherKey = randomBytes(32);
const cipher: SecretCipher = {
  encrypt: (value) => {
    const iv = randomBytes(12);
    const sealed = createCipheriv("aes-256-gcm", cipherKey, iv);
    const body = Buffer.concat([sealed.update(value, "utf8"), sealed.final()]);
    return Buffer.concat([iv, sealed.getAuthTag(), body]);
  },
  decrypt: (value) => {
    const opened = createDecipheriv("aes-256-gcm", cipherKey, value.subarray(0, 12));
    opened.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([opened.update(value.subarray(28)), opened.final()]).toString("utf8");
  },
};

const logs: string[] = [];
const stopTee = teeLogLines(["line", "line-webhook", "messaging"], (line) => logs.push(line));

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  toolCanUseTab: () => false,
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

interface Booted {
  agents: AgentService;
  messaging: MessagingService;
  runtime: LineRuntime;
  credentials: MessagingCredentialStore;
  mailbox: MailboxStore;
}

async function boot<T>(use: (services: Booted) => Promise<T>): Promise<T> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const agents = new AgentService({ store, mailbox, browser, sidebarLayout: sidebar });
  const credentials = new MessagingCredentialStore(credentialsPath, cipher);
  assert.equal(await Effect.runPromise(credentials.load()), null);
  const runtime = new LineRuntime({ apiOrigin });
  const messaging = new MessagingService({
    threads: agents.messaging,
    agents: {
      listAgents: () => agents.listAgents(),
      respondToApproval: (input) => agents.respondToApproval(input),
      approvalExecutionThreadId: (requestId) => agents.approvalExecutionThreadId(requestId),
      onEvent: () => () => {},
      createAgentProfile: (input) => agents.createAgentProfile(input),
      createMemory: (input) => agents.createMemory(input),
      ensureDeletable: (agentId) => agents.ensureAgentDeletable(agentId),
      deleteAgent: (agentId) => agents.deleteAgent(agentId),
      sidebarChatIds: () => agents.sidebarChatIds(),
    },
    credentials,
    drivers: [lineDriver({ runtime })],
    downloadsRoot: join(userData, "messaging-downloads"),
    line: runtime,
    sidebar,
  });
  await runCauseEffect(messaging.start());
  try {
    return await use({ agents, messaging, runtime, credentials, mailbox });
  } finally {
    await runCauseEffect(messaging.stop());
    await runCauseEffect(agents.stop());
    database.close();
    gc(true);
  }
}

let eventCounter = 0;

function textEvent(user: string, text: string, replyToken: string | null = `reply-${randomUUID()}`) {
  eventCounter += 1;
  return {
    id: `m-${eventCounter}-${randomBytes(3).toString("hex")}`,
    token: replyToken,
    user,
    event: (id: string) => ({
      type: "message",
      mode: "active",
      webhookEventId: `evt-${id}`,
      deliveryContext: { isRedelivery: false },
      timestamp: Date.now(),
      source: { type: "user", userId: user },
      ...(replyToken ? { replyToken } : {}),
      message: { type: "text", id, text },
    }),
  };
}

function account(messaging: MessagingService): LineAccount {
  const found = messaging.lineOverview().accounts.find((candidate) => candidate.workspaceId === BOT_ID);
  assert.ok(found, "No LINE account in the overview.");
  return found;
}

function connection(messaging: MessagingService): MessagingConnection | undefined {
  return messaging.lineOverview().connections.find((candidate) => candidate.workspaceId === BOT_ID);
}

function connectionId(agents: AgentService): string {
  const record = agents.messaging.store.connectionForWorkspace("line", BOT_ID);
  assert.ok(record, "No LINE connection row.");
  return record.connectionId;
}

function inCore(agents: AgentService, _user: string, messageId: string): boolean {
  return agents.messaging.received(`messaging:${connectionId(agents)}:evt-${messageId}`);
}

function callsAfter(mark: number, path: string): ApiCall[] {
  return calls.slice(mark).filter((call) => call.path === path);
}

function targetOf(user: string, messageId: string): MessageTarget {
  return { platformChannelId: user, replyThreadId: `dm:${messageId}` };
}

async function deliver(services: Booted, user: string, text: string, token: string | null = null) {
  const message = textEvent(user, text, token ?? `reply-${randomUUID()}`);
  const status = await sendWebhook(account(services.messaging).webhookPort, [message.event(message.id)]);
  assert.equal(status, 200);
  return { messageId: message.id, token: message.token ?? "" };
}

async function approve(services: Booted, user: string): Promise<void> {
  const message = textEvent(user, "hello", `reply-${randomUUID()}`);
  await sendWebhook(account(services.messaging).webhookPort, [message.event(message.id)]);
  await until(
    () => account(services.messaging).pendingRequests.some((request) => request.senderId === user),
    `the request of ${user}`,
  );
  await runCauseEffect(services.messaging.answerLineRequest(BOT_ID, user, true));
}

function adapterOf(services: Booted, agents: AgentService): MessagingAdapter {
  const values = services.credentials.get(connectionId(agents));
  assert.ok(values, "No credentials.");
  return lineDriver({ runtime: services.runtime }).createAdapter(values, {
    connectionId: connectionId(agents),
    rateLimited: () => undefined,
  });
}

function isRefused(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/line/webhook`, { method: "POST", body: "{}" }).then(
    () => false,
    () => true,
  );
}

let savedPort = 0;
let orchestratorId = "";
let stableUser = "";

try {
  await boot(async (services) => {
    const { agents, messaging, runtime, credentials } = services;

    await step("connect with a token that the fake API rejects (401)", async () => {
      const failure = await runCauseEffect(
        messaging.connectLine({ channelAccessToken: REJECTED_TOKEN, channelSecret: CHANNEL_SECRET }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof Error, "The connect did not fail.");
      assert.equal(failure.message, sourceText("error.messaging.lineInvalidToken"));
      assert.equal(agents.messaging.store.connections().filter((record) => record.platform === "line").length, 0);
      assert.deepEqual(credentials.keys(), []);
      assert.ok(!existsSync(credentialsPath), "A credential file was written.");
      return { message: failure.message, connections: 0, credentialKeys: 0 };
    });

    await step("connect with good credentials", async () => {
      const result = await runCauseEffect(
        messaging.connectLine({ channelAccessToken: CHANNEL_TOKEN, channelSecret: CHANNEL_SECRET }),
      );
      assert.equal(result.workspaceId, BOT_ID);
      await until(() => connection(messaging)?.state === "connected", "the connection state");
      const overview = messaging.lineOverview();
      const row = overview.connections[0];
      assert.equal(row?.workspaceName, BOT_NAME);
      assert.equal(row?.credentials, "saved");
      const line = account(messaging);
      assert.equal(line.webhook, "unknown");
      assert.ok(line.webhookPort > 0);
      assert.equal(line.localWebhookUrl, `http://127.0.0.1:${line.webhookPort}/line/webhook`);
      const serialized = JSON.stringify(overview);
      assert.ok(
        !serialized.includes(CHANNEL_TOKEN) && !serialized.includes(CHANNEL_SECRET),
        "The overview has a secret.",
      );
      const file = readFileSync(credentialsPath, "utf8");
      assert.ok(!file.includes(CHANNEL_TOKEN) && !file.includes(CHANNEL_SECRET), "The credential file is plain.");
      savedPort = line.webhookPort;
      behavior.hostPort = savedPort;
      return { name: row?.workspaceName, webhook: line.webhook, port: savedPort };
    });

    await step("first correctly signed request gives the state verified", async () => {
      const wrong = await sendWebhook(savedPort, [], randomBytes(16).toString("hex"));
      assert.equal(wrong, 401);
      assert.equal(account(messaging).webhook, "unknown", "A wrong signature changed the state.");
      const status = await sendWebhook(savedPort, []);
      assert.equal(status, 200);
      await until(() => account(messaging).webhook === "verified", "the verified state");
      return { wrongSignature: wrong, signed: status, webhook: account(messaging).webhook };
    });

    await step("message from an unknown user: one request, one notice, no agent turn", async () => {
      const mark = calls.length;
      const first = textEvent(ALICE, SECRET_TEXT);
      assert.equal(await sendWebhook(savedPort, [first.event(first.id)]), 200);
      await until(() => callsAfter(mark, "/v2/bot/message/reply").length === 1, "the notice");
      const second = textEvent(ALICE, `${SECRET_TEXT} again`);
      const other = textEvent(BOB, SECRET_TEXT);
      assert.equal(await sendWebhook(savedPort, [second.event(second.id), other.event(other.id)]), 200);
      await until(() => callsAfter(mark, "/v2/bot/message/reply").length === 2, "the notice of the next user");
      const replies = callsAfter(mark, "/v2/bot/message/reply");
      assert.equal(replies[0]?.body.replyToken, first.token);
      assert.equal(replies[0]?.body.messages?.[0]?.text, sourceText("status.messaging.linePairingNotice"));
      assert.equal(replies[1]?.body.replyToken, other.token);
      assert.ok(!replies.some((call) => call.body.replyToken === second.token), "A second notice was sent.");
      assert.equal(callsAfter(mark, "/v2/bot/message/push").length, 0, "OpenBot pushed to an unknown user.");
      await until(() => account(messaging).pendingRequests.some((request) => request.name === "Alice"), "the name");
      const requests = account(messaging).pendingRequests;
      assert.equal(requests.length, 2);
      for (const message of [first, second, other])
        assert.equal(inCore(agents, message.user, message.id), false, "A message reached the core.");
      assert.equal(agents.messaging.store.linkByKey(connectionId(agents), ALICE, "dm"), null);
      return { requests: requests.map((request) => request.name), notices: replies.length };
    });

    await step("owner refuses: the user stays blocked; owner approves: the row exists", async () => {
      await runCauseEffect(messaging.answerLineRequest(BOT_ID, BOB, false));
      assert.ok(!account(messaging).pendingRequests.some((request) => request.senderId === BOB));
      assert.deepEqual(agents.messaging.store.allowedSenders(connectionId(agents)), []);
      const blocked = textEvent(BOB, SECRET_TEXT);
      assert.equal(await sendWebhook(savedPort, [blocked.event(blocked.id)]), 200);
      await until(
        () => account(messaging).pendingRequests.some((request) => request.senderId === BOB),
        "the new request of the refused user",
      );
      assert.equal(inCore(agents, BOB, blocked.id), false, "A refused user reached the core.");
      await runCauseEffect(messaging.answerLineRequest(BOT_ID, BOB, false));
      const added = await runCauseEffect(messaging.addLineOrchestrator({}));
      orchestratorId = added.agentId;
      assert.equal(agents.listAgents().find((agent) => agent.id === orchestratorId)?.name, "LINE Orchestrator");
      assert.equal(connection(messaging)?.orchestratorAgentId, orchestratorId);
      await runCauseEffect(messaging.answerLineRequest(BOT_ID, ALICE, true));
      const rows = agents.messaging.store.allowedSenders(connectionId(agents));
      assert.deepEqual(rows, [{ id: ALICE, kind: "contact", name: "Alice" }]);
      return { rows, orchestratorId };
    });

    await step("approved user: the next message reaches the core for the orchestrator", async () => {
      const sent = await deliver(services, ALICE, SECRET_TEXT);
      await until(() => inCore(agents, ALICE, sent.messageId), "the message in the core");
      const link = agents.messaging.store.linkByKey(connectionId(agents), ALICE, "dm");
      assert.equal(link?.agentId, orchestratorId);
      assert.equal(link?.isDirect, true);
      return { agentId: link?.agentId, direct: link?.isDirect };
    });

    await step("answer path: reply with the token of the message, then push with a retry key", async () => {
      await approve(services, CARL);
      const adapter = adapterOf(services, agents);
      const sent = await deliver(services, CARL, SECRET_TEXT);
      await until(() => inCore(agents, CARL, sent.messageId), "the message of Carl in the core");
      const target = targetOf(CARL, sent.messageId);
      const mark = calls.length;
      assert.equal(
        await runCauseEffect(
          adapter.post(target, { text: "Working on it…", buttons: [{ action: "stop", label: "Stop", token: "t" }] }),
        ),
        "",
      );
      await runCauseEffect(adapter.edit(target, "any", { text: "edited" }));
      await runCauseEffect(adapter.react(target, sent.messageId, "received", true));
      assert.equal(calls.length, mark, "A status post, edit or reaction called the API.");
      await runCauseEffect(adapter.postAnswer(target, `First answer ${SECRET_TEXT}`, null));
      await runCauseEffect(adapter.postAnswer(target, "Second answer", null));
      const replies = callsAfter(mark, "/v2/bot/message/reply");
      const pushes = callsAfter(mark, "/v2/bot/message/push");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.body.replyToken, sent.token);
      assert.equal(replies[0]?.body.messages?.[0]?.text, `First answer ${SECRET_TEXT}`);
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0]?.body.to, CARL);
      assert.match(pushes[0]?.retryKey ?? "", /^[0-9a-f-]{36}$/u);
      return { replyToken: replies[0]?.body.replyToken, pushKey: pushes[0]?.retryKey };
    });

    await step("answer path: invalid_reply_token falls back to push", async () => {
      await approve(services, DORA);
      const adapter = adapterOf(services, agents);
      const sent = await deliver(services, DORA, "one more");
      await until(() => inCore(agents, DORA, sent.messageId), "the next message of Carl");
      const mark = calls.length;
      behavior.replyInvalid = true;
      try {
        await runCauseEffect(adapter.postAnswer(targetOf(DORA, sent.messageId), "Pushed answer", null));
      } finally {
        behavior.replyInvalid = false;
      }
      const replies = callsAfter(mark, "/v2/bot/message/reply");
      const pushes = callsAfter(mark, "/v2/bot/message/push");
      assert.equal(replies.length, 1);
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0]?.body.messages?.[0]?.text, "Pushed answer");
      return { reply: replies.length, push: pushes.length };
    });

    await step("answer path: a long answer uses more than one call; a retried push keeps its key", async () => {
      await approve(services, ERIN);
      const adapter = adapterOf(services, agents);
      const sent = await deliver(services, ERIN, "long please");
      await until(() => inCore(agents, ERIN, sent.messageId), "the long request in the core");
      const mark = calls.length;
      const long = Array.from({ length: 14 }, (_, index) => `Paragraph ${index}: ${"word ".repeat(900)}`).join("\n\n");
      await runCauseEffect(adapter.postAnswer(targetOf(ERIN, sent.messageId), long, null));
      const replies = callsAfter(mark, "/v2/bot/message/reply");
      const pushes = callsAfter(mark, "/v2/bot/message/push");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.body.messages?.length, 5);
      assert.ok(pushes.length >= 2, "The rest of the answer was not pushed.");
      assert.equal(new Set(pushes.map((call) => call.retryKey)).size, pushes.length);

      const retryMark = calls.length;
      behavior.push = "retry-once";
      behavior.pushFailedOnce = false;
      try {
        await runCauseEffect(adapter.postAnswer(targetOf(ERIN, "none"), "Retried answer", null));
      } finally {
        behavior.push = "ok";
      }
      const retried = callsAfter(retryMark, "/v2/bot/message/push");
      assert.equal(retried.length, 2);
      assert.equal(retried[0]?.retryKey, retried[1]?.retryKey);

      behavior.push = "already";
      try {
        await runCauseEffect(adapter.postAnswer(targetOf(ERIN, "none"), "Accepted earlier", null));
      } finally {
        behavior.push = "ok";
      }
      return { replyMessages: 5, pushes: pushes.length, retriedCalls: retried.length };
    });

    await step("approval menu: the answer 1 is an action, not a message", async () => {
      await approve(services, FRED);
      const adapter = adapterOf(services, agents);
      const target = targetOf(FRED, "none");
      const mark = calls.length;
      const menuId = await runCauseEffect(
        adapter.post(target, {
          text: "Run a command",
          buttons: [
            { action: "accept", label: "Approve", token: "accept-token" },
            { action: "decline", label: "Deny", token: "decline-token" },
          ],
        }),
      );
      const pushes = callsAfter(mark, "/v2/bot/message/push");
      assert.equal(pushes.length, 1);
      assert.ok(pushes[0]?.body.messages?.[0]?.text.includes(sourceText("status.messaging.whatsappApprovalMenu")));
      const answer = await deliver(services, FRED, "1");
      await until(() => runtime.latestMenu(FRED) === null, "the menu to be used");
      assert.equal(inCore(agents, FRED, answer.messageId), false, "The approval answer reached the core as a message.");
      const plain = await deliver(services, FRED, "1");
      await until(() => inCore(agents, FRED, plain.messageId), "a plain 1 without a menu");
      return { menuId: menuId.length > 0, menuUsed: true };
    });

    await step("quota 429 is not retried and is surfaced", async () => {
      const adapter = adapterOf(services, agents);
      const mark = calls.length;
      behavior.push = "quota";
      const failure = await runCauseEffect(adapter.postAnswer(targetOf(CARL, "none"), "Over the limit", null))
        .then(
          () => null,
          (error: unknown) => error,
        )
        .finally(() => {
          behavior.push = "ok";
        });
      assert.ok(failure instanceof LineApiError, "The push did not fail with a LINE error.");
      assert.equal(failure.failure, "quota_exceeded");
      assert.equal(callsAfter(mark, "/v2/bot/message/push").length, 1, "The push was retried.");
      assert.equal(account(messaging).quotaExceeded, true);
      await until(() => connection(messaging)?.state === "error", "the error state");
      await runCauseEffect(adapter.postAnswer(targetOf(CARL, "none"), "Back again", null));
      assert.equal(account(messaging).quotaExceeded, false);
      await until(() => connection(messaging)?.state === "connected", "the connected state");
      return { pushCalls: 1, failure: failure.failure, surfaced: ["quotaExceeded", "state error"] };
    });

    await step("public URL: only https; the endpoint is set and tested; the state follows", async () => {
      const refused = await runCauseEffect(messaging.setLinePublicUrl(BOT_ID, "http://example.test")).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof Error);
      assert.equal(refused.message, sourceText("error.messaging.linePublicUrlInvalid"));
      const mark = calls.length;
      behavior.test = "fail";
      await runCauseEffect(messaging.setLinePublicUrl(BOT_ID, "https://abc.example.test/"));
      assert.equal(account(messaging).webhook, "failed");
      assert.equal(account(messaging).webhookReason, "COULD_NOT_CONNECT");
      behavior.test = "ok";
      await runCauseEffect(messaging.setLinePublicUrl(BOT_ID, "https://abc.example.test"));
      assert.equal(account(messaging).webhook, "verified");
      assert.equal(account(messaging).publicUrl, "https://abc.example.test");
      const endpoints = callsAfter(mark, "/v2/bot/channel/webhook/endpoint");
      assert.ok(endpoints.every((call) => call.body.endpoint === "https://abc.example.test/line/webhook"));
      assert.equal(callsAfter(mark, "/v2/bot/channel/webhook/test").length, 2);
      return { refused: refused.message, endpoint: endpoints[0]?.body.endpoint, webhook: account(messaging).webhook };
    });

    await step("remove the sender: the user is blocked again", async () => {
      await runCauseEffect(messaging.removeLineSender(BOT_ID, ALICE));
      assert.ok(!agents.messaging.store.allowedSenders(connectionId(agents)).some((row) => row.id === ALICE));
      const blocked = textEvent(ALICE, SECRET_TEXT);
      assert.equal(await sendWebhook(savedPort, [blocked.event(blocked.id)]), 200);
      await until(
        () => account(messaging).pendingRequests.some((request) => request.senderId === ALICE),
        "the new request",
      );
      assert.equal(inCore(agents, ALICE, blocked.id), false, "A removed sender reached the core.");
      await runCauseEffect(messaging.answerLineRequest(BOT_ID, ALICE, false));
      return { blocked: true };
    });

    await approve(services, HANA);
    stableUser = HANA;
  });

  const occupied = createNetServer();
  await new Promise<void>((done) => occupied.listen(savedPort, "127.0.0.1", done));

  await boot(async (services) => {
    const { agents, messaging } = services;

    await step("restart with the saved port taken: error state, the port does not move", async () => {
      await until(() => connection(messaging)?.state === "error", "the error state");
      assert.equal(account(messaging).webhookPort, savedPort);
      await new Promise<void>((done) => occupied.close(() => done()));
      await runCauseEffect(messaging.reconnect("line", BOT_ID, false));
      await until(() => connection(messaging)?.state === "connected", "the connected state");
      assert.equal(account(messaging).webhookPort, savedPort);
      return { port: savedPort, state: connection(messaging)?.state };
    });

    await step("restart: the connection and the approved sender come back", async () => {
      assert.equal(account(messaging).webhook, "unknown");
      assert.equal(account(messaging).publicUrl, "https://abc.example.test");
      assert.ok(account(messaging).allowedSenders.some((sender) => sender.id === stableUser));
      const sent = await deliver(services, stableUser, SECRET_TEXT);
      await until(() => inCore(agents, stableUser, sent.messageId), "the message after the restart");
      assert.equal(agents.messaging.store.linkByKey(connectionId(agents), stableUser, "dm")?.agentId, orchestratorId);
      return { port: account(messaging).webhookPort, senders: account(messaging).allowedSenders.length };
    });

    await step("disconnect: the port closes, the credentials go, a signed webhook reaches nothing", async () => {
      const id = connectionId(agents);
      const before = agents.messaging.store.linkByKey(id, stableUser, "dm");
      for (const deliveryId of services.mailbox.queuedDeliveryIds(orchestratorId))
        await runCauseEffect(agents.cancelQueuedMessage(orchestratorId, deliveryId));
      await runCauseEffect(messaging.disconnectLine(BOT_ID));
      assert.equal(await isRefused(savedPort), true, "The port still answers.");
      assert.equal(services.credentials.get(id), null);
      assert.equal(services.credentials.status(id), "missing");
      assert.equal(messaging.lineOverview().connections.length, 0);
      assert.equal(messaging.lineOverview().accounts.length, 0);
      const after = textEvent(stableUser, SECRET_TEXT);
      const outcome = await sendWebhook(savedPort, [after.event(after.id)]).then(
        (status) => `status ${status}`,
        () => "connection refused",
      );
      assert.equal(outcome, "connection refused");
      assert.equal(inCore(agents, stableUser, after.id), false);
      assert.ok(before, "The link was lost.");
      assert.ok(!agents.listAgents().some((agent) => agent.id === orchestratorId), "The orchestrator stayed.");
      return { outcome, credentials: "missing", orchestratorDeleted: true };
    });
  });

  await step("the logs have no credential and no message text", async () => {
    const text = logs.join("\n");
    assert.ok(logs.length > 0, "No log line was captured.");
    assert.ok(logs.some((line) => line.includes("The LINE webhook port is not available.")));
    for (const secret of [CHANNEL_TOKEN, CHANNEL_SECRET, REJECTED_TOKEN, SECRET_TEXT, "Paragraph", "Over the limit"])
      assert.ok(!text.includes(secret), `A log line has ${secret.slice(0, 6)}.`);
    return { lines: logs.length };
  });
  report.passed = report.steps.every((entry) => entry.passed);
} catch {
  report.passed = false;
} finally {
  stopTee();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await new Promise<void>((done) => {
    fakeApi.close(() => done());
    fakeApi.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}

const failed = report.steps.filter((entry) => !entry.passed);
process.stdout.write(
  `LINE messaging check: ${report.steps.length - failed.length}/${report.steps.length} steps passed. Report: ${REPORT}\n`,
);
for (const entry of failed) process.stdout.write(`FAILED ${entry.name}: ${entry.error}\n`);
process.exit(report.passed ? 0 : 1);
