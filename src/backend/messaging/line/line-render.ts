import { chunkMarkdown, FENCE } from "../messaging-chunks";

export const LINE_TEXT_LIMIT = 5_000;
export const LINE_MESSAGES_PER_CALL = 5;

export interface LineTextMessage {
  type: "text";
  text: string;
}

export function lineMessageBatches(markdown: string): LineTextMessage[][] {
  const messages = chunkMarkdown(markdown, LINE_TEXT_LIMIT)
    .map(lineText)
    .filter((text) => text.trim() !== "")
    .map((text): LineTextMessage => ({ type: "text", text }));
  const batches: LineTextMessage[][] = [];
  for (let index = 0; index < messages.length; index += LINE_MESSAGES_PER_CALL)
    batches.push(messages.slice(index, index + LINE_MESSAGES_PER_CALL));
  return batches;
}

export function lineText(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith(FENCE)) {
      inFence = !inFence;
      continue;
    }
    out.push(inFence ? line : inlineLine(line));
  }
  return out.join("\n").trim();
}

function inlineLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
  const body = heading ? (heading[1] ?? "") : line;
  const plain = body
    .split(/(`[^`]+`)/u)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1 ? part.slice(1, -1) : inlineText(part),
    )
    .join("");
  return heading ? plain.trim() : plain.replace(/^(\s*)[*+-]\s+/u, "$1• ");
}

function inlineText(text: string): string {
  return text
    .replace(/!?\[([^\]]+)\]\((\S+?)\)/gu, (_match, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/\*\*(.+?)\*\*|__(.+?)__/gu, (_match, a: string | undefined, b: string | undefined) => a ?? b ?? "")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/gu, "$1$2")
    .replace(/~~(.+?)~~/gu, "$1");
}
