import type {
  ConnectLineInput,
  LineAccount,
  LinePendingRequest,
  LineSender,
  MessagingConnection,
} from "@openbot/contracts/ipc";
import { LINE_LIMITS, MESSAGING_LIMITS, parseLineCredential, parseLinePublicUrl } from "@openbot/contracts/ipc";
import { LINE_ORCHESTRATOR_AVATAR } from "@openbot/contracts/line-app";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  CopyButton,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  SettingsSection,
  Text,
  TriangleAlert,
  UserRound,
} from "@openbot/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { LineTile } from "./brand-marks";
import {
  type ChannelAgent,
  ChannelConnectChecklist,
  ChannelConnectionRow,
  ChannelDisconnectDialog,
  type ChannelOrchestratorChoice,
  type ChannelOrchestratorModels,
  ChannelOrchestratorSection,
  ChannelOrchestratorStep,
  ChannelPage,
  type ChannelState,
  type ChannelText,
  channelRowKind,
  pausedChannelState,
} from "./ChannelParts";
import { type IntegrationPageSlots, LogoTile, UNKNOWN_STATUS, WizardDialog } from "./IntegrationLayout";
import { messagingStateUnknown } from "./SlackIntegrationPanel";
import { telegramOrchestrator } from "./TelegramIntegrationPanel";

export type LineIntegrationAgent = ChannelAgent;
export type LineOrchestratorChoice = ChannelOrchestratorChoice;
export type LineOrchestratorModels = ChannelOrchestratorModels;

export interface LineIntegrationPanelProps extends IntegrationPageSlots {
  agents: LineIntegrationAgent[];
  connections: MessagingConnection[];
  accounts: LineAccount[];
  busy: boolean;
  models?: LineOrchestratorModels | undefined;
  connectError?: string | null | undefined;
  onConnect: (input: ConnectLineInput) => void;
  onDisconnectAccount: (workspaceId: string) => void;
  onDisconnectAll: () => void;
  onReconnect: (workspaceId: string) => void;
  onSetEnabled: (workspaceId: string, enabled: boolean) => void;
  onSetPublicUrl: (workspaceId: string, publicUrl: string | null) => void;
  onAddOrchestrator: (choice: LineOrchestratorChoice | null) => void;
  onAnswerRequest: (workspaceId: string, senderId: string, approve: boolean) => void;
  onRemoveSender: (workspaceId: string, senderId: string) => void;
  loadError?: string | null | undefined;
  onRetry?: (() => void) | undefined;
}

const LINE_TEXT = {
  title: "connector.line.title",
  description: "connector.line.description",
  connect: "connector.line.connect",
  attentionTitle: "connector.line.attentionTitle",
  attentionDescription: "connector.line.attentionDescription",
  disconnectAllTitle: "connector.line.disconnectAllTitle",
  disconnect: "connector.line.disconnect",
  reconnect: "connector.line.reconnect",
  pause: "connector.line.pause",
  resume: "connector.line.resume",
  rowAction: "connector.line.rowAction",
  addAgent: "connector.line.addAgent",
  orchestratorTitle: "connector.line.orchestratorTitle",
  orchestratorDescription: "connector.line.orchestratorDescription",
  orchestratorNone: "connector.line.orchestratorNone",
  orchestratorNoneDescription: "connector.line.orchestratorNoneDescription",
  note: "connector.line.note",
  connectStepBrowser: "connector.line.connectStepOpen",
  connectStepAllow: "connector.line.connectStepToken",
  connectStepReturn: "connector.line.connectStepSecret",
  connectWaiting: "connector.line.connectWaiting",
  orchestratorName: "connector.line.orchestratorName",
  orchestratorRole: "connector.line.orchestratorRole",
  orchestratorDoesReceive: "connector.line.orchestratorDoesReceive",
  orchestratorDoesDelegate: "connector.line.orchestratorDoesDelegate",
  orchestratorDoesAnswer: "connector.line.orchestratorDoesAnswer",
  orchestratorModel: "connector.line.orchestratorModel",
  removeEffectKept: "connector.line.removeEffectKept",
  removeEffectDeleted: "connector.line.removeEffectDeleted",
  keep: "connector.line.keep",
  close: "connector.line.close",
} as const satisfies ChannelText;

const STATE_HELP: Partial<Record<MessagingConnection["state"], AppTextKey>> = {
  invalid_token: "connector.line.helpInvalidToken",
  secret_storage_unavailable: "connector.line.helpKeysUnreadable",
  error: "connector.line.helpError",
};

const needsNewConnection = (connection: MessagingConnection) =>
  connection.state === "invalid_token" || connection.state === "secret_storage_unavailable";

export const lineOrchestrator = telegramOrchestrator;

export function lineIntegrationState(
  connections: readonly MessagingConnection[],
  agents: readonly { id: string }[],
  loadError?: string | null,
): ChannelState {
  if (messagingStateUnknown({ connections, loadError })) return { ...UNKNOWN_STATUS, attention: 0 };
  const orchestrator = lineOrchestrator(connections, agents);
  const attention = connections.filter(
    (connection) => channelRowKind(connection) === "attention" || !orchestrator,
  ).length;
  if (attention > 0) return { status: "attention", label: "connector.line.statusAttention", attention };
  if (connections.length === 0) return { status: "idle", label: "marketplace.app.notConnected", attention };
  return pausedChannelState(connections) ?? { status: "connected", label: "connector.line.statusConnected", attention };
}

function orchestratorList(agent: LineIntegrationAgent | null): LineIntegrationAgent[] {
  return agent ? [agent] : [];
}

function shortId(id: string): string {
  return `…${id.slice(-6)}`;
}

export function LineIntegrationPanel(props: LineIntegrationPanelProps) {
  const { t, format } = useText();
  const [agentDialogOpen, setAgentDialogOpen] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal<MessagingConnection | null>(null);
  const orchestrator = () => lineOrchestrator(props.connections, props.agents);
  const account = (workspaceId: string) => props.accounts.find((entry) => entry.workspaceId === workspaceId);
  const linked = () =>
    props.connections.flatMap((connection) => {
      const settings = account(connection.workspaceId);
      return settings ? [{ connection, account: settings }] : [];
    });
  const disconnectAllSummary = () =>
    t(
      orchestrator() === null
        ? "connector.line.disconnectAllSummary"
        : "connector.line.disconnectAllSummaryOrchestrator",
    );
  const note = (connection: MessagingConnection) => {
    if (connection.retryAt)
      return t("connector.line.retryAt", {
        time: format.date(new Date(connection.retryAt), { hour: "numeric", minute: "2-digit" }),
      });
    const help = STATE_HELP[connection.state];
    return help ? t(help) : t("connector.line.accountNote");
  };
  const disconnectingName = () => disconnecting()?.workspaceName ?? "";
  let connectForm: HTMLDivElement | undefined;
  const focusForm = () => connectForm?.querySelector("input")?.focus();

  return (
    <ChannelPage
      text={LINE_TEXT}
      logo={<LineTile />}
      state={lineIntegrationState(props.connections, props.agents, props.loadError)}
      connections={props.connections}
      unknown={messagingStateUnknown(props)}
      busy={props.busy}
      loadError={props.loadError}
      onRetry={props.onRetry}
      onConnect={focusForm}
      disconnectAllSummary={disconnectAllSummary()}
      onDisconnectAll={props.onDisconnectAll}
      tagline={props.tagline}
      intro={props.intro}
      details={props.details}
      sections={
        <>
          <SettingsSection title={t("connector.line.accountsTitle")}>
            <ItemGroup class="settings-modal-card">
              <For each={props.connections}>
                {(connection) => (
                  <ChannelConnectionRow
                    text={LINE_TEXT}
                    logo={<LineTile />}
                    connection={connection}
                    note={note(connection)}
                    busy={props.busy}
                    canReconnect={!needsNewConnection(connection)}
                    onReconnect={() => props.onReconnect(connection.workspaceId)}
                    onSetEnabled={(enabled) => props.onSetEnabled(connection.workspaceId, enabled)}
                    onDisconnect={() => setDisconnecting(connection)}
                  />
                )}
              </For>
            </ItemGroup>
          </SettingsSection>

          <For each={linked()}>
            {(entry) => (
              <>
                <Show when={entry.account.quotaExceeded}>
                  <Alert tone="warning" role="alert">
                    <AlertIcon>
                      <TriangleAlert />
                    </AlertIcon>
                    <AlertContent>
                      <AlertTitle>{t("connector.line.quotaTitle")}</AlertTitle>
                      <AlertDescription>{t("connector.line.quotaDescription")}</AlertDescription>
                    </AlertContent>
                  </Alert>
                </Show>
                <WebhookSection
                  connection={entry.connection}
                  account={entry.account}
                  busy={props.busy}
                  onSetPublicUrl={(publicUrl) => props.onSetPublicUrl(entry.connection.workspaceId, publicUrl)}
                />
                <RequestsSection
                  connection={entry.connection}
                  requests={entry.account.pendingRequests}
                  busy={props.busy}
                  onAnswer={(senderId, approve) =>
                    props.onAnswerRequest(entry.connection.workspaceId, senderId, approve)
                  }
                />
                <SendersSection
                  connection={entry.connection}
                  senders={entry.account.allowedSenders}
                  busy={props.busy}
                  onRemove={(senderId) => props.onRemoveSender(entry.connection.workspaceId, senderId)}
                />
              </>
            )}
          </For>

          <ChannelOrchestratorSection
            text={LINE_TEXT}
            avatar={LINE_ORCHESTRATOR_AVATAR}
            agents={orchestratorList(orchestrator())}
            busy={props.busy}
            onAddAgent={() => setAgentDialogOpen(true)}
          />
        </>
      }
    >
      <Show when={props.connections.length === 0 && !messagingStateUnknown(props)}>
        <div
          ref={(element) => {
            connectForm = element;
          }}
        >
          <ConnectSection busy={props.busy} error={props.connectError} onConnect={props.onConnect} />
        </div>
      </Show>
      <OrchestratorDialog
        open={agentDialogOpen()}
        account={props.connections[0]?.workspaceName ?? ""}
        busy={props.busy}
        models={props.models}
        onAdd={(choice) => {
          setAgentDialogOpen(false);
          props.onAddOrchestrator(choice);
        }}
        onClose={() => setAgentDialogOpen(false)}
      />
      <ChannelDisconnectDialog
        text={LINE_TEXT}
        logo={<LineTile />}
        connection={disconnecting()}
        title={t("connector.line.disconnectTitle", { account: disconnectingName() })}
        description={t("connector.line.disconnectDescription", { account: disconnectingName() })}
        effect={t("connector.line.disconnectEffect", { account: disconnectingName() })}
        deletesOrchestrator={props.connections.length === 1 && orchestrator() !== null}
        onConfirm={(workspaceId) => {
          setDisconnecting(null);
          props.onDisconnectAccount(workspaceId);
        }}
        onClose={() => setDisconnecting(null)}
      />
    </ChannelPage>
  );
}

function ConnectSection(props: {
  busy: boolean;
  error?: string | null | undefined;
  onConnect: (input: ConnectLineInput) => void;
}) {
  const { t } = useText();
  const [token, setToken] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [invalid, setInvalid] = createSignal(false);
  const submit = () => {
    const channelAccessToken = parseLineCredential(token(), LINE_LIMITS.channelAccessToken);
    const channelSecret = parseLineCredential(secret(), LINE_LIMITS.channelSecret);
    setToken("");
    setSecret("");
    if (channelAccessToken === null || channelSecret === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    props.onConnect({ channelAccessToken, channelSecret });
  };
  return (
    <SettingsSection title={t("connector.line.connectTitle")} description={t("connector.line.connectDescription")}>
      <ItemGroup class="settings-modal-card">
        <form
          class="integration-card-body"
          novalidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.busy) submit();
          }}
        >
          <ChannelConnectChecklist text={LINE_TEXT} waiting={props.busy} />
          <Field label={t("connector.line.tokenLabel")} required>
            <Input
              type="password"
              size="sm"
              autocomplete="off"
              spellcheck={false}
              maxlength={LINE_LIMITS.channelAccessToken}
              value={token()}
              onInput={(event) => setToken(event.currentTarget.value)}
            />
          </Field>
          <Field
            label={t("connector.line.secretLabel")}
            description={t("connector.line.credentialsNote")}
            error={invalid() ? t("connector.line.credentialInvalid") : undefined}
            required
          >
            <Input
              type="password"
              size="sm"
              autocomplete="off"
              spellcheck={false}
              maxlength={LINE_LIMITS.channelSecret}
              value={secret()}
              onInput={(event) => setSecret(event.currentTarget.value)}
            />
          </Field>
          <Show when={props.error}>
            {(message) => (
              <Alert tone="danger" role="alert">
                <AlertContent>
                  <AlertDescription>{message()}</AlertDescription>
                </AlertContent>
              </Alert>
            )}
          </Show>
          <div class="vault-secret-actions">
            <Button
              type="submit"
              size="sm"
              loading={props.busy}
              disabled={token().trim() === "" || secret().trim() === ""}
            >
              {t("connector.line.connect")}
            </Button>
          </div>
        </form>
      </ItemGroup>
    </SettingsSection>
  );
}

const WEBHOOK_STEPS = [
  "connector.line.webhookStepTunnel",
  "connector.line.webhookStepSave",
  "connector.line.webhookStepEnable",
] as const satisfies readonly AppTextKey[];

function WebhookSection(props: {
  connection: MessagingConnection;
  account: LineAccount;
  busy: boolean;
  onSetPublicUrl: (publicUrl: string | null) => void;
}) {
  const { t } = useText();
  const [address, setAddress] = createSignal(props.account.publicUrl ?? "");
  const [invalid, setInvalid] = createSignal(false);
  createEffect(
    () => props.account.publicUrl,
    (publicUrl) => {
      setAddress(publicUrl ?? "");
      setInvalid(false);
    },
  );
  const save = () => {
    const normalized = parseLinePublicUrl(address());
    if (normalized === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    props.onSetPublicUrl(normalized);
  };
  const detail = () => {
    const { webhook, webhookReason, publicUrl } = props.account;
    if (webhook === "verified") return t("connector.line.webhookVerifiedDetail");
    if (webhook === "failed")
      return webhookReason
        ? t("connector.line.webhookFailedReason", { reason: webhookReason })
        : t("connector.line.webhookFailedNoReason");
    return publicUrl ? t("connector.line.webhookUnknownUrl") : t("connector.line.webhookUnknownNoUrl");
  };
  const title = () =>
    t(
      props.account.webhook === "verified"
        ? "connector.line.webhookVerified"
        : props.account.webhook === "failed"
          ? "connector.line.webhookFailed"
          : "connector.line.webhookUnknown",
    );
  const rowStatus = () => (props.account.webhook === "verified" ? "live" : "setup");
  return (
    <SettingsSection
      title={t("connector.line.webhookTitle", { account: props.connection.workspaceName })}
      description={t("connector.line.webhookDescription")}
    >
      <ItemGroup class="settings-modal-card">
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("connector.line.localAddress")}</ItemTitle>
            <ItemDescription>{props.account.localWebhookUrl}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <CopyButton
              value={props.account.localWebhookUrl}
              label={t("connector.line.copyAddress")}
              variant="outline"
              size="sm"
            />
          </ItemActions>
        </Item>
        <ol class="channel-checklist">
          <For each={WEBHOOK_STEPS}>
            {(step, index) => (
              <li>
                <span class="whatsapp-link-step-index" aria-hidden="true">
                  {index() + 1}
                </span>
                {t(step)}
              </li>
            )}
          </For>
        </ol>
        <form
          class="integration-card-body"
          novalidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.busy) save();
          }}
        >
          <Field
            label={t("connector.line.publicUrlLabel")}
            description={t("connector.line.publicUrlDescription")}
            error={invalid() ? t("error.messaging.linePublicUrlInvalid") : undefined}
          >
            <Input
              type="url"
              size="sm"
              autocomplete="off"
              spellcheck={false}
              maxlength={LINE_LIMITS.publicUrl}
              value={address()}
              onInput={(event) => {
                setAddress(event.currentTarget.value);
                setInvalid(false);
              }}
            />
          </Field>
          <div class="vault-secret-actions">
            <Button type="submit" size="sm" disabled={props.busy || address().trim() === ""}>
              {t("common.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.busy || props.account.publicUrl === null}
              onClick={() => props.onSetPublicUrl(null)}
            >
              {t("connector.line.clearUrl")}
            </Button>
          </div>
        </form>
        <Show
          when={props.account.webhook === "failed"}
          fallback={
            <Item class="settings-modal-row" data-status={rowStatus()}>
              <ItemContent>
                <ItemTitle>{title()}</ItemTitle>
                <ItemDescription>{detail()}</ItemDescription>
              </ItemContent>
            </Item>
          }
        >
          <Alert tone="danger" role="alert">
            <AlertContent>
              <AlertTitle>{title()}</AlertTitle>
              <AlertDescription>{detail()}</AlertDescription>
            </AlertContent>
          </Alert>
        </Show>
        <Text class="integration-card-note" variant="caption" tone="muted">
          {t("connector.line.onlineNote")}
        </Text>
      </ItemGroup>
    </SettingsSection>
  );
}

function RequestsSection(props: {
  connection: MessagingConnection;
  requests: readonly LinePendingRequest[];
  busy: boolean;
  onAnswer: (senderId: string, approve: boolean) => void;
}) {
  const { t, format } = useText();
  return (
    <SettingsSection
      title={t("connector.line.requestsTitle", { account: props.connection.workspaceName })}
      description={t("connector.line.requestsDescription")}
    >
      <ItemGroup class="settings-modal-card">
        <For each={props.requests}>
          {(request) => {
            const name = () => request.name || t("connector.line.unnamedPerson");
            const label = (action: string) => t("connector.line.rowAction", { action, name: name() });
            return (
              <Item class="settings-modal-row">
                <ItemMedia>
                  <LogoTile>
                    <UserRound aria-hidden="true" />
                  </LogoTile>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{name()}</ItemTitle>
                  <ItemDescription>
                    {t("connector.line.requestExpires", {
                      time: format.date(new Date(request.expiresAt), { dateStyle: "medium", timeStyle: "short" }),
                    })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={props.busy}
                    aria-label={label(t("connector.line.approve"))}
                    onClick={() => props.onAnswer(request.senderId, true)}
                  >
                    {t("connector.line.approve")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive-ghost"
                    disabled={props.busy}
                    aria-label={label(t("connector.line.deny"))}
                    onClick={() => props.onAnswer(request.senderId, false)}
                  >
                    {t("connector.line.deny")}
                  </Button>
                </ItemActions>
              </Item>
            );
          }}
        </For>
        <Show when={props.requests.length === 0}>
          <Text class="integration-card-note" variant="caption" tone="muted">
            {t("connector.line.requestsEmpty")}
          </Text>
        </Show>
      </ItemGroup>
    </SettingsSection>
  );
}

function SendersSection(props: {
  connection: MessagingConnection;
  senders: readonly LineSender[];
  busy: boolean;
  onRemove: (senderId: string) => void;
}) {
  const { t } = useText();
  const atCap = () => props.senders.length >= MESSAGING_LIMITS.allowedSenders;
  return (
    <SettingsSection
      title={t("connector.line.sendersTitle", { account: props.connection.workspaceName })}
      description={t("connector.line.sendersDescription")}
    >
      <ItemGroup class="settings-modal-card">
        <For each={props.senders}>
          {(sender) => {
            const name = () => sender.name || t("connector.line.unnamedPerson");
            return (
              <Item class="settings-modal-row">
                <ItemMedia>
                  <LogoTile>
                    <UserRound aria-hidden="true" />
                  </LogoTile>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{name()}</ItemTitle>
                  <ItemDescription>{shortId(sender.id)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive-ghost"
                    disabled={props.busy}
                    aria-label={t("connector.line.rowAction", { action: t("common.remove"), name: name() })}
                    onClick={() => props.onRemove(sender.id)}
                  >
                    {t("common.remove")}
                  </Button>
                </ItemActions>
              </Item>
            );
          }}
        </For>
        <Show when={props.senders.length === 0}>
          <Text class="integration-card-note" variant="caption" tone="muted">
            {t("connector.line.sendersEmpty")}
          </Text>
        </Show>
        <Show when={atCap()}>
          <Text class="integration-card-note" variant="caption" tone="muted">
            {t("connector.line.sendersLimit", { count: MESSAGING_LIMITS.allowedSenders })}
          </Text>
        </Show>
      </ItemGroup>
    </SettingsSection>
  );
}

function OrchestratorDialog(props: {
  open: boolean;
  account: string;
  busy: boolean;
  models?: LineOrchestratorModels | undefined;
  onAdd: (choice: LineOrchestratorChoice | null) => void;
  onClose: () => void;
}) {
  const { t } = useText();
  const [choice, setChoice] = createSignal<LineOrchestratorChoice | null>(null);
  createEffect(
    () => props.open,
    (open) => {
      if (open) setChoice(props.models?.initial ?? null);
    },
  );
  return (
    <WizardDialog
      open={props.open}
      closeLabel={t("connector.line.close")}
      onClose={props.onClose}
      logo={<LineTile />}
      link="connected"
      title={t("connector.line.agentStepTitle")}
      description={t("connector.line.agentStepDescription", { account: props.account })}
      footer={
        <>
          <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" size="sm" loading={props.busy} onClick={() => props.onAdd(choice())}>
            {t("connector.line.addAgent")}
          </Button>
        </>
      }
    >
      <ChannelOrchestratorStep
        text={LINE_TEXT}
        avatar={LINE_ORCHESTRATOR_AVATAR}
        models={props.models}
        choice={choice()}
        busy={props.busy}
        onChoose={setChoice}
      />
    </WizardDialog>
  );
}
