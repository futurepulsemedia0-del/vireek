import type { MessageModel } from "./events.ts";
import { truncate } from "./events.ts";

export const SLACK_ACTION_ACK = "vk_ack";
export const SLACK_ACTION_ASSIGN = "vk_assign";
export const SLACK_BLOCK_PREFIX = "vk:";

/** Slack mrkdwn requires only these three characters to be escaped. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function eventIdFromBlockId(blockId: unknown): string | null {
  if (typeof blockId !== "string" || !blockId.startsWith(SLACK_BLOCK_PREFIX)) return null;
  const id = blockId.slice(SLACK_BLOCK_PREFIX.length);
  return /^[0-9a-fA-F-]{36}$/.test(id) ? id : null;
}

export interface SlackMessage {
  text: string;
  blocks: Record<string, unknown>[];
}

export function buildSlackMessage(m: MessageModel): SlackMessage {
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: truncate(`${m.emoji} ${m.title}`, 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: escapeSlack(m.summary) } },
  ];

  if (m.fields.length) {
    blocks.push({
      type: "section",
      fields: m.fields.slice(0, 10).map((f) => ({
        type: "mrkdwn",
        text: truncate(`*${escapeSlack(f.label)}*\n${escapeSlack(f.value)}`, 1900),
      })),
    });
  }

  if (m.status) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `✔︎ ${escapeSlack(m.status)}` }] });
  }

  const elements: Record<string, unknown>[] = [];
  if (m.actions.includes("acknowledge")) {
    elements.push({
      type: "button",
      action_id: SLACK_ACTION_ACK,
      style: "primary",
      text: { type: "plain_text", text: "Acknowledge", emoji: true },
      value: m.eventId,
    });
  }
  if (m.actions.includes("assign") && m.technicians.length) {
    elements.push({
      type: "static_select",
      action_id: SLACK_ACTION_ASSIGN,
      placeholder: { type: "plain_text", text: "Assign to…", emoji: true },
      options: m.technicians.map((t) => ({
        text: { type: "plain_text", text: truncate(t.name, 75) },
        value: t.id,
      })),
    });
  }
  elements.push({
    type: "button",
    action_id: "vk_open",
    text: { type: "plain_text", text: m.link.label, emoji: true },
    url: m.link.url,
  });
  blocks.push({ type: "actions", block_id: `${SLACK_BLOCK_PREFIX}${m.eventId}`, elements });

  return { text: truncate(`${m.emoji} ${m.title}: ${m.summary}`, 300), blocks };
}
