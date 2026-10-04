// Seeds a realistic HVAC telemetry story so you can test Building Telemetry
// Intelligence end to end WITHOUT hardware: 4 days of normal behaviour,
// then a developing low-refrigerant-charge fault over the last 18 hours.
//
//   INGEST_URL="https://<ref>.supabase.co/functions/v1/telemetry-ingest" \
//   TOKEN="vrk_tg_..." EQUIPMENT_ID="<equipment uuid>" node scripts/telemetry-simulate.mjs
//
// Then open /dashboard/building-telemetry and press "Run analysis now".
// Set FAULT=0 to seed healthy data only.

const { INGEST_URL, TOKEN, EQUIPMENT_ID, FAULT = '1' } = process.env;
if (!INGEST_URL || !TOKEN) {
  console.error('Set INGEST_URL and TOKEN (and optionally EQUIPMENT_ID).');
  process.exit(1);
}

const STEP_MS = 15 * 60_000;
const HISTORY_DAYS = 5;
const FAULT_HOURS = 18;
const RAMP_HOURS = 6;

// fault = shift applied at full fault severity
const POINTS = [
  { point: 'SIM/DELTA_T', metric: 'delta_t', unit: 'C', base: 18, noise: 0.8, fault: -6 },
  { point: 'SIM/SUCTION_PSI', metric: 'suction_pressure', unit: 'psi', base: 118, noise: 3, fault: -25 },
  { point: 'SIM/SUPERHEAT', metric: 'superheat', unit: 'F', base: 11, noise: 1.2, fault: 14 },
  { point: 'SIM/COMP_AMPS', metric: 'compressor_current', unit: 'A', base: 15.5, noise: 0.5, fault: -2.5 },
];

const now = Date.now();
const start = now - HISTORY_DAYS * 24 * 3_600_000;
const faultStart = now - FAULT_HOURS * 3_600_000;
const readings = [];

for (let ts = start; ts <= now - STEP_MS; ts += STEP_MS) {
  for (const p of POINTS) {
    let shift = 0;
    if (FAULT !== '0' && ts >= faultStart) {
      shift = p.fault * Math.min(1, (ts - faultStart) / (RAMP_HOURS * 3_600_000));
    }
    const diurnal = Math.sin(((ts % 86_400_000) / 86_400_000) * 2 * Math.PI) * p.noise * 0.5;
    const value = p.base + shift + diurnal + (Math.random() - 0.5) * 2 * p.noise;
    readings.push({
      point: p.point, metric: p.metric, unit: p.unit,
      value: Number(value.toFixed(2)), ts: new Date(ts).toISOString(),
      ...(EQUIPMENT_ID ? { equipment_id: EQUIPMENT_ID } : {}),
    });
  }
}

let accepted = 0;
for (let i = 0; i < readings.length; i += 500) {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ readings: readings.slice(i, i + 500) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Ingest failed', res.status, body); process.exit(1); }
  accepted += body.accepted ?? 0;
}
console.log(`Sent ${readings.length} readings, accepted ${accepted}. Now press "Run analysis now".`);
