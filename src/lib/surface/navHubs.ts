import type { PillarId } from './surface';

/**
 * Second level of the sidebar. The 5 pillars hold ~430 routes, so each pillar is split into a few
 * task-shaped hubs (one collapsible group each). A route is placed by the FIRST hub in its pillar whose
 * `test` matches its original nav label; anything unmatched lands in that pillar's "More" hub, so
 * no route can ever disappear from the menu.
 */
export interface HubDef {
  id: string;
  pillar: PillarId;
  label: string;
  test: RegExp;
}

const NEVER = /$^/;

export const HUBS: HubDef[] = [
  // ── Answer ────────────────────────────────────────────────────────────────
  { id: 'answer-calls', pillar: 'answer', label: 'Calls & inbox', test: /^(live calls|wallboard|call history|call queue|live copilot|csr phone desk|inbox|voicemails|team chat)/i },
  { id: 'answer-leads', pillar: 'answer', label: 'Leads & outreach', test: /lead|outbound|dialer|voicemail drops|agent callers|widget|call tracking/i },
  { id: 'answer-phone', pillar: 'answer', label: 'Phone system', test: /phone|number|voice platform|blocklist|routing|call flows|call masking|notification/i },
  { id: 'answer-insights', pillar: 'answer', label: 'Insights', test: /quality|leak|command center|insights|ask vireek|intelligence/i },

  // ── Book & Dispatch ───────────────────────────────────────────────────────
  { id: 'dispatch-network', pillar: 'dispatch', label: 'Network & marketplace', test: /contractor|emergency network|mutual aid|exchange|skill market|labor marketplace|talent network|third-party|open job board|trust passport|ai parts market/i },
  { id: 'dispatch-fleet', pillar: 'dispatch', label: 'Fleet & vehicles', test: /fleet|vehicle|fuel cards|card purchases|telematics|live map|truck operations/i },
  { id: 'dispatch-inventory', pillar: 'dispatch', label: 'Parts & suppliers', test: /parts|inventory|cycle counts|vendor|tool crib|supplier|procurement/i },
  { id: 'dispatch-compliance', pillar: 'dispatch', label: 'Compliance & risk', test: /compliance|permit|refrigerant|insurance|risk|privacy|safety data|break compliance|recall|evidence chain/i },
  { id: 'dispatch-workforce', pillar: 'dispatch', label: 'Technicians & training', test: /technician|capacity|staffing|retention|apprentice|sop|time off|knowledge|trade (packs|playbooks)|expert assist|video sessions/i },
  { id: 'dispatch-equipment', pillar: 'dispatch', label: 'Equipment & properties', test: /equipment|passport|tags|home|property|oem|building telemetry|service twins|predictive|preventive|energy|adaptive diagnostic|diagnosis|repair vs replace|field intelligence|regional demand|weather surge/i },
  { id: 'dispatch-field', pillar: 'dispatch', label: 'Field work & reports', test: /inspection|summar|findings|sketch|install|change orders|closeout|form builder|templates|gallery|documents|field|evidence|callback|autopsy|first-time-fix|remote resolution|service catalog|trade/i },
  { id: 'dispatch-schedule', pillar: 'dispatch', label: 'Schedule & dispatch', test: /calendar|jobs?\b|dispatch|routing|service areas|on-call|tasks|my day|weekly schedule|recurring|work orders|handoff|emergency operations/i },

  // ── Grow & Get Paid ───────────────────────────────────────────────────────
  { id: 'grow-money', pillar: 'grow', label: 'Billing & payments', test: /invoic|receivable|collections|statements|payment|pay by bank|disputes|financ|vireek pay|refunds|duplicates|hours audit|hidden technician/i },
  { id: 'grow-finance', pillar: 'grow', label: 'Accounting & payroll', test: /accounting|budgets|per diem|prevailing|chart of accounts|multi-entity|fixed assets|payroll|tax center|expenses|commissions|cash flow|bank intelligence|profitability|revenue map|business forecast|valuation|exit readiness|acquisitions/i },
  { id: 'grow-sales', pillar: 'grow', label: 'Sales & pricing', test: /in-home sales|call scripts|leaderboard|goals|coaching|price|pricing|quote|takeoff|margin|promo|underpriced|incentive|rebate|canvass|lead marketplaces|work-order guard|commercial contracts|neighborhood revenue/i },
  { id: 'grow-marketing', pillar: 'grow', label: 'Marketing & reputation', test: /reputation|listings|marketing|content calendar|creative|lifecycle|referral|loyalty|email campaigns|direct mail|audiences|landing|reviews|local rank|verified service|trust pack|community|surveys|customer feedback|^feedback/i },
  { id: 'grow-customers', pillar: 'grow', label: 'Customers & retention', test: /customer|memberships|renewals|gift cards|wallet|protection plans|service recovery|warranty|service agreements|contract|promise tracker/i },
  { id: 'grow-reports', pillar: 'grow', label: 'Reports & analytics', test: /analytics|snapshots|reports|usage dashboard|data quality|benchmarks|results|executive|franchise|market intelligence|recover|revenue protection|data exchange|job quality gate/i },
  { id: 'grow-automation', pillar: 'grow', label: 'Automation & templates', test: /workflows|automation|playbooks|templates|compliance rules|job quality/i },

  // ── Settings ──────────────────────────────────────────────────────────────
  { id: 'settings-help', pillar: 'settings', label: 'Help & updates', test: /^(overview|support|getting started|success center|what.s new|help|settings|settings center)$/i },
  { id: 'settings-account', pillar: 'settings', label: 'Account & team', test: /my account|navigation center|business profile|branding|^billing|plans|locations|regional packs|^team$|org chart|hr &|email settings|trash|trust badge|dashboard builder/i },
  { id: 'settings-integrations', pillar: 'settings', label: 'Integrations & data', test: /integrations|data imports|crm sync|netsuite|sage|xero|custom fields|exports|bi |data platform|api usage|webhook|slack|payroll (sync|connectors)|calendar feeds|google booking|mobile alerts/i },
  { id: 'settings-ai', pillar: 'settings', label: 'AI & governance', test: /sarah|shadow|\bai\b|agent|voice brand|interpreter|governance|decision ledger|chief of staff|security center|reliability|transparency|execution|playbook library/i },
  { id: 'settings-operations', pillar: 'settings', label: 'Operations setup', test: /booking settings|job statuses|scorecard|landscaping|pest ops|commercial|operating cadence|mass incidents|site safety|operations center|activity ledger|workflow health|capacity guard|revenue radar|fair sale|win cards|review shield|phone resilience/i },

  // ── Labs ──────────────────────────────────────────────────────────────────
  { id: 'labs-agents', pillar: 'labs', label: 'Agents & autonomy', test: /agent|autonomy|evaluation plane|multi-agent|marketplace|procurement network|supply chain|outcome|truck-roll/i },
  { id: 'labs-decisions', pillar: 'labs', label: 'Decisions & simulation', test: /decision|causal|simulator|regret|counterfactual|scientist|autopilot|value at risk|opportunity cost|drift|experiment|resolution probability|roadmap|stabilizer|equilibrium|ltv|pricing/i },
  { id: 'labs-graphs', pillar: 'labs', label: 'Graphs & memory', test: /graph|memory|identity|genome|atlas|truth|constitution|commitment|fabric|context|negative knowledge|contradictions|evidence map|unknowns|trust|reality|twin|world model/i },
  { id: 'labs-operations', pillar: 'labs', label: 'Operations & automation', test: /operating model|entropy|immune|flywheel|verification network|physical economy|self-healing|switching shield|next best|rescue loop|service intelligence|duration intelligence|reflexes|workflow compiler|event (bus|prediction)|click-to-cash|demand os|adoption|revenue autopsy|bottleneck|continuous improvement|learning compiler|operations (sandbox|loop)/i },
];

const FALLBACK: Record<PillarId, HubDef> = {
  answer: { id: 'answer-more', pillar: 'answer', label: 'More', test: NEVER },
  dispatch: { id: 'dispatch-more', pillar: 'dispatch', label: 'More', test: NEVER },
  grow: { id: 'grow-more', pillar: 'grow', label: 'More', test: NEVER },
  settings: { id: 'settings-more', pillar: 'settings', label: 'More', test: NEVER },
  labs: { id: 'labs-more', pillar: 'labs', label: 'Systems & operations', test: NEVER },
};

export function hubFor(pillar: PillarId, label: string): HubDef {
  return HUBS.find((h) => h.pillar === pillar && h.test.test(label)) ?? FALLBACK[pillar];
}

/** Splits one pillar's items into hubs, keeping HUBS order (More last) and the items' own order. Never drops an item. */
export function groupByHub<T extends { label: string }>(pillar: PillarId, items: T[]): { hub: HubDef; items: T[] }[] {
  const order = [...HUBS.filter((h) => h.pillar === pillar), FALLBACK[pillar]];
  const buckets = new Map<string, T[]>(order.map((h) => [h.id, []]));
  for (const it of items) buckets.get(hubFor(pillar, it.label).id)!.push(it);
  return order.map((hub) => ({ hub, items: buckets.get(hub.id)! })).filter((g) => g.items.length > 0);
}
