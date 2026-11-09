#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';

const [base, kind, reference, status, eventId = randomUUID()] = process.argv.slice(2);
const secret = process.env.FINANCING_PARTNER_MOCK_WEBHOOK_SECRET;
if (!base || !kind || !reference || !status || !secret || secret.length < 16) {
  console.error('usage: FINANCING_PARTNER_MOCK_WEBHOOK_SECRET=<>=16 chars> node scripts/simulate-partner-webhook.mjs <url> <financing|insurance> <reference> <status> [event_id]');
  process.exit(2);
}
const body = JSON.stringify({ id: eventId, type: `${kind}.status`, reference, status });
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const res = await fetch(`${base}?partner=mock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Partner-Signature': `t=${t},v1=${v1}` }, body });
console.log(res.status, await res.text());
