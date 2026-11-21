// scripts/demo/demo-tenant-lib.mjs
//
// Pure, dependency-free logic behind scripts/provision-demo-tenant.mjs:
// random credentials, TTL rules, a deterministic SYNTHETIC dataset, dataset validation and the purge orchestration.
// Nothing here talks to the network on its own; purgeTenant() receives the Supabase client from the caller.
//
// Safety rules baked in:
//   - No fixed or derived password anywhere: every password comes from crypto.randomInt.
//   - Every synthetic email ends in the reserved ".invalid" TLD and every phone uses the fictional 555-01NN range,
//     so a demo tenant can never message a real person even if an outbound integration is switched on by mistake.
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const DEMO_EMAIL_DOMAIN = 'demo.vireek.invalid';
export const DEFAULT_TTL_DAYS = 14;
export const MAX_TTL_DAYS = 30;
export const MAX_EXTEND_DAYS = 14;
export const MAX_EXTENSIONS = 2;
export const SCENARIOS = ['hvac', 'plumbing'];

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- credentials
const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no l
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const DIGIT = '23456789'; // no 0, 1
const SYMBOL = '-_.!#%*+';
const PASSWORD_ALPHABET = LOWER + UPPER + DIGIT + SYMBOL;

export function generatePassword(length = 24) {
  if (!Number.isInteger(length) || length < 16) throw new Error('password length must be an integer >= 16');
  const chars = [LOWER, UPPER, DIGIT, SYMBOL].map((set) => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function slugify(label) {
  const slug = String(label ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return slug || 'tenant';
}

export function generateCredentials(label) {
  const suffix = randomBytes(4).toString('hex');
  return { email: `demo-${slugify(label)}-${suffix}@${DEMO_EMAIL_DOMAIN}`, password: generatePassword(24) };
}

export const isDemoEmail = (email) => typeof email === 'string' && email.toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);

// ---------------------------------------------------------------- TTL
export function parseTtlDays(raw, { fallback = DEFAULT_TTL_DAYS, max = MAX_TTL_DAYS, flag = '--ttl-days' } = {}) {
  if (raw === undefined || raw === null || raw === true) return fallback;
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${flag} must be a whole number between 1 and ${max}`);
  return n;
}

export const computeExpiry = (now, days) => new Date(now.getTime() + days * DAY_MS);
export const daysRemaining = (expiresAt, now = new Date()) => Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS));

// ---------------------------------------------------------------- CLI helpers
const BOOLEAN_FLAGS = new Set(['dry-run', 'json', 'yes', 'help']);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    const key = (eq === -1 ? token.slice(2) : token.slice(2, eq));
    if (eq !== -1) flags[key] = token.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
    else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) flags[key] = rest[++i];
    else flags[key] = true;
  }
  return { command, flags };
}

export function projectRef(url) {
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error('SUPABASE_URL is not a valid URL'); }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return { ref: 'local', local: true };
  return { ref: host.split('.')[0], local: false };
}

/** Prevents provisioning into the wrong Supabase project: remote projects need --confirm-project <ref>. */
export function assertProjectConfirmed(url, confirm) {
  const { ref, local } = projectRef(url);
  if (local) return ref;
  if (typeof confirm !== 'string' || confirm !== ref) {
    throw new Error(`Refusing to run: pass --confirm-project ${ref} to confirm the target Supabase project.`);
  }
  return ref;
}

// ---------------------------------------------------------------- deterministic RNG
function rngFrom(seed) {
  let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
function uuidFrom(rng) {
  const b = Array.from({ length: 16 }, () => Math.floor(rng() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------- synthetic dataset
const FIRST = ['Avery', 'Blake', 'Casey', 'Devon', 'Elliot', 'Finley', 'Gray', 'Harper', 'Indigo', 'Jules', 'Kai', 'Lane', 'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum', 'Umber', 'Vale', 'Wren', 'Yael', 'Zion', 'Arden', 'Briar', 'Cedar', 'Dale', 'Emery'];
const LAST = ['Alder', 'Birch', 'Calloway', 'Dunmore', 'Ellison', 'Fairbanks', 'Garrity', 'Hollis', 'Ingram', 'Jessup', 'Kensington', 'Lowell', 'Mercer', 'Northcott', 'Ostrander', 'Pemberton', 'Quill', 'Radcliffe', 'Sutter', 'Thackeray', 'Underhill', 'Vance', 'Whitlock', 'Yardley', 'Zeller'];
const STREETS = ['Maple Court', 'Harbor Lane', 'Juniper Way', 'Cedar Ridge Road', 'Lantern Street', 'Willow Bend', 'Orchard Park Drive', 'Summit Avenue', 'Meadow Trail', 'Brook Hollow Road'];
const CITIES = ['Fairview', 'Riverton', 'Oakdale', 'Lakeside', 'Hillcrest', 'Pinegrove'];
const AREA_CODES = ['212', '312', '415', '617', '206', '303', '404', '512'];

const SCENARIO_DATA = {
  hvac: {
    business: 'Northwind Heating & Air',
    services: [
      ['AC Repair', 180, 650], ['Furnace Repair', 160, 720], ['Seasonal Tune-Up', 89, 159], ['Thermostat Installation', 150, 380],
      ['Duct Cleaning', 320, 780], ['Heat Pump Replacement', 5200, 11800], ['Refrigerant Leak Repair', 350, 1250],
    ],
    issues: ['the AC is blowing warm air', 'the furnace will not ignite', 'I want a tune-up before winter', 'the thermostat screen is blank', 'there is a strange smell from the vents'],
    emergencyRate: 0.12,
  },
  plumbing: {
    business: 'Clearwater Plumbing',
    services: [
      ['Drain Cleaning', 140, 380], ['Water Heater Repair', 190, 620], ['Leak Detection', 175, 540], ['Faucet & Fixture Installation', 120, 360],
      ['Sewer Line Service', 450, 2400], ['Water Heater Replacement', 1400, 3200], ['Toilet Repair', 110, 290],
    ],
    issues: ['the kitchen sink is draining slowly', 'the water heater is leaking', 'there is a wet spot on the ceiling', 'the toilet keeps running', 'the main drain is backing up'],
    emergencyRate: 0.15,
  },
};

const WEEK = { open: '07:00', close: '19:00' };
const cents = (n) => Math.round(n * 100) / 100;

/**
 * Deterministic: the same (seed, now, scenario) always yields the same rows (ids included),
 * which is what makes a demo reproducible and the unit tests meaningful.
 */
export function buildDataset({ ownerId, seed, now = new Date(), scenario = 'hvac', prospect } = {}) {
  if (!UUID_RE.test(String(ownerId ?? ''))) throw new Error('ownerId must be a UUID');
  if (!SCENARIOS.includes(scenario)) throw new Error(`scenario must be one of: ${SCENARIOS.join(', ')}`);
  if (!seed) throw new Error('seed is required');
  const sc = SCENARIO_DATA[scenario];
  const rng = rngFrom(`${seed}|${scenario}`);
  const tag = createHash('sha256').update(String(seed)).digest('hex').slice(0, 6);

  const usedPhones = new Set();
  const phone = () => {
    for (;;) {
      const p = `+1-${pick(rng, AREA_CODES)}-555-01${String(randInt(rng, 0, 99)).padStart(2, '0')}`;
      if (!usedPhones.has(p)) { usedPhones.add(p); return p; }
    }
  };
  const person = () => ({ first: pick(rng, FIRST), last: pick(rng, LAST) });
  const address = () => `${randInt(rng, 100, 9899)} ${pick(rng, STREETS)}, ${pick(rng, CITIES)}`;

  const businessName = `${(prospect && String(prospect).trim().slice(0, 60)) || sc.business} (Demo)`;

  const profile = {
    company_name: businessName, full_name: 'Demo Owner', phone: phone(), plan: 'professional', minutes_used_this_month: 0,
    minutes_included: 1500, status: 'active', role: 'owner', onboarding_completed: true, forwarding_number: phone(),
  };

  const businessProfile = {
    user_id: ownerId,
    business_hours: { mon: WEEK, tue: WEEK, wed: WEEK, thu: WEEK, fri: WEEK, sat: { open: '08:00', close: '17:00' }, sun: { open: 'closed', close: 'closed' } },
    services_offered: sc.services.map((s) => s[0]),
    greeting_script: `Thank you for calling ${businessName}. How can I help you today?`,
    faqs: [
      { question: 'What are your hours?', answer: 'Monday to Friday 7am to 7pm and Saturday 8am to 5pm. Emergency service is available outside those hours.' },
      { question: 'Do you offer free estimates?', answer: 'Yes, for non-emergency work. Emergency calls carry a standard dispatch fee.' },
    ],
    service_area: CITIES.join(', '),
  };

  const team = ['Riley Okafor', 'Sam Lindqvist', 'Jordan Meyers', 'Taylor Brandt'].map((name, i) => ({
    id: uuidFrom(rng), account_owner_id: ownerId, member_email: `tech${i + 1}-${tag}@${DEMO_EMAIL_DOMAIN}`, member_name: name,
    role: 'technician', invite_status: 'active',
    permissions: { can_view_billing: false, can_manage_team: false, can_edit_business_profile: false, can_view_all_jobs: i === 0 },
  }));

  const nowMs = now.getTime();
  const customers = Array.from({ length: 60 }, (_, i) => {
    const p = person();
    return {
      id: uuidFrom(rng), user_id: ownerId, name: `${p.first} ${p.last}`, phone: phone(),
      email: `${p.first}.${p.last}.${i}@customers.${DEMO_EMAIL_DOMAIN}`.toLowerCase(), address: address(),
      customer_type: rng() < 0.15 ? 'commercial' : 'residential', lifecycle_stage: 'lead', tags: ['demo-synthetic'],
      notes: null, source: 'manual', created_at: new Date(nowMs - randInt(rng, 100, 180) * DAY_MS).toISOString(),
    };
  });

  const calls = [];
  const leads = [];
  const jobs = [];
  const jobCountByCustomer = new Map();

  for (let i = 0; i < 96; i++) {
    const customer = customers[Math.floor(rng() ** 2 * customers.length)]; // skew toward a repeat-customer core
    const [service, lo, hi] = pick(rng, sc.services);
    const offsetDays = randInt(rng, -90, 13);
    const scheduled = new Date(nowMs + offsetDays * DAY_MS);
    scheduled.setUTCHours(randInt(rng, 8, 16), pick(rng, [0, 15, 30, 45]), 0, 0);
    const past = scheduled.getTime() < nowMs;
    const callAt = new Date(scheduled.getTime() - randInt(rng, 2, 72) * 3_600_000);
    const callId = uuidFrom(rng);
    const emergency = rng() < sc.emergencyRate;
    calls.push({
      id: callId, user_id: ownerId, external_id: `demo-${tag}-c${i}`, caller_phone: customer.phone, caller_name: customer.name,
      call_datetime: callAt.toISOString(), duration_seconds: randInt(rng, 90, 420),
      summary: `${customer.name} called about ${service.toLowerCase()}. Appointment booked.`,
      transcript: `Agent: Thank you for calling ${businessName}. How can I help?\nCaller: Hi, ${pick(rng, sc.issues)}.\nAgent: I can get a technician out to you. Does the time offered work?\nCaller: Yes, that works.\nAgent: You are booked. You will get a confirmation shortly.`,
      recording_url: null, is_emergency: emergency, sentiment: rng() < 0.7 ? 'positive' : 'neutral', status: 'booked', created_at: callAt.toISOString(),
    });
    let leadId = null;
    if (rng() < 0.65) {
      leadId = uuidFrom(rng);
      leads.push({
        id: leadId, user_id: ownerId, call_id: callId, customer_id: customer.id, name: customer.name, phone: customer.phone, email: customer.email,
        service_interested: service, notes: null, stage: 'won', created_at: callAt.toISOString(),
      });
    }
    let jobStatus = 'scheduled';
    let amount = null;
    let invoiceStatus = 'not_sent';
    if (past) {
      jobStatus = rng() < 0.92 ? 'completed' : 'cancelled';
      if (jobStatus === 'completed') {
        amount = cents(lo + rng() * (hi - lo));
        invoiceStatus = offsetDays < -20 ? (rng() < 0.9 ? 'paid' : 'sent') : (rng() < 0.5 ? 'paid' : 'sent');
      }
    }
    jobs.push({
      id: uuidFrom(rng), user_id: ownerId, lead_id: leadId, call_id: callId, customer_id: customer.id, customer_name: customer.name,
      service_type: service, address: customer.address, scheduled_datetime: scheduled.toISOString(),
      assigned_technician_id: pick(rng, team).id, job_status: jobStatus, invoice_amount: amount, invoice_status: invoiceStatus,
      created_at: callAt.toISOString(),
    });
    jobCountByCustomer.set(customer.id, (jobCountByCustomer.get(customer.id) ?? 0) + 1);
  }

  for (let i = 0; i < 40; i++) {
    const p = person();
    const at = new Date(nowMs - randInt(rng, 1, 90) * DAY_MS - randInt(rng, 0, 23) * 3_600_000);
    const callId = uuidFrom(rng);
    const number = phone();
    const name = `${p.first} ${p.last}`;
    calls.push({
      id: callId, user_id: ownerId, external_id: `demo-${tag}-n${i}`, caller_phone: number, caller_name: name, call_datetime: at.toISOString(),
      duration_seconds: randInt(rng, 25, 160), summary: `${name} asked about pricing and did not book yet.`,
      transcript: `Agent: Thank you for calling ${businessName}. How can I help?\nCaller: Hi, ${pick(rng, sc.issues)}. What would that cost?\nAgent: I can share a range and book a free estimate whenever you are ready.`,
      recording_url: null, is_emergency: false, sentiment: 'neutral', status: 'new_lead', created_at: at.toISOString(),
    });
    leads.push({
      id: uuidFrom(rng), user_id: ownerId, call_id: callId, customer_id: null, name, phone: number, email: null,
      service_interested: pick(rng, sc.services)[0], notes: null, stage: rng() < 0.5 ? 'new' : 'contacted', created_at: at.toISOString(),
    });
  }

  for (const c of customers) {
    const n = jobCountByCustomer.get(c.id) ?? 0;
    c.lifecycle_stage = n >= 4 ? 'vip' : n >= 1 ? 'active' : 'lead';
  }
  calls.sort((a, b) => a.call_datetime.localeCompare(b.call_datetime));

  const summary = { team: team.length, customers: customers.length, calls: calls.length, leads: leads.length, jobs: jobs.length };
  return { profile, businessProfile, team, customers, calls, leads, jobs, summary };
}

/** Returns a list of problems; an empty list means the dataset is safe and self-consistent. */
export function validateDataset(ds) {
  const problems = [];
  const ids = (rows) => new Set(rows.map((r) => r.id));
  const teamIds = ids(ds.team);
  const customerIds = ids(ds.customers);
  const callIds = ids(ds.calls);
  const leadIds = ids(ds.leads);
  for (const [name, rows] of Object.entries({ team: ds.team, customers: ds.customers, calls: ds.calls, leads: ds.leads, jobs: ds.jobs })) {
    if (ids(rows).size !== rows.length) problems.push(`${name}: duplicate ids`);
  }
  const phones = [ds.profile.phone, ds.profile.forwarding_number, ...ds.customers.map((c) => c.phone)];
  if (new Set(phones.filter(Boolean)).size !== phones.filter(Boolean).length) problems.push('duplicate phone numbers among profile/customers');
  const customerEmails = ds.customers.map((c) => c.email);
  if (new Set(customerEmails).size !== customerEmails.length) problems.push('customers: duplicate emails');
  const allPhones = [...phones, ...ds.calls.map((c) => c.caller_phone), ...ds.leads.map((l) => l.phone)].filter(Boolean);
  for (const p of allPhones) if (!/^\+1-\d{3}-555-01\d{2}$/.test(p)) problems.push(`non-fictional phone: ${p}`);
  const allEmails = [...customerEmails, ...ds.team.map((t) => t.member_email), ...ds.leads.map((l) => l.email)].filter(Boolean);
  for (const e of allEmails) if (!/\.invalid$/.test(e)) problems.push(`email not on the reserved .invalid TLD: ${e}`);
  for (const j of ds.jobs) {
    if (!customerIds.has(j.customer_id)) problems.push(`job ${j.id}: unknown customer`);
    if (j.lead_id && !leadIds.has(j.lead_id)) problems.push(`job ${j.id}: unknown lead`);
    if (!callIds.has(j.call_id)) problems.push(`job ${j.id}: unknown call`);
    if (!teamIds.has(j.assigned_technician_id)) problems.push(`job ${j.id}: unknown technician`);
    if (j.invoice_amount !== null && !(Number.isFinite(j.invoice_amount) && j.invoice_amount >= 0)) problems.push(`job ${j.id}: bad invoice amount`);
  }
  for (const l of ds.leads) {
    if (!callIds.has(l.call_id)) problems.push(`lead ${l.id}: unknown call`);
    if (l.customer_id && !customerIds.has(l.customer_id)) problems.push(`lead ${l.id}: unknown customer`);
  }
  return problems;
}

// ---------------------------------------------------------------- purge orchestration
/**
 * Mirrors supabase/functions/delete-account: owned tables -> erase_user_rows -> sensitive-read log -> auth user.
 * Refuses anything that is not a registered, non-purged demo tenant with a *.invalid demo email, so a typo
 * can never erase a real account. Any failure aborts BEFORE the auth user is deleted, so the run can be repeated.
 */
export async function purgeTenant(db, accountId, { tableNames, now = () => new Date() } = {}) {
  if (!UUID_RE.test(String(accountId ?? ''))) throw new Error('account id must be a UUID');
  if (!Array.isArray(tableNames) || tableNames.length === 0) throw new Error('tableNames is required');

  const reg = await db.from('demo_tenants').select('account_id,status').eq('account_id', accountId).maybeSingle();
  if (reg.error) throw new Error(`lookup demo_tenants: ${reg.error.message}`);
  if (!reg.data) throw new Error('Not a registered demo tenant; refusing to purge.');
  if (reg.data.status === 'purged') return { alreadyPurged: true };

  const user = await db.auth.admin.getUserById(accountId);
  if (user.error && !/not found/i.test(user.error.message ?? '')) throw new Error(`lookup user: ${user.error.message}`);
  const email = user.data?.user?.email;
  if (email && !isDemoEmail(email)) throw new Error('Account email is not a demo address; refusing to purge.');

  for (const table of tableNames) {
    const { error } = await db.from(table).delete().eq('user_id', accountId);
    if (error) throw new Error(`delete ${table}: ${error.message}`);
  }
  const rest = await db.rpc('erase_user_rows', { p_user: accountId });
  if (rest.error) throw new Error(`erase_user_rows: ${rest.error.message}`);
  const blocked = Object.keys(rest.data?.blocked ?? {});
  if (blocked.length) throw new Error(`erase_user_rows blocked on: ${blocked.join(', ')}`);
  const log = await db.rpc('erase_sensitive_read_log_for_account', { p_account_id: accountId });
  if (log.error) throw new Error(`erase_sensitive_read_log_for_account: ${log.error.message}`);

  if (user.data?.user) {
    const del = await db.auth.admin.deleteUser(accountId);
    if (del.error) throw new Error(`delete auth user: ${del.error.message}`);
  }
  const mark = await db.rpc('mark_demo_tenant_purged', { p_account: accountId });
  if (mark.error) throw new Error(`mark_demo_tenant_purged: ${mark.error.message}`);
  return { alreadyPurged: false, purgedAt: now().toISOString() };
}
