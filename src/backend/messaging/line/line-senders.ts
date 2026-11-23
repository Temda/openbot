import { type LinePendingRequest, MESSAGING_LIMITS } from "@openbot/contracts/ipc";

export const LINE_PLACE_NOT_ALLOWED = "line_place_not_allowed";

const REQUEST_TTL_MS = 60 * 60 * 1000;

export class LineSenderRequests {
  readonly #requests = new Map<string, LinePendingRequest[]>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  list(workspaceId: string): LinePendingRequest[] {
    const now = this.#now();
    const live = (this.#requests.get(workspaceId) ?? []).filter((request) => Date.parse(request.expiresAt) > now);
    this.#requests.set(workspaceId, live);
    return live;
  }

  request(workspaceId: string, senderId: string) {
    const live = this.list(workspaceId);
    if (live.some((request) => request.senderId === senderId)) return { created: false };
    if (live.length >= MESSAGING_LIMITS.pendingRequests) return null;
    const request: LinePendingRequest = {
      senderId,
      name: senderId.slice(0, MESSAGING_LIMITS.name),
      expiresAt: new Date(this.#now() + REQUEST_TTL_MS).toISOString(),
    };
    this.#requests.set(workspaceId, [...live, request]);
    return { created: true };
  }

  rename(workspaceId: string, senderId: string, name: string): void {
    const trimmed = name.trim().slice(0, MESSAGING_LIMITS.name);
    if (!trimmed) return;
    this.#requests.set(
      workspaceId,
      this.list(workspaceId).map((request) =>
        request.senderId === senderId ? { ...request, name: trimmed } : request,
      ),
    );
  }

  take(workspaceId: string, senderId: string): LinePendingRequest | null {
    const live = this.list(workspaceId);
    const found = live.find((request) => request.senderId === senderId) ?? null;
    if (found)
      this.#requests.set(
        workspaceId,
        live.filter((request) => request !== found),
      );
    return found;
  }

  clear(workspaceId: string): void {
    this.#requests.delete(workspaceId);
  }
}
