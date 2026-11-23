export interface LineCredentials {
  channelAccessToken: string;
  channelSecret: string;
  workspaceId: string;
  webhookPort: number;
  publicUrl: string | null;
}

export function lineCredentials(values: Record<string, string>): LineCredentials {
  const port = Number(values.webhookPort);
  return {
    channelAccessToken: values.channelAccessToken ?? "",
    channelSecret: values.channelSecret ?? "",
    workspaceId: values.workspaceId ?? "",
    webhookPort: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0,
    publicUrl: values.publicUrl || null,
  };
}
