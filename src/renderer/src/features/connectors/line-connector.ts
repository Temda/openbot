import type { LineOverview, MessagingDesktopApi } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createSignal, untrack } from "solid-js";
import {
  type ConnectorAnalyticsAction,
  type ConnectorController,
  createConnectorActions,
} from "./connector-controller";
import type { MessagingConnectorOptions } from "./messaging-connector";

export type LinePort = Pick<
  MessagingDesktopApi,
  | "getLineOverview"
  | "connectLine"
  | "disconnectLine"
  | "reconnectLine"
  | "setLineEnabled"
  | "addLineOrchestrator"
  | "answerLineRequest"
  | "removeLineSender"
  | "setLinePublicUrl"
>;

export const linePort = (): LinePort => window.openbot.messaging;

const POLL_MS = 3_000;

export function createLineConnector(port: () => LinePort, options: MessagingConnectorOptions): ConnectorController {
  const [loaded, setLoaded] = createSignal<{ overview: LineOverview | null; error: string | null } | null>(null);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  const overview = () => loaded()?.overview ?? null;
  const actions = createConnectorActions("connector.line.actionFailed", "line");
  let reads = 0;

  const reload = () => {
    const read = ++reads;
    void port()
      .getLineOverview()
      .then((next) => {
        if (actions.disposed() || read !== reads) return;
        setLoaded({ overview: next, error: null });
      })
      .catch((error: unknown) => {
        if (actions.disposed() || read !== reads) return;
        const { t, errorMessage } = currentText();
        setLoaded({ overview: untrack(overview), error: errorMessage(error, t("connector.readFailed")) });
      });
  };
  const run = (action: () => Promise<unknown>, track?: ConnectorAnalyticsAction) =>
    actions.run(action, { settled: reload, ...(track ? { track } : {}) });

  return {
    id: "line",
    ready: () => loaded() !== null,
    available: () => true,
    busy: actions.busy,
    reload,
    watch: () => {
      reload();
      const timer = setInterval(reload, POLL_MS);
      return () => clearInterval(timer);
    },
    detail: {
      id: "line",
      props: {
        get agents() {
          return options.agents();
        },
        get connections() {
          return overview()?.connections ?? [];
        },
        get accounts() {
          return overview()?.accounts ?? [];
        },
        get busy() {
          return actions.busy();
        },
        get models() {
          return options.models?.();
        },
        get connectError() {
          return connectError();
        },
        get loadError() {
          return loaded()?.error ?? null;
        },
        onRetry: reload,
        onConnect: (input) => {
          setConnectError(null);
          actions.run(() => port().connectLine(input), {
            settled: reload,
            track: "connected",
            onError: (error) => {
              const { t, errorMessage } = currentText();
              setConnectError(errorMessage(error, t("connector.line.actionFailed")));
            },
          });
        },
        onDisconnectAccount: (workspaceId) => run(() => port().disconnectLine({ workspaceId }), "disconnected"),
        onDisconnectAll: () => {
          const workspaceIds = untrack(() => overview()?.connections ?? []).map((connection) => connection.workspaceId);
          run(async () => {
            for (const workspaceId of workspaceIds) await port().disconnectLine({ workspaceId });
          }, "disconnected");
        },
        onReconnect: (workspaceId) => run(() => port().reconnectLine({ workspaceId }), "connect_started"),
        onSetEnabled: (workspaceId, enabled) =>
          run(() => port().setLineEnabled({ workspaceId, enabled }), enabled ? "enabled" : "disabled"),
        onSetPublicUrl: (workspaceId, publicUrl) => run(() => port().setLinePublicUrl({ workspaceId, publicUrl })),
        onAddOrchestrator: (choice) =>
          run(async () => {
            const { sectionId } = await port().addLineOrchestrator({ ...(choice ?? {}) });
            if (sectionId) options.onOrchestratorSection?.(sectionId);
          }),
        onAnswerRequest: (workspaceId, senderId, approve) =>
          run(() => port().answerLineRequest({ workspaceId, senderId, approve })),
        onRemoveSender: (workspaceId, senderId) => run(() => port().removeLineSender({ workspaceId, senderId })),
      },
    },
  };
}
