import type { LineAccount, MessagingConnection } from "@openbot/contracts/ipc";
import type { LineIntegrationAgent } from "@openbot/ui/features/settings/LineIntegrationPanel";
import { LineIntegrationPanel } from "@openbot/ui/features/settings/LineIntegrationPanel";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENT_SUMMARIES } from "./fixtures";
import { SettledArgs } from "./settled-args";

const meta = {
  title: "Settings/LineIntegrationPanel",
  component: LineIntegrationPanel,
  parameters: { layout: "padded", a11y: { test: "error" } },
  render: (args) => <SettledArgs>{() => <LineIntegrationPanel {...args} />}</SettledArgs>,
} satisfies Meta<typeof LineIntegrationPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const AGENTS: LineIntegrationAgent[] = STORY_AGENT_SUMMARIES.map((agent) => ({
  id: agent.id,
  name: agent.name,
  title: agent.title,
  avatarSeed: agent.avatarSeed,
  avatarHue: agent.avatarHue,
  avatarUrl: null,
}));

const ORCHESTRATOR: LineIntegrationAgent = {
  id: "agent-line-orchestrator",
  name: "LINE Orchestrator",
  title: "Answers in LINE and asks the team",
  avatarSeed: "line-orchestrator",
  avatarHue: 100,
  avatarUrl: null,
};

const WORKSPACE_ID = "U00000000000000000000000000000001";

const connection = (update: Partial<MessagingConnection> = {}): MessagingConnection => ({
  workspaceId: WORKSPACE_ID,
  platform: "line",
  enabled: true,
  state: "connected",
  workspaceName: "Acme Support",
  botUserId: WORKSPACE_ID,
  missingScopes: [],
  retryAt: null,
  credentials: "saved",
  orchestratorAgentId: ORCHESTRATOR.id,
  ...update,
});

const account = (update: Partial<LineAccount> = {}): LineAccount => ({
  workspaceId: WORKSPACE_ID,
  webhook: "verified",
  webhookReason: null,
  webhookPort: 3101,
  localWebhookUrl: "http://127.0.0.1:3101/line/webhook",
  publicUrl: "https://line.example.com",
  quotaExceeded: false,
  allowedSenders: [],
  pendingRequests: [],
  ...update,
});

const args = (connections: MessagingConnection[], accounts: LineAccount[], connectError: string | null = null) => ({
  agents: [ORCHESTRATOR, ...AGENTS],
  connections,
  accounts,
  busy: false,
  connectError,
  onConnect: fn(),
  onDisconnectAccount: fn(),
  onDisconnectAll: fn(),
  onReconnect: fn(),
  onSetEnabled: fn(),
  onSetPublicUrl: fn(),
  onAddOrchestrator: fn(),
  onAnswerRequest: fn(),
  onRemoveSender: fn(),
});

export const NotConnected: Story = { args: args([], []) };

export const ConnectError: Story = {
  args: args([], [], "LINE did not accept the channel access token. Copy it again from the LINE Developers Console."),
};

export const WebhookUnknown: Story = {
  args: args([connection()], [account({ webhook: "unknown", publicUrl: null })]),
};

export const WebhookVerified: Story = { args: args([connection()], [account()]) };

export const WebhookFailed: Story = {
  args: args([connection()], [account({ webhook: "failed", webhookReason: "Could not connect to the server" })]),
};

export const PeopleAndRequests: Story = {
  args: args(
    [connection()],
    [
      account({
        allowedSenders: [{ id: "U00000000000000000000000000000a11", name: "Ada Lovelace" }],
        pendingRequests: [
          {
            senderId: "U00000000000000000000000000000b22",
            name: "Grace Hopper",
            expiresAt: "2026-10-30T15:00:00.000Z",
          },
          { senderId: "U00000000000000000000000000000c33", name: "", expiresAt: "2026-10-30T15:10:00.000Z" },
        ],
      }),
    ],
  ),
};

export const MonthlyLimitReached: Story = { args: args([connection()], [account({ quotaExceeded: true })]) };

export const NoOrchestrator: Story = {
  args: args([connection({ orchestratorAgentId: null })], [account()]),
};
