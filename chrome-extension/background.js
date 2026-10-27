// Service worker: owns the session, talks to the API, handles context menus.
import { CONFIG, isConfigured } from './lib/config.js';
import { createSession } from './lib/session.js';
import { createApi, ApiError, newRequestId } from './lib/api.js';
import { findEmails, findPhones, phoneFromTelHref, toE164 } from './lib/phone.js';

const storage = {
  get: (k) => chrome.storage.local.get(k),
  set: (v) => chrome.storage.local.set(v),
  remove: (k) => chrome.storage.local.remove(k),
};
const session = createSession({ config: CONFIG, storage });
const callApi = createApi({ config: CONFIG, session });
const ACTIONS = new Set(['whoami', 'capture_lead', 'click_to_call', 'call_status', 'recent']);

const err = (e) => ({
  ok: false,
  code: e?.code ?? 'error',
  status: e?.status ?? 0,
  message: String(e?.message ?? 'error'),
  data: e instanceof ApiError ? e.data : {},
});

async function handle(msg) {
  if (!isConfigured()) return { ok: false, code: 'not_configured' };
  switch (msg?.type) {
    case 'auth:status':
      return { ok: true, ...(await session.status()) };
    case 'auth:login':
      return { ok: true, ...(await session.signIn(msg.email, msg.password)) };
    case 'auth:mfa':
      await session.verifyMfa(msg.code);
      return { ok: true };
    case 'auth:logout':
      await session.signOut();
      return { ok: true };
    case 'api': {
      if (!ACTIONS.has(msg.action)) return { ok: false, code: 'bad_request' };
      const body = { ...(msg.body ?? {}) };
      if ((msg.action === 'click_to_call' || msg.action === 'capture_lead') && !body.request_id)
        body.request_id = newRequestId();
      return { ok: true, data: await callApi(msg.action, body) };
    }
    case 'prefill:take': {
      const { vk_prefill: p } = await chrome.storage.session.get('vk_prefill');
      await chrome.storage.session.remove('vk_prefill');
      await chrome.action.setBadgeText({ text: '' });
      return { ok: true, prefill: p ?? null };
    }
    default:
      return { ok: false, code: 'bad_request' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension contexts (popup, content scripts) may talk to the worker.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(sendResponse, (e) => sendResponse(err(e)));
  return true;
});

// ---------------------------------------------------------------- context menus
const MENU_CALL = 'vk-call';
const MENU_LEAD = 'vk-lead';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_CALL,
      title: chrome.i18n.getMessage('menuCall'),
      contexts: ['selection', 'link'],
    });
    chrome.contextMenus.create({
      id: MENU_LEAD,
      title: chrome.i18n.getMessage('menuLead'),
      contexts: ['selection', 'page', 'link'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = info.selectionText ?? '';
  const phone =
    phoneFromTelHref(info.linkUrl ?? '') ??
    toE164(text.trim()) ??
    findPhones(text, 1)[0]?.e164 ??
    null;
  const email =
    findEmails(text, 1)[0] ??
    (/^mailto:/i.test(info.linkUrl ?? '') ? info.linkUrl.slice(7).split('?')[0] : null);
  const prefill = {
    mode: info.menuItemId === MENU_CALL ? 'call' : 'lead',
    phone,
    email,
    name: !phone && !email ? text.trim().slice(0, 120) : '',
    url: tab?.url ?? '',
    title: tab?.title ?? '',
  };
  await chrome.storage.session.set({ vk_prefill: prefill });
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.action.setBadgeBackgroundColor({ color: '#203AD8' });
    await chrome.action.setBadgeText({ text: '1' });
  }
});
