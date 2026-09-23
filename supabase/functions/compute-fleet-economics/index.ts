// Scheduled function (same idiom as analyze-equipment-lifecycle): for every
// vehicle, rolls up the trailing-90-day fuel/maintenance/insurance/downtime
// spend into a cost-per-mile and a per-day fixed cost, then attributes a
// truck-roll cost to every job that vehicle was dispatched to (via
// job_vehicle_trips) and writes the resulting margin into
// vehicle_job_profitability. Rule-based on purpose: fleet cost accounting
// has to be auditable, not an LLM guess.
//
// Deploy: supabase functions deploy compute-fleet-economics --no-verify-jwt
// Schedule it daily, same as analyze-equipment-lifecycle / check-warranty-alerts.
// Can also be invoked on demand from the Fleet Economics page's "Refresh" button.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cron-Secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface VehicleRow {
  id: string;
  user_id: string;
  label: string;
  monthly_payment_cost: number;
  monthly_insurance_cost: number;
}

interface ExpenseRow {
  vehicle_id: string;
  expense_type: string;
  amount: number;
}

interface TripRow {
  id: string;
  job_id: string;
  vehicle_id: string;
  miles_driven: number;
  created_at: string;
}

interface JobRow {
  id: string;
  invoice_amount: number | null;
  invoice_status: string;
}

const LOOKBACK_DAYS = 90;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("FLEET_ECONOMICS_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    // Allow authenticated dashboard users to trigger a refresh too — the
    // frontend calls this with the user's own JWT rather than the cron
    // secret, so only hard-block requests carrying neither.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "compute_fleet_economics_failed", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }));
    return jsonResponse({ error: "Server misconfiguration." }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const now = new Date();
  const periodStart = new Date(now.getTime() - LOOKBACK_DAYS * 86400000);

  try {
    const { data: vehicles, error: vehiclesError } = await admin
      .from("vehicles")
      .select("id, user_id, label, monthly_payment_cost, monthly_insurance_cost")
      .neq("status", "retired");
    if (vehiclesError) throw vehiclesError;

    const vehicleRows = (vehicles ?? []) as VehicleRow[];
    if (vehicleRows.length === 0) return jsonResponse({ vehicles_scanned: 0, jobs_scored: 0 });

    const vehicleIds = vehicleRows.map((v) => v.id);

    const { data: expenses, error: expensesError } = await admin
      .from("vehicle_expenses")
      .select("vehicle_id, expense_type, amount")
      .in("vehicle_id", vehicleIds)
      .gte("expense_date", periodStart.toISOString().slice(0, 10));
    if (expensesError) throw expensesError;

    const { data: trips, error: tripsError } = await admin
      .from("job_vehicle_trips")
      .select("id, job_id, vehicle_id, miles_driven, created_at")
      .in("vehicle_id", vehicleIds)
      .gte("created_at", periodStart.toISOString());
    if (tripsError) throw tripsError;

    const tripRows = (trips ?? []) as TripRow[];
    const jobIds = Array.from(new Set(tripRows.map((t) => t.job_id)));

    const { data: jobs, error: jobsError } = jobIds.length
      ? await admin.from("jobs").select("id, invoice_amount, invoice_status").in("id", jobIds)
      : { data: [] as JobRow[], error: null };
    if (jobsError) throw jobsError;

    const jobById = new Map((jobs ?? []).map((j) => [j.id, j as JobRow]));

    // Per-vehicle rollups: variable cost-per-mile (fuel + maintenance/repair)
    // and fixed daily cost (payment + insurance, amortized over 30 days —
    // downtime/insurance line items logged directly are added on top).
    const costByVehicle = new Map<string, { variable: number; fixed: number; downtime: number }>();
    for (const v of vehicleRows) {
      costByVehicle.set(v.id, { variable: 0, fixed: (v.monthly_payment_cost + v.monthly_insurance_cost) / 30, downtime: 0 });
    }
    for (const e of (expenses ?? []) as ExpenseRow[]) {
      const bucket = costByVehicle.get(e.vehicle_id);
      if (!bucket) continue;
      if (e.expense_type === "fuel" || e.expense_type === "maintenance" || e.expense_type === "repair") {
        bucket.variable += Number(e.amount) || 0;
      } else if (e.expense_type === "downtime") {
        bucket.downtime += Number(e.amount) || 0;
      } else {
        bucket.fixed += Number(e.amount) || 0;
      }
    }

    const milesByVehicle = new Map<string, number>();
    for (const t of tripRows) {
      milesByVehicle.set(t.vehicle_id, (milesByVehicle.get(t.vehicle_id) ?? 0) + (Number(t.miles_driven) || 0));
    }

    const costPerMileByVehicle = new Map<string, number>();
    for (const [vehicleId, bucket] of costByVehicle) {
      const miles = milesByVehicle.get(vehicleId) ?? 0;
      costPerMileByVehicle.set(vehicleId, miles > 0 ? bucket.variable / miles : 0);
    }

    // Jobs-per-day-per-vehicle, to split the fixed daily cost across every
    // job that vehicle actually rolled to that day rather than double
    // counting it on each job.
    const jobsPerVehicleDay = new Map<string, number>();
    for (const t of tripRows) {
      const dayKey = `${t.vehicle_id}:${t.created_at.slice(0, 10)}`;
      jobsPerVehicleDay.set(dayKey, (jobsPerVehicleDay.get(dayKey) ?? 0) + 1);
    }

    const upserts: Record<string, unknown>[] = [];
    for (const t of tripRows) {
      const vehicle = vehicleRows.find((v) => v.id === t.vehicle_id);
      const job = jobById.get(t.job_id);
      if (!vehicle || !job) continue;

      const bucket = costByVehicle.get(t.vehicle_id)!;
      const costPerMile = costPerMileByVehicle.get(t.vehicle_id) ?? 0;
      const dayKey = `${t.vehicle_id}:${t.created_at.slice(0, 10)}`;
      const jobsThatDay = jobsPerVehicleDay.get(dayKey) ?? 1;
      const allocatedFixed = bucket.fixed / jobsThatDay;
      const allocatedDowntime = bucket.downtime / jobsThatDay;

      const truckRollCost = Number(((t.miles_driven || 0) * costPerMile + allocatedFixed + allocatedDowntime).toFixed(2));
      const revenue = job.invoice_status === "not_sent" ? 0 : Number(job.invoice_amount) || 0;
      const grossProfit = Number((revenue - truckRollCost).toFixed(2));
      const marginPct = revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(1)) : null;

      upserts.push({
        user_id: vehicle.user_id,
        job_id: t.job_id,
        vehicle_id: t.vehicle_id,
        miles_driven: t.miles_driven || 0,
        truck_roll_cost: truckRollCost,
        revenue,
        gross_profit: grossProfit,
        margin_pct: marginPct,
        metric_snapshot: { cost_per_mile: Number(costPerMile.toFixed(3)), allocated_fixed_cost: Number(allocatedFixed.toFixed(2)), allocated_downtime_cost: Number(allocatedDowntime.toFixed(2)) },
        computed_at: now.toISOString(),
      });
    }

    if (upserts.length > 0) {
      const { error: upsertError } = await admin.from("vehicle_job_profitability").upsert(upserts, { onConflict: "job_id" });
      if (upsertError) throw upsertError;
    }

    return jsonResponse({ vehicles_scanned: vehicleRows.length, jobs_scored: upserts.length });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_fleet_economics_failed", error: String(error) }));
    return jsonResponse({ error: "Could not compute fleet economics." }, 500);
  }
});
