import { CONFIG, isConfigured } from './lib/config.js';
import { findEmails, findPhones, formatPhone, toE164 } from './lib/phone.js';

const $ = (id) => document.getElementById(id);
const t = (k, s) => chrome.i18n.getMessage(k, s) || k;
const send = (msg) =>
  new Promise((r) =>
    chrome.runtime.sendMessage(msg, (x) =>
      r(chrome.runtime.lastError ? { ok: false, code: 'worker' } : x),
    ),
  );
const api = (action, body) => send({ type: 'api', action, body });
const TERMINAL = ['completed', 'busy', 'no_answer', 'failed', 'canceled'];
let me = null;
let pageUrl = '';
let pageTitle = '';
let pollTimer = 0;

if (/^(fa|ar|he)/.test(chrome.i18n.getUILanguage())) document.documentElement.dir = 'rtl';
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);

function show(view) {
  for (const id of ['v-config', 'v-login', 'v-mfa', 'v-app']) $(id).hidden = id !== view;
  $('logout').hidden = view === 'v-config' || view === 'v-login';
}
function say(text, kind = '') {
  const m = $('msg');
  m.hidden = !text;
  m.textContent = text ?? '';
  m.className = kind;
}
const errText = (res) => {
  const code = res?.data?.code ?? res?.code;
  if (code === 'quiet_hours') return t('err_quiet_hours', [res?.data?.local_time ?? '']);
  return t(`err_${code}`) !== `err_${code}`
    ? t(`err_${code}`)
    : res?.data?.error && res.status < 500
      ? res.data.error
      : t('errGeneric');
};
const busy = (btn, on) => {
  btn.disabled = on;
};

// ------------------------------------------------------------------ boot
async function boot() {
  $('forgot').href = `${CONFIG.APP_URL}/forgot-password`;
  if (!isConfigured()) return show('v-config');
  const st = await send({ type: 'auth:status' });
  if (!st?.signedIn) return show('v-login');
  await enterApp();
}

async function enterApp() {
  const res = await api('whoami');
  if (!res.ok) {
    if (res.code === 'signed_out' || res.data?.code === 'not_authenticated') {
      show('v-login');
      return;
    }
    if (res.data?.code === 'mfa_required') {
      show('v-mfa');
      return;
    }
    show('v-app');
    say(errText(res), 'err');
    return;
  }
  me = res.data;
  $('who').textContent = me.company || me.user.name || me.user.email || 'Vireek';
  show('v-app');
  const c2c = me.features.click_to_call;
  $('b-savecall').hidden = !c2c.enabled;
  $('b-call').disabled = !c2c.enabled;
  const note = $('call-note');
  note.hidden = c2c.enabled;
  if (!c2c.enabled) note.textContent = t(`unavail_${c2c.reason}`);
  else {
    note.hidden = false;
    note.textContent = t('ringsFirst', [c2c.agent_hint || '']);
  }
  const { vk_settings: s } = await chrome.storage.local.get('vk_settings');
  $('s-inline').checked = s?.inlineButtons !== false;
  await loadContext();
  const { prefill } = await send({ type: 'prefill:take' });
  if (prefill) applyPrefill(prefill);
}

async function loadContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageUrl = tab?.url ?? '';
  pageTitle = tab?.title ?? '';
  let ctx = null;
  try {
    ctx = tab?.id ? await chrome.tabs.sendMessage(tab.id, { type: 'vk:context' }) : null;
  } catch {
    /* restricted page */
  }
  if (!ctx) return;
  const sel = ctx.selection?.trim() ?? '';
  const phone = toE164(sel) ?? findPhones(sel, 1)[0]?.e164 ?? ctx.phones?.[0] ?? '';
  const email = findEmails(sel, 1)[0] ?? ctx.emails?.[0] ?? '';
  if (phone) $('f-phone').value = phone;
  if (email) $('f-email').value = email;
  if (sel && !phone && !email && sel.length <= 120) $('f-name').value = sel;
  $('chips').replaceChildren(
    ...(ctx.phones ?? []).map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = formatPhone(p);
      b.dir = 'ltr';
      b.addEventListener('click', () => {
        $('c-number').value = p;
      });
      return b;
    }),
  );
  if (ctx.phones?.[0] && !$('c-number').value) $('c-number').value = ctx.phones[0];
}

function applyPrefill(p) {
  pageUrl = p.url || pageUrl;
  pageTitle = p.title || pageTitle;
  if (p.phone) {
    $('f-phone').value = p.phone;
    $('c-number').value = p.phone;
  }
  if (p.email) $('f-email').value = p.email;
  if (p.name) $('f-name').value = p.name;
  tab(p.mode === 'call' ? 'call' : 'lead');
}

// ------------------------------------------------------------------ auth
$('v-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  busy(btn, true);
  say('');
  const res = await send({
    type: 'auth:login',
    email: $('l-email').value,
    password: $('l-pass').value,
  });
  busy(btn, false);
  if (!res?.ok) return say(res?.code === 'network' ? t('errNetwork') : t('errLogin'), 'err');
  $('l-pass').value = '';
  if (res.mfaFactor) return show('v-mfa');
  await enterApp();
});
$('v-mfa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  busy(btn, true);
  say('');
  const res = await send({ type: 'auth:mfa', code: $('m-code').value });
  busy(btn, false);
  if (!res?.ok) return say(t('errMfa'), 'err');
  $('m-code').value = '';
  await enterApp();
});
$('logout').addEventListener('click', async () => {
  await send({ type: 'auth:logout' });
  me = null;
  say('');
  show('v-login');
});

// ------------------------------------------------------------------ tabs
function tab(name) {
  for (const b of document.querySelectorAll('nav [role=tab]'))
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
  say('');
  if (name === 'recent') loadRecent();
}
for (const b of document.querySelectorAll('nav [role=tab]'))
  b.addEventListener('click', () => tab(b.dataset.tab));

// ------------------------------------------------------------------ lead capture
const leadBody = () => ({
  name: $('f-name').value,
  company: $('f-company').value,
  phone: $('f-phone').value,
  email: $('f-email').value,
  service: $('f-service').value,
  note: $('f-note').value,
  page_url: pageUrl,
  page_title: pageTitle,
});
async function saveLead(thenCall) {
  say('');
  const body = leadBody();
  const res = await api('capture_lead', body);
  if (!res.ok) {
    say(errText(res), 'err');
    return null;
  }
  const d = res.data;
  say(d.duplicate ? t('leadDuplicate') : t('leadSaved'), 'ok');
  if (d.lead_url) {
    $('open-lead').href = d.lead_url;
    $('open-lead').hidden = false;
  }
  if (!thenCall) for (const id of ['f-name', 'f-company', 'f-service', 'f-note']) $(id).value = '';
  return d;
}
$('p-lead').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('b-save'), true);
  await saveLead(false);
  busy($('b-save'), false);
});
$('b-savecall').addEventListener('click', async () => {
  const phone = toE164($('f-phone').value);
  if (!phone) return say(t('err_invalid_number'), 'err');
  busy($('b-savecall'), true);
  const d = await saveLead(true);
  if (d) await placeCall(phone, d.lead_id);
  busy($('b-savecall'), false);
});

// ------------------------------------------------------------------ calling
async function placeCall(number, leadId) {
  const to = toE164(number);
  if (!to) return say(t('err_invalid_number'), 'err');
  const res = await api('click_to_call', { to, lead_id: leadId ?? undefined, page_url: pageUrl });
  if (!res.ok) return say(errText(res), 'err');
  say(t('ringingYou'), 'ok');
  poll(res.data.id);
}
$('p-call').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('b-call'), true);
  await placeCall($('c-number').value);
  busy($('b-call'), false);
});
function poll(id, n = 0) {
  clearTimeout(pollTimer);
  if (n > 30) return;
  pollTimer = setTimeout(async () => {
    const r = await api('call_status', { id });
    if (!r.ok) return;
    say(
      `${t(`st_${r.data.status}`)}`,
      r.data.status === 'answered' || r.data.status === 'completed'
        ? 'ok'
        : TERMINAL.includes(r.data.status)
          ? 'err'
          : '',
    );
    if (!TERMINAL.includes(r.data.status)) poll(id, n + 1);
  }, 4000);
}

async function loadRecent() {
  const r = await api('recent', { limit: 12 });
  const ul = $('recent-list');
  ul.replaceChildren();
  const items = r.ok ? r.data.items : [];
  $('recent-empty').hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.textContent =
      it.kind === 'click_to_call' ? `${t('tabCall')} ${it.to_masked}` : t('tabLead');
    const small = document.createElement('small');
    small.textContent = new Date(it.created_at).toLocaleString();
    left.append(document.createElement('br'), small);
    const st = document.createElement('span');
    st.className = `st ${['answered', 'completed', 'captured'].includes(it.status) ? 'ok' : ['failed', 'busy', 'no_answer', 'canceled'].includes(it.status) ? 'bad' : ''}`;
    st.textContent = t(`st_${it.status}`) !== `st_${it.status}` ? t(`st_${it.status}`) : it.status;
    li.append(left, st);
    ul.append(li);
  }
}

$('s-inline').addEventListener('change', async (e) => {
  const { vk_settings: s } = await chrome.storage.local.get('vk_settings');
  await chrome.storage.local.set({
    vk_settings: { ...(s ?? {}), inlineButtons: e.target.checked },
  });
});

boot();
