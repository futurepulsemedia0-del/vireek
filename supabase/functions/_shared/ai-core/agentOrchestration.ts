// supabase/functions/_shared/ai-core/agentOrchestration.ts
//
// "AI Agent Orchestration" — splits the single "Sarah" assistant into a Vapi
// Squad of specialized agents that hand off to each other mid-call, instead
// of one assistant trying to be a router + scheduler + emergency triage +
// pricing desk + account lookup all at once. Smaller, focused prompts per
// turn -> less hallucination, lower token cost, lower latency. See
// https://docs.vapi.ai/squads
//
// HOW THIS PLUGS INTO THE EXISTING SINGLE-ASSISTANT SETUP
// ---------------------------------------------------------------------------
// It intentionally reuses the ONE saved Vapi assistant per tenant
// (`tenant.assistantId`) as every squad member's `assistantId`, instead of
// creating 5 separate assistants per business in the Vapi dashboard. Every
// member shares the same voice, phone number config, and base system
// prompt template already configured there — we only swap two template
// variables per member:
//
//   {{agent_role_name}}          -> e.g. "Scheduler"
//   {{agent_role_instructions}}  -> that role's job + boundaries
//
// so the ONLY manual step required per business, in the Vapi dashboard, is
// adding these two lines somewhere in the existing system prompt (once),
// right under where {{caller_context}} is already referenced:
//
//   You are currently acting as: {{agent_role_name}}.
//   {{agent_role_instructions}}
//
// If a tenant hasn't added those two lines yet, this still doesn't break
// anything — Vapi just renders the placeholders as empty text, so that
// tenant's squad members behave like the old single-assistant prompt until
// they update it.
//
// NOT LIVE-VERIFIED against a real Vapi account (same caveat already in
// vapi-webhook/index.ts — I don't have live access to re-check
// docs.vapi.ai at the moment this was written). Two things worth
// confirming on a real test call before trusting this in production:
//   1. That `assistantOverrides.name` actually renames a squad member for
//      handoff-by-assistantName matching (used below). If Vapi ignores a
//      name override on a saved (non-transient) assistant, the fix is to
//      save the 5 roles as 5 separately-named Vapi assistants instead and
//      swap `assistantId` per member — the rest of this file's shape
//      (variable values, handoff destinations) doesn't change either way.
//   2. That "tools:append" (a literal object key, not a nested field) is
//      still the current way to add a handoff tool on top of a saved
//      assistant's existing tools via assistantOverrides.
// ---------------------------------------------------------------------------

export interface AgentRoleDef {
  key: string;
  displayName: string;
  instructions: string;
  handoffTo: { key: string; description: string }[];
}

const ROUTER: AgentRoleDef = {
  key: "router",
  displayName: "Router",
  instructions:
    "Your ONLY job right now is to figure out, in as few questions as possible, what the caller needs, then silently hand off to the right specialist — never say goodbye or announce a transfer, the caller should feel like one continuous conversation. Ask one short clarifying question if intent is unclear. As soon as intent is clear, call the matching handoff tool immediately — do not attempt to book, quote, or answer detailed questions yourself.",
  handoffTo: [
    { key: "emergency", description: "Caller describes an urgent, unsafe, or active-damage situation (e.g. active leak, no heat in freezing weather, gas smell, sparking, flooding) that needs immediate triage." },
    { key: "scheduler", description: "Caller wants to book, reschedule, or cancel an appointment and there is no active emergency." },
    { key: "pricing", description: "Caller is asking about pricing, service cost, what's included, or general questions about services offered, before they're ready to book." },
    { key: "account", description: "Caller is an existing customer asking about a past job, warranty, invoice, or their account/history." },
  ],
};

const SCHEDULER: AgentRoleDef = {
  key: "scheduler",
  displayName: "Scheduler",
  instructions:
    "You are the booking specialist. Collect what you need (service needed, address, best time window) and use the book_appointment tool to confirm a real slot — never invent availability. If the caller reveals mid-booking that this is actually urgent/unsafe, hand off to the emergency specialist immediately instead of continuing to book normally. If they start asking detailed pricing questions you can't answer confidently, hand off to the pricing specialist — they'll route back to finish booking.",
  handoffTo: [
    { key: "emergency", description: "Mid-booking, the caller reveals this is actually urgent or unsafe." },
    { key: "pricing", description: "Caller has a pricing/cost question that needs the pricing specialist." },
    { key: "account", description: "Caller needs their existing job/warranty history looked up before booking." },
  ],
};

const EMERGENCY: AgentRoleDef = {
  key: "emergency",
  displayName: "Emergency Triage",
  instructions:
    "You handle urgent, safety-relevant calls. Stay calm and direct. Get the address and a one-line description of the hazard fast, use the flag_emergency_call tool immediately, and if the situation needs a live person right now, use request_human_transfer rather than continuing to gather non-essential details. Do not spend time on pricing or general chit-chat.",
  handoffTo: [
    { key: "scheduler", description: "The emergency has been flagged/handled and the caller now just needs a follow-up appointment booked." },
  ],
};

const PRICING: AgentRoleDef = {
  key: "pricing",
  displayName: "Pricing & Info",
  instructions:
    "You answer pricing, service-scope, and general knowledge-base questions using the lookup_price and search_knowledge tools — never state a number that didn't come from a tool result. Once the caller is satisfied and ready to move forward, hand off to the scheduler to actually book.",
  handoffTo: [
    { key: "scheduler", description: "Caller is ready to book after getting pricing/info." },
    { key: "emergency", description: "The question turns out to describe an urgent/unsafe situation." },
  ],
};

const ACCOUNT: AgentRoleDef = {
  key: "account",
  displayName: "Account & History",
  instructions:
    "You help existing customers with questions about a past job, warranty coverage, or invoice, using the lookup_customer tool. If they need a new appointment after this, hand off to the scheduler; if what they describe is urgent, hand off to emergency triage instead.",
  handoffTo: [
    { key: "scheduler", description: "Existing customer now wants a new appointment booked." },
    { key: "emergency", description: "What they describe turns out to be urgent/unsafe." },
  ],
};

const ALL_ROLES: AgentRoleDef[] = [ROUTER, SCHEDULER, EMERGENCY, PRICING, ACCOUNT];

function squadMemberName(assistantName: string | null, role: AgentRoleDef): string {
  const base = assistantName?.trim() || "Sarah";
  // The Router keeps the plain business assistant name (that's who greets
  // the caller); other roles get a suffixed internal name so handoff
  // destinations can address them uniquely. Callers never hear these names.
  return role.key === "router" ? base : `${base}-${role.displayName.replace(/\s+/g, "")}`;
}

/**
 * Builds a transient Vapi `squad` payload for the `assistant-request`
 * response, reusing one saved assistant as every member. `sharedVariableValues`
 * should be the same variable-values object you'd otherwise put in
 * `assistantOverrides.variableValues` for the single-assistant path
 * (caller_context, customer_type_context, surge_context, etc.) — every
 * squad member gets these plus its own agent_role_name / agent_role_instructions.
 */
export function buildAgentSquad(
  assistantId: string,
  assistantName: string | null,
  sharedVariableValues: Record<string, string>,
) {
  const nameByKey = new Map(ALL_ROLES.map((r) => [r.key, squadMemberName(assistantName, r)]));

  const members = ALL_ROLES.map((role) => {
    const overrides: Record<string, unknown> = {
      name: nameByKey.get(role.key),
      variableValues: {
        ...sharedVariableValues,
        agent_role_name: role.displayName,
        agent_role_instructions: role.instructions,
      },
    };
    if (role.handoffTo.length > 0) {
      overrides["tools:append"] = [
        {
          type: "handoff",
          destinations: role.handoffTo.map((d) => ({
            type: "assistant",
            assistantName: nameByKey.get(d.key),
            description: d.description,
          })),
        },
      ];
    }
    return { assistantId, assistantOverrides: overrides };
  });

  return { members };
}
