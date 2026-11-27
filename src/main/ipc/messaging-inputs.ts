import type {
  AddMessagingOrchestratorInput,
  AddTelegramOrchestratorInput,
  AnswerLineRequestInput,
  AnswerWhatsAppRequestInput,
  ConnectLineInput,
  ConnectorMessagingPlatform,
  ConnectTelegramChatInput,
  HostAddMessagingOrchestratorInput,
  HostMessagingConnectInput,
  HostMessagingPlatformInput,
  HostMessagingWorkspaceInput,
  HostSetMessagingEnabledInput,
  MessagingWorkspaceInput,
  RemoveLineSenderInput,
  RemoveWhatsAppSenderInput,
  SetDiscordAccessInput,
  SetLinePublicUrlInput,
  SetMessagingEnabledInput,
  SetWhatsAppOwnNumberInput,
  SetWhatsAppSenderReadOnlyInput,
  SetWhatsAppStatusReactionsInput,
  SetWhatsAppWorkingMessageInput,
  StartWhatsAppLinkInput,
  WhatsAppSenderInput,
} from "@openbot/contracts/ipc";
import {
  CONNECTOR_MESSAGING_PLATFORMS,
  isAgentModel,
  isAgentProvider,
  isReasoningEffort,
  isWhatsAppSender,
  LINE_LIMITS,
  parseDiscordAllowedRoles,
  parseLineCredential,
  parseLinePublicUrl,
  parseWhatsAppPhoneNumber,
  parseWhatsAppRequestCode,
} from "@openbot/contracts/ipc";
import { isBoolean, isOneOf } from "@openbot/contracts/runtime-values";
import { isObject, requireString } from "./validation";

export function parseMessagingWorkspaceInput(value: unknown): MessagingWorkspaceInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id") };
}

export function parseSetMessagingEnabledInput(value: unknown): SetMessagingEnabledInput {
  if (!isObject(value) || !isBoolean(value.enabled)) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id"), enabled: value.enabled };
}

export function parseConnectTelegramChatInput(value: unknown): ConnectTelegramChatInput {
  if (!isObject(value) || (value.place !== "group" && value.place !== "direct"))
    throw new Error("A messaging request is invalid.");
  return { place: value.place };
}

export function parseAddMessagingOrchestratorInput(value: unknown): AddMessagingOrchestratorInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id"), ...parseAddTelegramOrchestratorInput(value) };
}

export function parseAddTelegramOrchestratorInput(value: unknown): AddTelegramOrchestratorInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  const result: AddTelegramOrchestratorInput = {};
  if (value.provider !== undefined) {
    if (!isAgentProvider(value.provider)) throw new Error("A messaging request is invalid.");
    result.provider = value.provider;
  }
  if (value.model !== undefined) {
    if (!isAgentModel(value.model)) throw new Error("A messaging request is invalid.");
    result.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!isReasoningEffort(value.reasoningEffort)) throw new Error("A messaging request is invalid.");
    result.reasoningEffort = value.reasoningEffort;
  }
  return result;
}

function parsePlatform(value: unknown): ConnectorMessagingPlatform {
  if (!isOneOf(CONNECTOR_MESSAGING_PLATFORMS, value)) throw new Error("A messaging request is invalid.");
  return value;
}

export function parseHostMessagingPlatformInput(value: unknown): HostMessagingPlatformInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { platform: parsePlatform(value.platform) };
}

export function parseHostMessagingConnectInput(value: unknown): HostMessagingConnectInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  if (value.place !== null && value.place !== "group" && value.place !== "direct")
    throw new Error("A messaging request is invalid.");
  return { platform: parsePlatform(value.platform), place: value.place };
}

export function parseHostMessagingWorkspaceInput(value: unknown): HostMessagingWorkspaceInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { platform: parsePlatform(value.platform), ...parseMessagingWorkspaceInput(value) };
}

export function parseHostSetMessagingEnabledInput(value: unknown): HostSetMessagingEnabledInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { platform: parsePlatform(value.platform), ...parseSetMessagingEnabledInput(value) };
}

export function parseHostAddMessagingOrchestratorInput(value: unknown): HostAddMessagingOrchestratorInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return {
    platform: parsePlatform(value.platform),
    workspaceId: value.workspaceId === null ? null : requireString(value.workspaceId, "Workspace id"),
  };
}

export function parseSetDiscordAccessInput(value: unknown): SetDiscordAccessInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  const allowedRoles = parseDiscordAllowedRoles(value.allowedRoles);
  if (!allowedRoles) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id"), allowedRoles };
}

export function parseStartWhatsAppLinkInput(value: unknown): StartWhatsAppLinkInput {
  if (!isObject(value) || (value.method !== "qr" && value.method !== "code") || !isBoolean(value.ownNumber))
    throw new Error("A messaging request is invalid.");
  if (value.method === "qr") return { method: "qr", phoneNumber: null, ownNumber: value.ownNumber };
  const phoneNumber = parseWhatsAppPhoneNumber(value.phoneNumber);
  if (!phoneNumber) throw new Error("A messaging request is invalid.");
  return { method: "code", phoneNumber, ownNumber: value.ownNumber };
}

export function parseWhatsAppSenderInput(value: unknown): WhatsAppSenderInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  const sender =
    isObject(value.sender) && value.sender.kind === "contact"
      ? { ...value.sender, id: parseWhatsAppPhoneNumber(value.sender.id) ?? "" }
      : value.sender;
  if (!isWhatsAppSender(sender)) throw new Error("A messaging request is invalid.");
  return {
    workspaceId: requireString(value.workspaceId, "Workspace id"),
    sender: { id: sender.id, kind: sender.kind, name: sender.name.trim() || sender.id },
  };
}

export function parseRemoveWhatsAppSenderInput(value: unknown): RemoveWhatsAppSenderInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return {
    workspaceId: requireString(value.workspaceId, "Workspace id"),
    senderId: requireString(value.senderId, "Sender id"),
  };
}

export function parseAnswerWhatsAppRequestInput(value: unknown): AnswerWhatsAppRequestInput {
  if (!isObject(value) || !isBoolean(value.approve)) throw new Error("A messaging request is invalid.");
  const code = parseWhatsAppRequestCode(value.code);
  if (!code) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id"), code, approve: value.approve };
}

export function parseSetWhatsAppOwnNumberInput(value: unknown): SetWhatsAppOwnNumberInput {
  if (!isObject(value) || !isBoolean(value.ownNumber)) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id"), ownNumber: value.ownNumber };
}

export function parseSetWhatsAppWorkingMessageInput(value: unknown): SetWhatsAppWorkingMessageInput {
  if (!isObject(value) || !isBoolean(value.workingMessage)) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id"), workingMessage: value.workingMessage };
}

export function parseSetWhatsAppStatusReactionsInput(value: unknown): SetWhatsAppStatusReactionsInput {
  if (!isObject(value) || !isBoolean(value.statusReactions)) throw new Error("A messaging request is invalid.");
  return { workspaceId: requireString(value.workspaceId, "Workspace id"), statusReactions: value.statusReactions };
}

export function parseSetWhatsAppSenderReadOnlyInput(value: unknown): SetWhatsAppSenderReadOnlyInput {
  if (!isObject(value) || !isBoolean(value.readOnly)) throw new Error("A messaging request is invalid.");
  return {
    workspaceId: requireString(value.workspaceId, "Workspace id"),
    senderId: requireString(value.senderId, "Sender id"),
    readOnly: value.readOnly,
  };
}

const IDENTIFIER_SAFE = /^[\w.@:-]+$/u;

function parseLineIdentifier(value: unknown): string {
  const id = requireString(value, "Identifier");
  if (!IDENTIFIER_SAFE.test(id)) throw new Error("A messaging request is invalid.");
  return id;
}

export function parseConnectLineInput(value: unknown): ConnectLineInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  const channelAccessToken = parseLineCredential(value.channelAccessToken, LINE_LIMITS.channelAccessToken);
  const channelSecret = parseLineCredential(value.channelSecret, LINE_LIMITS.channelSecret);
  if (!channelAccessToken || !channelSecret) throw new Error("A messaging request is invalid.");
  return { channelAccessToken, channelSecret };
}

export function parseLineWorkspaceInput(value: unknown): MessagingWorkspaceInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { workspaceId: parseLineIdentifier(value.workspaceId) };
}

export function parseSetLineEnabledInput(value: unknown): SetMessagingEnabledInput {
  if (!isObject(value) || !isBoolean(value.enabled)) throw new Error("A messaging request is invalid.");
  return { workspaceId: parseLineIdentifier(value.workspaceId), enabled: value.enabled };
}

export function parseRemoveLineSenderInput(value: unknown): RemoveLineSenderInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  return { workspaceId: parseLineIdentifier(value.workspaceId), senderId: parseLineIdentifier(value.senderId) };
}

export function parseAnswerLineRequestInput(value: unknown): AnswerLineRequestInput {
  if (!isObject(value) || !isBoolean(value.approve)) throw new Error("A messaging request is invalid.");
  return {
    workspaceId: parseLineIdentifier(value.workspaceId),
    senderId: parseLineIdentifier(value.senderId),
    approve: value.approve,
  };
}

export function parseSetLinePublicUrlInput(value: unknown): SetLinePublicUrlInput {
  if (!isObject(value)) throw new Error("A messaging request is invalid.");
  const workspaceId = parseLineIdentifier(value.workspaceId);
  if (value.publicUrl === null) return { workspaceId, publicUrl: null };
  const publicUrl = parseLinePublicUrl(value.publicUrl);
  if (!publicUrl) throw new Error("A messaging request is invalid.");
  return { workspaceId, publicUrl };
}
