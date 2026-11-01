# Colour migration report

Mode: **WRITE**

| Metric | Count |
|---|---|
| files changed | 1113 |
| raw palette classes migrated | 5333 |
| redundant `dark:` palette classes removed | 190 |
| `text-white` → `text-on-<family>` pairings | 827 |
| bg-white / bg-black / border-white → tokens | 300 |
| hex → `rgb(var(--token))` | 7 |
| lines still containing hex / raw classes (manual) | 206 |

## Review: light text with no dark surface in the same class string (24)
These became `text-on-inverse`; confirm the parent really is a dark/inverse surface.

- `text-slate-100` → `text-on-inverse`
- `text-slate-100` → `text-on-inverse`
- `text-slate-100` → `text-on-inverse`
- `text-slate-200` → `text-on-inverse`
- `text-slate-100` → `text-on-inverse`
- `text-slate-100` → `text-on-inverse`
- `text-slate-300` → `text-text-muted`
- `text-slate-200` → `text-on-inverse`
- `text-slate-100` → `text-on-inverse`
- `text-slate-100` → `text-on-inverse`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-200` → `text-on-inverse`
- `text-slate-300` → `text-text-muted`
- `text-slate-100` → `text-on-inverse`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`
- `text-slate-300` → `text-text-muted`

## Needs manual decision (canvas/map/chart/email/data colours — CSS variables cannot be used)

### src/components/CookieConsent.tsx
- 443: 'linear-gradient(155deg, #0B0F1E 0%, #10142A 45%, #0B0F1E 100%)',
- 457: <div className="relative h-[3px] w-full bg-gradient-to-r from-accent via-[#7C8CFF] to-cta" />

### src/components/LiveChatWidget.tsx
- 247: className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-on-inverse/

### src/components/NoSurpriseCustomerPanel.tsx
- 149: className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent,#2563eb)]"

### src/components/RouteLoader.tsx
- 56: -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
- 57: mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));

### src/components/SiteAssistant.tsx
- 144: className="fixed bottom-[84px] right-5 z-40 flex h-12 w-12 items-center justify-center rounded-2xl border-2 bo
- 173: className="pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg border 
- 194: <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-on-inverse/30 bg-gradient-t
- 258: className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-on-inverse/

### src/components/bulk/BulkCheckbox.tsx
- 40: className="focus-ring h-4 w-4 cursor-pointer rounded border-border accent-[var(--color-accent,#2563eb)]"

### src/components/canvassing/CanvassMap.tsx
- 69: paint: { 'circle-color': '#2563eb', 'circle-opacity': 0.85, 'circle-stroke-color': '#ffffff', 'circle-stroke-w
- 74: paint: { 'text-color': '#ffffff' },
- 81: 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
- 86: paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 15, 'circle-stroke-color': '#111827', 'circle-strok
- 172: pickMarkerRef.current = new maplibregl.Marker({ color: '#111827' }).setLngLat([pickedPoint.lng, pickedPoint.la

### src/components/chatWidget/ChatWidgetPreview.tsx
- 15: light: { panel: '#FFFFFF', surface: '#F3F4F6', text: '#111827', muted: '#6B7280', border: '#E5E7EB' },
- 16: dark: { panel: '#111827', surface: '#1F2937', text: '#F9FAFB', muted: '#9CA3AF', border: '#374151' },
- 25: const brand = /^#[0-9a-fA-F]{6}$/.test(settings.brand_color) ? settings.brand_color : '#3448E8';
- 58: <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: online ? '#22C55E' : '#9CA3AF' }}

### src/components/data-platform/EmbedsTab.tsx
- 58: accent: '#2563eb',

### src/components/identity/IdentityGraphCanvas.tsx
- 72: <circle cx={n.x} cy={n.y} r={n.depth === 0 ? 17 : 13} fill={meta.color} stroke={active ? '#fff' : meta.color} 

### src/components/jobs/JobQualityGatePanel.tsx
- 59: ctx.strokeStyle = '#1a1a1a';

### src/components/jobs/JobSummarySettingsForm.tsx
- 22: <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 

### src/components/jobs/JobVideoSessionPanel.tsx
- 108: <input type="checkbox" checked={recordingAllowed} onChange={(e) => setRecordingAllowed(e.target.checked)} clas

### src/components/livemap/GeofenceMapLayer.tsx
- 37: el.style.cssText = `width:${size}px;height:${size}px;background:${kind === 'radius' ? '#ffffff' : color};borde

### src/components/livemap/LiveMapCanvas.tsx
- 21: moving: '#16a34a',
- 22: idling: '#d97706',
- 23: stopped: '#2563eb',
- 24: offline: '#94a3b8',
- 97: map.addLayer({ id: 'geofence-fill', type: 'fill', source: 'geofences', paint: { 'fill-color': '#2563eb', 'fill
- 98: map.addLayer({ id: 'geofence-line', type: 'line', source: 'geofences', paint: { 'line-color': '#2563eb', 'line
- 105: 'line-color': ['case', ['==', ['get', 'selected'], true], '#2563eb', '#94a3b8'],
- 110: map.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': '#2563eb', 'line-width': 3
- 213: entry.el.style.backgroundColor = late ? '#dc2626' : job.job_status === 'scheduled' ? '#f8fafc' : '#2563eb';
- 214: entry.el.style.borderColor = late ? '#ffffff' : '#2563eb';

### src/components/locations/BrandsPanel.tsx
- 79: <Input label="Brand color" placeholder="#2563EB" maxLength={7} value={editing.color} onChange={(e) => setEditi

### src/components/passport/EquipmentPassportLabel.tsx
- 44: QRCode.toDataURL(url, { margin: 1, width: 640, errorCorrectionLevel: 'Q', color: { dark: '#0b1220', light: '#f
- 83: body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0b1220}
- 84: .label{width:70mm;border:0.4mm solid #0b1220;border-radius:3mm;overflow:hidden}
- 85: .bar{background:#0b1220;color:#fff;padding:1.6mm 3mm;font-size:6.5pt;font-weight:700;letter-spacing:.18em;text
- 89: .s{font-size:7pt;color:#475569;margin-top:1mm}
- 91: .f{padding:1.4mm 3mm;border-top:0.3mm solid #cbd5e1;font-size:6pt;color:#475569}

### src/components/quotes/HvacFields.tsx
- 148: className="focus-ring h-5 w-5 rounded border-border accent-[var(--color-accent,#2563eb)]"

### src/components/sections/OperationsCommandCenter.tsx
- 264: className="relative mt-10 overflow-hidden rounded-2xl border border-border-strong bg-[#0a0b10] shadow-[0_30px_

### src/components/settings/AutoReplySettingsCard.tsx
- 161: className="mt-2 w-full accent-[var(--color-accent,#6366f1)]"

### src/components/signatures/SignaturePad.tsx
- 52: ctx.strokeStyle = '#171717';

### src/components/video/VideoCallRoom.tsx
- 219: <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="focus-r

### src/components/video/VideoLobby.tsx
- 81: <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="focus-ring 

### src/components/wallboard/WallboardPanels.tsx
- 36: on_site: '#34d399',
- 37: en_route: '#38bdf8',
- 38: driving: '#38bdf8',
- 39: available: '#fbbf24',
- 40: offline: '#64748b',

### src/lib/bookingPolicy.ts
- 311: if (!HEX_RE.test(b.accent_color)) e.accent = 'Use a 6-digit hex colour like #1f3ad8.';

### src/lib/canvassing.ts
- 129: no_answer: { label: 'No answer', hint: 'Nobody came to the door', color: '#f59e0b', needsContact: false, follo
- 130: callback: { label: 'Call back', hint: 'Asked us to come back later', color: '#8b5cf6', needsContact: false, fo
- 131: interested: { label: 'Interested', hint: 'Wants to hear more — creates a lead', color: '#06b6d4', needsContact
- 132: appointment_set: { label: 'Appointment set', hint: 'Booked a visit — creates a lead and a task', color: '#2563
- 133: sold: { label: 'Sold', hint: 'Signed on the spot', color: '#16a34a', needsContact: true, followUp: 'none' },
- 134: not_interested: { label: 'Not interested', hint: 'Politely declined', color: '#ef4444', needsContact: false, f
- 135: do_not_knock: { label: 'Do not knock', hint: 'Never visit again (locked for reps)', color: '#1f2937', needsCon
- 138: export const NEW_DOOR_COLOR = '#94a3b8';
- 531: territory_id: String(o.territory_id ?? ''), name: String(o.name ?? ''), color: typeof o.color === 'string' ? o
- 575: export const TERRITORY_COLORS = ['#2563EB', '#16A34A', '#DC2626', '#D97706', '#7C3AED', '#0891B2', '#DB2777', 

### src/lib/chatWidget.ts
- 70: brand_color: '#3448E8',
- 133: if (!/^#[0-9a-fA-F]{6}$/.test(s.brand_color)) e.brand_color = 'Use a 6-digit hex color, e.g. #3448E8.';
- 168: export function readableTextColor(hex: string): '#FFFFFF' | '#111827' {
- 170: if (!m) return '#FFFFFF';
- 176: return lum > 0.4 ? '#111827' : '#FFFFFF';

### src/lib/dailyBriefing.ts
- 764: good: '#15803d',
- 765: bad: '#b91c1c',
- 766: warn: '#b45309',
- 767: neutral: '#111827',
- 782: (it.tag === 'AI' ? ' <span style="font-size:11px;color:#6b7280">AI</span>' : '');
- 789: return `<h3 style="margin:22px 0 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b728
- 793: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 aut
- 794: `<p style="margin:0;font-size:13px;color:#6b7280">${esc(opts.companyName ?? 'Vireek')} · ${esc(b.date)}</p>` +
- 796: `<p style="margin:6px 0 0;font-size:16px;color:${b.severity === 'urgent' ? '#b91c1c' : '#111827'}">${esc(b.hea
- 799: ? `<p style="margin:22px 0 0;font-size:13px;color:#6b7280">All clear: ${esc(clear.join(', '))}</p>`
- 801: `<p style="margin:28px 0 0"><a href="${esc(opts.dashboardUrl)}/dashboard" style="display:inline-block;backgrou
- 802: `<p style="margin:20px 0 0;font-size:12px;color:#9ca3af">Change delivery time, channels and sections in Settin

### src/lib/directMail.ts
- 142: accent_color: '#0F62FE',
- 268: if (!/^#[0-9a-fA-F]{6}$/.test(d.accent_color)) e.accent_color = 'Use a 6-digit hex color like #0F62FE.';

### src/lib/dvir.ts
- 361: ctx.fillStyle = '#fff';
- 363: ctx.fillStyle = '#171717';

### src/lib/geofences.ts
- 22: export const DEFAULT_COLOR = '#2563eb';
- 23: export const ZONE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'] as const;
- 84: job_site: { label: 'Job site', hint: 'The property a job happens at.', color: '#2563eb', preset: { arrived: tr
- 85: customer_site: { label: 'Customer approach', hint: 'A ring around a customer address, to text them an ETA as t
- 86: shop: { label: 'Shop / yard', hint: 'Your shop or warehouse. Entering can start the technician’s shift.', colo
- 87: depot: { label: 'Depot', hint: 'A staging or parking location.', color: '#0891b2', preset: { arrived: false, c
- 88: service_area: { label: 'Service area', hint: 'Where you work. Leaving it can alert you.', color: '#d97706', pr
- 89: restricted: { label: 'Restricted area', hint: 'Somewhere vehicles should not be.', color: '#dc2626', preset: {

### src/lib/inspectionReportPdf.ts
- 60: ctx.fillStyle = '#ffffff';

### src/lib/inventory.ts
- 166: critical: '#ef4444',
- 167: low: '#f59e0b',
- 168: ok: '#10b981',

### src/lib/jobAutopsy.ts
- 28: extra_travel: '#6366f1',
- 29: misdiagnosis: '#ef4444',
- 30: missing_part: '#f59e0b',
- 31: customer_delay: '#06b6d4',
- 32: technician_rework: '#ec4899',
- 33: scope_change: '#22c55e',
- 34: other: '#94a3b8',

### src/lib/jobCosting.ts
- 61: labor: '#6366f1',
- 62: material: '#22c55e',
- 63: equipment: '#f59e0b',
- 64: subcontractor: '#ec4899',
- 65: permit: '#06b6d4',
- 66: other: '#94a3b8',

### src/lib/landingPageUtils.ts
- 290: if (!isValidHexColor(hex)) return '#ffffff';
- 295: return luminance > 0.179 ? '#0f172a' : '#ffffff';
- 308: accent_color: '#2563eb',
- 357: if (!isValidHexColor(d.accent_color)) e.accent_color = 'Use a 6-digit hex color like #2563eb.';

### src/lib/locations.ts
- 495: if (color.trim() && !COLOR_RE.test(color.trim())) return 'Color must look like #1A2B3C.';

### src/lib/marketingCreative.ts
- 75: export const DEFAULT_BRAND: BrandColors = { primary: '#2563EB', accent: '#0EA5E9' };
- 198: export function contrastText(hex: string): '#000000' | '#FFFFFF' {
- 199: if (!isHexColor(hex)) return '#FFFFFF';
- 202: return lum > 0.4 ? '#000000' : '#FFFFFF';
- 332: ctx.fillStyle = '#FFFFFF';

### src/lib/paymentElement.ts
- 21: /** "12 34 56" / "12, 34, 56" (Tailwind CSS-variable triplet) -> "#0c2238". Null if it isn't a triplet. */
- 28: const FALLBACK_ACCENT = '#2563eb';

### src/lib/richMessaging.ts
- 73: return 'Brand colour must look like #1A2B3C.';

### src/lib/serviceAreas.ts
- 87: '#3b82f6',
- 88: '#22c55e',
- 89: '#f59e0b',
- 90: '#ef4444',
- 91: '#a855f7',
- 92: '#06b6d4',
- 93: '#ec4899',
- 94: '#84cc16',

### src/lib/serviceGraph.ts
- 148: customer: '#3b82f6',
- 149: property: '#14b8a6',
- 150: equipment: '#f59e0b',
- 151: failure: '#ef4444',
- 152: technician: '#8b5cf6',
- 153: part: '#ec4899',
- 154: job: '#64748b',
- 155: outcome: '#22c55e',
- 156: warranty: '#06b6d4',
- 157: vendor: '#a855f7',
- 158: call: '#0ea5e9',
- 159: payment: '#84cc16',
- 160: contractor: '#f97316',
- 161: knowledge: '#6366f1',
- 162: agent: '#d946ef',
- 163: component: '#eab308',
- 164: hazard: '#dc2626',
- 165: capture: '#94a3b8',

### src/lib/trustPack/notices.ts
- 150: const rows = lines.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#667085">${escapeHtml(k)}</td>
- 151: const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#101828">
- 156: ${opts.unsubscribeUrl ? `<p style="font-size:12px;color:#667085"><a href="${escapeHtml(opts.unsubscribeUrl)}">

### src/lib/universalIdentity.ts
- 22: person: { code: 'PER', label: 'Person', plural: 'People', hint: 'A human: customer, occupant, owner', color: '
- 23: company: { code: 'CMP', label: 'Company', plural: 'Companies', hint: 'A legal organisation or business account
- 24: property: { code: 'PRP', label: 'Property', plural: 'Properties', hint: 'A building, unit or service site', co
- 25: equipment: { code: 'EQP', label: 'Equipment', plural: 'Equipment', hint: 'A physical unit with a serial number
- 26: service: { code: 'SVC', label: 'Service', plural: 'Services', hint: 'A job, visit or service event', color: '#
- 27: technician: { code: 'TEC', label: 'Technician', plural: 'Technicians', hint: 'A field professional identity', 
- 28: contractor: { code: 'CTR', label: 'Contractor', plural: 'Contractors', hint: 'An external contracting party', 
- 29: part: { code: 'PRT', label: 'Part', plural: 'Parts', hint: 'A component or consumable', color: '#a855f7' },
- 30: agent: { code: 'AGT', label: 'Agent', plural: 'Agents', hint: 'An AI or automated actor', color: '#06b6d4' },
- 31: outcome: { code: 'OUT', label: 'Outcome', plural: 'Outcomes', hint: 'The result of a service', color: '#84cc16
- 32: evidence: { code: 'EVD', label: 'Evidence', plural: 'Evidence', hint: 'A proof artefact: photo, reading, signa
- 33: transaction: { code: 'TXN', label: 'Transaction', plural: 'Transactions', hint: 'Money moving: invoice, paymen

### src/lib/websiteWidgets.ts
- 148: brand_color: '#3448E8',
- 241: if (!/^#[0-9a-fA-F]{6}$/.test(s.brand_color)) e.brand_color = 'Use a 6-digit hex color, e.g. #3448E8.';

### src/pages/AdvancedRoutingPage.tsx
- 39: const TERRITORY_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];

### src/pages/BadgePage.tsx
- 21: <span className="flex items-center gap-2.5 rounded-full border border-[#e5e7eb] bg-bg-secondary px-4 py-2 shad
- 23: <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22c55e] opacity-60" />
- 24: <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
- 26: <Phone size={14} className="shrink-0 text-[#111827]" />
- 27: <span className="text-[13px] font-semibold leading-none text-[#111827]">
- 30: <span className="text-[11px] leading-none text-[#9ca3af]">by Vireek AI</span>

### src/pages/BookingSettingsPage.tsx
- 333: <input id="brand-color-picker" type="color" aria-label="Pick accent colour" value={draft.branding.accent_color

### src/pages/BrandGuidelinesPage.tsx
- 194: <Card className="flex flex-col items-center justify-center gap-6 !bg-[#0A0A0C] py-16">

### src/pages/BrandingSettingsPage.tsx
- 161: value={isHexColor(value) ? value : '#000000'}
- 178: placeholder="#2563EB"
- 250: const bg = dark ? '#0B1220' : '#FFFFFF';
- 251: const fg = dark ? '#E5E7EB' : '#0F172A';
- 252: const muted = dark ? '#94A3B8' : '#64748B';
- 253: const line = dark ? '#1F2A3D' : '#E2E8F0';

### src/pages/BreakCompliancePage.tsx
- 575: <input type="radio" name="decision" className="mt-1 h-4 w-4 accent-[var(--color-accent,#2563eb)]" checked={sta
- 677: className="h-5 w-5 accent-[var(--color-accent,#2563eb)]"

### src/pages/ChatWidgetSettingsPage.tsx
- 261: <input type="color" aria-label="Pick brand color" value={/^#[0-9a-fA-F]{6}$/.test(draft.brand_color) ? draft.b

### src/pages/CustomerStatementsPage.tsx
- 270: <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent,#203ad8)]" checked={consolidate} onChange

### src/pages/DispatchRulesPage.tsx
- 72: <input type="checkbox" role="switch" checked={draft.enabled} disabled={dis} onChange={(e) => set({ enabled: e.
- 89: <input id={`w-${rule.rule_type}`} type="range" min={0} max={100} step={5} disabled={dis} value={draft.weight} 

### src/pages/EmailSettingsPage.tsx
- 484: className="focus-ring mt-1 h-4 w-4 rounded border-border accent-[var(--color-accent,#2563eb)]"

### src/pages/FindingsPackagePublicPage.tsx
- 243: <input type="radio" name={`opt-${item.id}`} checked={on} onChange={() => onSelect(option.id)} className="mt-1 

### src/pages/FirstTimeFixAutopilotPage.tsx
- 483: className="mt-2 w-full accent-[var(--color-accent,#2563eb)]"

### src/pages/InventoryPage.tsx
- 321: <StatCard label="Low / out of stock" value={alerts.length} tone={alerts.length ? '#ef4444' : undefined} />
- 322: <StatCard label="Jobs at risk" value={readiness.length} tone={readiness.length ? '#f59e0b' : undefined} />

### src/pages/LandingPagesPage.tsx
- 426: value={/^#[0-9a-fA-F]{6}$/.test(draft.accent_color) ? draft.accent_color : '#2563eb'}

### src/pages/LeadAssignmentPage.tsx
- 72: className="h-4 w-4 accent-[var(--accent,#2563eb)]"

### src/pages/LeadMarketplacesPage.tsx
- 127: <input id={id} type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="h-4 w-4 ac

### src/pages/PartsIntelligencePage.tsx
- 520: <input type="checkbox" checked={recallOnly} onChange={(e) => setRecallOnly(e.target.checked)} className="h-4 w

### src/pages/QuickBooksSyncPage.tsx
- 151: <input type="checkbox" checked={es.enabled} onChange={(e) => patch(entity, { enabled: e.target.checked })} cla

### src/pages/RemoteResolutionPage.tsx
- 262: className="h-4 w-4 accent-[var(--color-accent,#4f46e5)]"

### src/pages/RichMessagingSettingsPage.tsx
- 57: className="mt-1 h-4 w-4 accent-[var(--color-accent,#2563eb)]"
- 258: placeholder="#1A2B3C"

### src/pages/ServiceDataExchangePage.tsx
- 339: className="h-3.5 w-3.5 accent-[var(--color-accent,#2563eb)]"

### src/pages/ToolCribPage.tsx
- 1208: <input type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} disabled={busy} clas

### src/pages/WalletLandingPage.tsx
- 43: <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl text-white" style={{ background
- 67: <a href={googleHref} className="focus-ring flex h-12 items-center justify-center rounded-xl border border-bord

### src/pages/WebsiteWidgetsPage.tsx
- 337: <input type="color" aria-label="Pick brand color" value={/^#[0-9a-fA-F]{6}$/.test(effective.brand_color) ? eff
