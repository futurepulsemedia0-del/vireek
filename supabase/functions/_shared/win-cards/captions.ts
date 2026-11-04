// supabase/functions/_shared/win-cards/captions.ts
// Human, plain captions. No exclamation marks, no superlatives, no emoji. Built ONLY from PublicFields,
// so a caption can never contain anything the card itself does not already show.

import type { PublicFields } from "./types.ts";

export function suggestCaptions(p: PublicFields): string[] {
  const biz = p.businessName;
  const value = p.valueText ? ` (${p.valueText.charAt(0).toLowerCase()}${p.valueText.slice(1)})` : "";
  const when = p.timeBucketText ? ` ${p.timeBucketText.charAt(0).toLowerCase()}${p.timeBucketText.slice(1)}` : "";
  const lead = biz ? `${biz}: ` : "";
  switch (p.trigger) {
    case "after_hours_booking":
      return [
        `${lead}A customer called after hours${when} and got a booking instead of voicemail${value}.`,
        `${lead}Nobody was in the office, and the call still ended with a scheduled visit${value}.`,
        `A small thing we are glad about: an after-hours call turned into a booked job${value}.`,
      ];
    case "emergency_handled":
      return [
        `${lead}An emergency call came in${when}. It was answered and a visit was booked${value}.`,
        `${lead}Someone had a real problem${when}, and they reached us right away${value}.`,
        `Thank you to the team for being ready for the calls that cannot wait${value}.`,
      ];
    case "recovered_large_job":
      return [
        `${lead}We missed a call, followed up, and won the job back${value}.`,
        `${lead}A missed call became a larger job because someone followed up${value}.`,
        `Following up on missed calls is paying off for us${value}.`,
      ];
    case "milestone_calls":
      return [
        `${lead}${p.headline} Thank you to everyone who called.`,
        `${lead}${p.headline} Thank you to the team behind every one of them.`,
        `Quietly proud of this one. ${p.headline}`,
      ];
    case "speed_to_lead_record":
      return [
        `${lead}${p.detail ?? "A new lead was reached quickly."} It is our best response time so far.`,
        `${lead}Faster follow-up is working. This is our quickest response yet.`,
        `A new personal best for how quickly we reach new leads.`,
      ];
    case "five_star_ai_job":
      return [
        `${lead}A customer's first contact was an answered call, and they left a 5-star review.`,
        `${lead}From a phone call to a finished job to a 5-star review. Thank you.`,
        `Good to see the whole experience land well, starting with the first call.`,
      ];
  }
}
