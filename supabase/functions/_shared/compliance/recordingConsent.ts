// supabase/functions/_shared/compliance/recordingConsent.ts
//
// NOT LEGAL ADVICE. Call-recording consent law is state-by-state, changes
// over time, and has carve-outs (business-line exceptions, beep-tone
// alternatives, etc). This gives the assistant a safe DEFAULT trigger to
// ask for consent out loud for the states most commonly cited as
// requiring all-party ("two-party") consent — it does not replace legal
// review for the specific states a customer operates in. Verify this
// list against current statutes/counsel before relying on it in
// production, and keep it updated as law changes.

// US area code -> state, limited to commonly-cited all-party-consent
// states. Not guaranteed exhaustive or current — see disclaimer above.
const ALL_PARTY_CONSENT_AREA_CODES: Record<string, string> = {
  // California
  "209":"CA","213":"CA","310":"CA","323":"CA","341":"CA","408":"CA","415":"CA","424":"CA","442":"CA","510":"CA","530":"CA","559":"CA","562":"CA","619":"CA","626":"CA","628":"CA","650":"CA","657":"CA","661":"CA","669":"CA","707":"CA","714":"CA","747":"CA","760":"CA","805":"CA","818":"CA","820":"CA","831":"CA","858":"CA","909":"CA","916":"CA","925":"CA","949":"CA","951":"CA",
  // Florida
  "239":"FL","305":"FL","321":"FL","352":"FL","386":"FL","407":"FL","561":"FL","727":"FL","754":"FL","772":"FL","786":"FL","813":"FL","850":"FL","863":"FL","904":"FL","941":"FL","954":"FL",
  // Pennsylvania
  "215":"PA","223":"PA","267":"PA","272":"PA","412":"PA","445":"PA","484":"PA","570":"PA","610":"PA","717":"PA","724":"PA","814":"PA","835":"PA","878":"PA",
  // Illinois
  "217":"IL","224":"IL","309":"IL","312":"IL","331":"IL","447":"IL","464":"IL","618":"IL","630":"IL","708":"IL","773":"IL","779":"IL","815":"IL","847":"IL","872":"IL",
  // Massachusetts
  "339":"MA","351":"MA","413":"MA","508":"MA","617":"MA","774":"MA","781":"MA","857":"MA","978":"MA",
  // Michigan
  "231":"MI","248":"MI","269":"MI","313":"MI","517":"MI","586":"MI","616":"MI","734":"MI","810":"MI","906":"MI","947":"MI","989":"MI",
  // Washington
  "206":"WA","253":"WA","360":"WA","425":"WA","509":"WA","564":"WA",
  // Maryland
  "227":"MD","240":"MD","301":"MD","410":"MD","443":"MD","667":"MD",
  // Connecticut
  "203":"CT","475":"CT","860":"CT","959":"CT",
  // Montana
  "406":"MT",
  // New Hampshire
  "603":"NH",
  // Delaware
  "302":"DE",
  // Nevada (narrower carve-outs than most on this list — verify specifically)
  "702":"NV","725":"NV","775":"NV",
};

const STATE_NAMES: Record<string, string> = {
  CA: "California", FL: "Florida", PA: "Pennsylvania", IL: "Illinois",
  MA: "Massachusetts", MI: "Michigan", WA: "Washington", MD: "Maryland",
  CT: "Connecticut", MT: "Montana", NH: "New Hampshire", DE: "Delaware", NV: "Nevada",
};

function extractUsAreaCode(callerNumber: string | null): string | null {
  if (!callerNumber) return null;
  const digits = callerNumber.replace(/\D/g, "");
  // NANP (+1) numbers only — international callers get no notice, since
  // this area-code heuristic doesn't apply outside the US/Canada anyway.
  const tenDigit = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (tenDigit.length !== 10) return null;
  return tenDigit.slice(0, 3);
}

/**
 * Returns the `recording_consent_context` template variable. Empty string
 * when the caller's area code isn't recognized as an all-party-consent
 * state (or can't be determined) — {{recording_consent_context}} then
 * renders as nothing, same no-op pattern as surge_context / after_hours_context.
 */
export function buildRecordingConsentNotice(callerNumber: string | null): string {
  const areaCode = extractUsAreaCode(callerNumber);
  if (!areaCode) return "";

  const state = ALL_PARTY_CONSENT_AREA_CODES[areaCode];
  if (!state) return "";

  const stateName = STATE_NAMES[state] ?? state;
  return (
    `This caller's number appears to be from ${stateName}, an all-party consent ` +
    `state for call recording. Before anything else, say: "Quick note before we ` +
    `get started \u2014 this call may be recorded for quality and training. Is that okay ` +
    `with you?" Wait for a clear yes before continuing. If the caller declines or ` +
    `objects, say recording will be turned off, use the request_human_transfer ` +
    `tool if available, and don't reference recording again for the rest of the call.`
  );
}
