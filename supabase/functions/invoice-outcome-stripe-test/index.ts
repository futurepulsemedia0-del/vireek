// supabase/functions/invoice-outcome-stripe-test/index.ts
//   POST {statementId}   Authorization: STAFF user JWT
// Creates ONE Stripe TEST-mode invoice item for an approved statement. FAILS CLOSED:
//   - STRIPE_SECRET_KEY must be an sk_test_/rk_test_ key (assertStripeTestKey), otherwise nothing is called;
//   - the Stripe response must say livemode === false, otherwise the record is NOT stored and the call is reported as an error;
//   - no live object is ever created, modified or deleted. Not live-verified.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import Stripe from 'npm:stripe@17.4.0';
import { assertStripeTestKey, buildTestRecord, responseIsTestMode } from '../_shared/results-plan/outcomeStripe.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey' };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const guard = assertStripeTestKey(Deno.env.get('STRIPE_SECRET_KEY'));
  if (!guard.ok) return json({ blocked: 'stripe_not_test_mode', reason: guard.reason, detail: 'Nothing was sent to Stripe.' }, 403);

  const url = Deno.env.get('SUPABASE_URL'); const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !serviceKey || !anonKey) return json({ error: 'server_not_configured' }, 500);
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: isStaff } = await userClient.rpc('invoice_outcome_is_staff');
  if (isStaff !== true) return json({ error: 'staff_only' }, 403);

  let statementId = '';
  try { statementId = String((await req.json()).statementId ?? ''); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!/^[0-9a-f-]{36}$/i.test(statementId)) return json({ error: 'invalid_statement_id' }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: st } = await admin.from('invoice_outcome_statements').select('id,user_id,state,snapshot,stripe_record_id').eq('id', statementId).maybeSingle();
  if (!st) return json({ error: 'not_found' }, 404);
  if (st.stripe_record_id) return json({ ok: true, alreadyRecorded: true, recordId: st.stripe_record_id }); // idempotent
  const { data: active } = await admin.rpc('invoice_outcome_is_active', { p_user: st.user_id });
  if (active !== true) return json({ blocked: 'feature_disabled' }, 403);

  const [{ data: billable }, { data: settings }] = await Promise.all([
    admin.from('invoice_outcome_statement_billable').select('billable_cents').eq('statement_id', statementId).maybeSingle(),
    admin.from('invoice_outcome_settings').select('stripe_customer_id').eq('user_id', st.user_id).maybeSingle(),
  ]);
  const built = buildTestRecord({ statementId, state: st.state, snapshot: st.snapshot, billableCents: Number(billable?.billable_cents ?? -1), stripeCustomerId: settings?.stripe_customer_id ?? null });
  if (!built.ok) return json({ blocked: built.error }, 422);
  const rec = built.record;

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, { httpClient: Stripe.createFetchHttpClient() });
  try {
    const item = await stripe.invoiceItems.create(
      { customer: rec.stripeCustomerId, amount: rec.amountCents, currency: rec.currency, description: rec.description, metadata: { statement_id: rec.statementId, mode: 'test' } },
      { idempotencyKey: rec.identifier },
    );
    if (!responseIsTestMode(item)) return json({ error: 'stripe_response_not_test_mode', detail: 'Record NOT stored. Investigate immediately.' }, 500);
    const { error } = await admin.from('invoice_outcome_statements').update({ stripe_record_id: item.id }).eq('id', statementId).eq('state', 'approved').is('stripe_record_id', null);
    if (error) return json({ error: 'record_store_failed' }, 500);
    return json({ ok: true, recordId: item.id, mode: 'test' });
  } catch (e) {
    console.error('outcome_stripe_test_failed', statementId, e instanceof Error ? e.message : 'unknown');
    return json({ error: 'stripe_call_failed' }, 502);
  }
});
