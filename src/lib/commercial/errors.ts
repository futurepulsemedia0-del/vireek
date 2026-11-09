/** Maps database error codes raised by the commercial pack RPCs to plain-language messages (PURE). */
const MESSAGES: Record<string, string> = {
  pack_disabled: 'The Commercial pack is not turned on for this account.',
  not_permitted: 'You do not have permission to do that.',
  site_not_permitted: 'You do not have access to that site.',
  not_authenticated: 'Please sign in again.',
  job_not_found: 'That job was not found.',
  policy_not_found: 'That SLA policy was not found or is inactive.',
  job_not_covered_by_contract: 'That job belongs to a different customer than the contract.',
  timer_not_found: 'That timer was not found.',
  work_order_not_found: 'That work order was not found.',
  work_order_already_started: 'Work has already started on this work order; approval can no longer be requested.',
  amount_exceeds_nte: 'The amount is above the work order’s not-to-exceed cap.',
  not_pending: 'This request has already been decided.',
  self_approval_not_allowed: 'You cannot approve a request you made.',
  insufficient_role: 'This step needs a higher approval role (for example the account owner).',
  already_decided: 'You already decided an earlier step of this request.',
  request_not_found: 'That approval request was not found.',
  invalid_period: 'Choose a period of at most one year, with the end after the start.',
  customer_not_found: 'That customer was not found.',
  statement_not_found: 'That statement was not found.',
  contract_not_found: 'That contract was not found.',
};

export function friendlyCommercialError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '');
  for (const [code, text] of Object.entries(MESSAGES)) if (raw.includes(code)) return text;
  return 'Something went wrong. Please try again.';
}
