// supabase/functions/_shared/ai-core/reviewReply.ts
//
// Drafts a public reply to a customer review through the shared Vireek AI
// router (task "review_reply"). The draft is ADVISORY: a person always reviews
// and sends it. The review text is untrusted data (fenced in the prompt), the
// output is parsed + length-bounded, and when the AI layer is unavailable the
// caller falls back to a clearly-labelled deterministic template.

import { askVireekAi } from "./index.ts";
import {
  buildReplyPrompt,
  parseDraft,
  replyWarnings,
  templateReply,
  type Platform,
  type ReplyContext,
  type ReplyWarning,
} from "../reputation/engine.ts";

export interface DraftInput {
  platform: Platform;
  rating: number;
  reviewer_name: string;
  body: string | null;
}

export interface DraftResult {
  reply: string;
  source: "ai" | "template";
  flags: string[];
  warnings: ReplyWarning[];
}

export async function draftReviewReply(review: DraftInput, ctx: ReplyContext): Promise<DraftResult> {
  try {
    const result = await askVireekAi({
      task: "review_reply",
      jsonMode: true,
      maxTokens: 500,
      temperature: 0.5,
      timeoutMs: 20_000,
      messages: [{ role: "user", content: buildReplyPrompt(review, ctx) }],
    });
    const parsed = parseDraft(result.text);
    if (parsed) {
      return { reply: parsed.reply, source: "ai", flags: parsed.flags, warnings: replyWarnings(parsed.reply) };
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "review_reply_ai_failed", error: e instanceof Error ? e.message : String(e) }));
  }
  const reply = templateReply(review, ctx);
  return { reply, source: "template", flags: [], warnings: replyWarnings(reply) };
}
