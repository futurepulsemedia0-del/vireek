import type { MessageModel, Severity } from "./events.ts";
import { truncate } from "./events.ts";

export const TEAMS_ACTION_ACK = "ack";
export const TEAMS_ACTION_ASSIGN = "assign";
export const TEAMS_FIELD_TECH = "technicianId";

const CONTAINER_STYLE: Record<Severity, string> = {
  critical: "attention",
  warning: "warning",
  info: "accent",
  success: "good",
};

export interface TeamsCardMessage {
  type: "message";
  summary: string;
  attachments: { contentType: "application/vnd.microsoft.card.adaptive"; content: Record<string, unknown> }[];
}

export function buildTeamsMessage(m: MessageModel): TeamsCardMessage {
  const body: Record<string, unknown>[] = [
    {
      type: "Container",
      style: CONTAINER_STYLE[m.severity],
      bleed: true,
      items: [
        { type: "TextBlock", text: truncate(`${m.emoji} ${m.title}`, 150), weight: "Bolder", size: "Medium", wrap: true },
      ],
    },
    { type: "TextBlock", text: truncate(m.summary, 500), wrap: true, spacing: "Small" },
  ];

  if (m.fields.length) {
    body.push({
      type: "FactSet",
      facts: m.fields.map((f) => ({ title: truncate(f.label, 40), value: truncate(f.value, 300) })),
    });
  }
  if (m.status) {
    body.push({ type: "TextBlock", text: `✔︎ ${truncate(m.status, 200)}`, isSubtle: true, wrap: true, spacing: "Small" });
  }

  const actions: Record<string, unknown>[] = [];
  if (m.actions.includes("acknowledge")) {
    actions.push({
      type: "Action.Submit",
      title: "Acknowledge",
      style: "positive",
      data: { vk: TEAMS_ACTION_ACK, e: m.eventId },
    });
  }
  if (m.actions.includes("assign") && m.technicians.length) {
    body.push({
      type: "Input.ChoiceSet",
      id: TEAMS_FIELD_TECH,
      style: "compact",
      placeholder: "Assign to…",
      choices: m.technicians.map((t) => ({ title: truncate(t.name, 75), value: t.id })),
    });
    actions.push({
      type: "Action.Submit",
      title: "Assign",
      data: { vk: TEAMS_ACTION_ASSIGN, e: m.eventId },
    });
  }
  actions.push({ type: "Action.OpenUrl", title: m.link.label, url: m.link.url });

  return {
    type: "message",
    summary: truncate(`${m.title}: ${m.summary}`, 200),
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body,
          actions,
        },
      },
    ],
  };
}
