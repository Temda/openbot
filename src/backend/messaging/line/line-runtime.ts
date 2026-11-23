import type { LineWebhookState } from "@openbot/contracts/ipc";
import { LINE_API_ORIGIN, LineApi } from "./line-api";

export const LINE_REPLY_TOKEN_TTL_MS = 60_000;
const REPLY_TOKEN_LIMIT = 1_000;
const MENU_LIMIT = 200;

export interface LineSenderRules {
  contacts: ReadonlyMap<string, string>;
}

export interface LinePolicy {
  rules(workspaceId: string): LineSenderRules;
  request(workspaceId: string, senderId: string): { created: boolean } | null;
  nameRequest(workspaceId: string, senderId: string, name: string): void;
}

export interface LineMenuButton {
  action: "accept" | "decline" | "stop";
  token: string;
}

export interface LineMenu {
  userId: string;
  buttons: readonly LineMenuButton[];
}

export interface LineWebhookStatus {
  state: LineWebhookState;
  reason: string | null;
}

export interface LineRuntimeOptions {
  apiOrigin?: string | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

const NO_RULES: LineSenderRules = { contacts: new Map() };
const UNKNOWN: LineWebhookStatus = { state: "unknown", reason: null };

export class LineRuntime {
  readonly #options: LineRuntimeOptions;
  readonly #now: () => number;
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
  readonly #menus = new Map<string, LineMenu>();
  readonly #webhooks = new Map<string, LineWebhookStatus>();
  readonly #quota = new Set<string>();
  readonly #quotaListeners = new Map<string, (exceeded: boolean) => void>();
  #policy: LinePolicy = { rules: () => NO_RULES, request: () => null, nameRequest: () => undefined };

  constructor(options: LineRuntimeOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get policy(): LinePolicy {
    return this.#policy;
  }

  setPolicy(policy: LinePolicy): void {
    this.#policy = policy;
  }

  api(token: string): LineApi {
    return new LineApi({
      token,
      origin: this.#options.apiOrigin ?? LINE_API_ORIGIN,
      fetch: this.#options.fetch,
    });
  }

  rememberReplyToken(messageId: string, token: string): void {
    this.#tokens.delete(messageId);
    this.#tokens.set(messageId, { token, expiresAt: this.#now() + LINE_REPLY_TOKEN_TTL_MS });
    this.#pruneTokens();
  }

  takeReplyToken(messageId: string): string | null {
    const found = this.#tokens.get(messageId);
    this.#tokens.delete(messageId);
    return found && found.expiresAt > this.#now() ? found.token : null;
  }

  #pruneTokens(): void {
    const now = this.#now();
    for (const [messageId, entry] of this.#tokens) {
      if (entry.expiresAt > now && this.#tokens.size <= REPLY_TOKEN_LIMIT) break;
      this.#tokens.delete(messageId);
    }
  }

  rememberMenu(messageId: string, menu: LineMenu): void {
    this.#menus.delete(messageId);
    this.#menus.set(messageId, menu);
    if (this.#menus.size > MENU_LIMIT) {
      const oldest = this.#menus.keys().next();
      if (!oldest.done) this.#menus.delete(oldest.value);
    }
  }

  latestMenu(userId: string): { messageId: string; menu: LineMenu } | null {
    let found: { messageId: string; menu: LineMenu } | null = null;
    for (const [messageId, menu] of this.#menus) if (menu.userId === userId) found = { messageId, menu };
    return found;
  }

  forgetMenu(messageId: string): void {
    this.#menus.delete(messageId);
  }

  webhook(workspaceId: string): LineWebhookStatus {
    return this.#webhooks.get(workspaceId) ?? UNKNOWN;
  }

  setWebhook(workspaceId: string, status: LineWebhookStatus): void {
    this.#webhooks.set(workspaceId, status);
  }

  markVerified(workspaceId: string): void {
    this.#webhooks.set(workspaceId, { state: "verified", reason: null });
  }

  quotaExceeded(workspaceId: string): boolean {
    return this.#quota.has(workspaceId);
  }

  setQuotaExceeded(workspaceId: string, exceeded: boolean): void {
    if (this.#quota.has(workspaceId) === exceeded) return;
    if (exceeded) this.#quota.add(workspaceId);
    else this.#quota.delete(workspaceId);
    this.#quotaListeners.get(workspaceId)?.(exceeded);
  }

  onQuota(workspaceId: string, listener: (exceeded: boolean) => void): () => void {
    this.#quotaListeners.set(workspaceId, listener);
    return () => {
      if (this.#quotaListeners.get(workspaceId) === listener) this.#quotaListeners.delete(workspaceId);
    };
  }

  forget(workspaceId: string): void {
    this.#webhooks.delete(workspaceId);
    this.#quota.delete(workspaceId);
  }
}
