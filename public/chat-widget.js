/*! Vireek chat widget loader — dependency-free, Shadow-DOM isolated. Mirrors getWidgetStatus() in src/lib/chatWidget.ts. */
(function () {
  'use strict';
  if (window.__vireekChatWidget) return;
  var el = document.currentScript;
  if (!el) return;
  var KEY = el.getAttribute('data-key');
  var API = (el.getAttribute('data-api') || '').replace(/\/$/, '');
  var ANON = el.getAttribute('data-anon') || '';
  if (!KEY || !API || !ANON) return;
  window.__vireekChatWidget = true;

  var HDR = { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + ANON };
  function rpc(fn, body) {
    return fetch(API + '/rest/v1/rpc/' + fn, { method: 'POST', headers: HDR, body: JSON.stringify(body), keepalive: false }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* ignore */ }
        if (!r.ok) { var err = new Error((j && j.message) || 'request failed'); err.status = r.status; throw err; }
        return j;
      });
    });
  }

  var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  function mins(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
  function status(c) {
    var online = true;
    if (c.hours_mode === 'scheduled') {
      var p;
      try {
        p = new Intl.DateTimeFormat('en-US', { timeZone: c.timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
      } catch (e) {
        p = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
      }
      var get = function (t) { for (var i = 0; i < p.length; i++) if (p[i].type === t) return p[i].value; return ''; };
      var wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
      var m = Number(get('hour')) * 60 + Number(get('minute'));
      var d = c.schedule && c.schedule[String(wd)];
      online = !!d && HHMM.test(d.open) && HHMM.test(d.close) && m >= mins(d.open) && m < mins(d.close);
    }
    if (online) return { online: true, visible: true, canSend: true };
    return { online: false, visible: c.offline_behavior !== 'hide', canSend: c.offline_behavior === 'collect_lead' };
  }
  function textOn(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return '#FFFFFF';
    var ch = [0, 2, 4].map(function (i) { var v = parseInt(m[1].slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.4 ? '#111827' : '#FFFFFF';
  }
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  function mount(c) {
    var brand = /^#[0-9a-fA-F]{6}$/.test(c.brand_color) ? c.brand_color : '#3448E8';
    var onBrand = textOn(brand);
    var dark = c.theme === 'dark' || (c.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var left = c.position === 'left';
    var st = status(c);
    if (!st.visible) return;

    var host = h('div', { id: 'vireek-chat-root' });
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;bottom:0;' + (left ? 'left:0' : 'right:0');
    var root = host.attachShadow({ mode: 'open' });
    var css = ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wrap{--b:' + brand + ';--on:' + onBrand + ';--bg:' + (dark ? '#111827' : '#fff') + ';--sf:' + (dark ? '#1f2937' : '#f3f4f6') + ';--tx:' + (dark ? '#f9fafb' : '#111827') + ';--mu:' + (dark ? '#9ca3af' : '#6b7280') + ';--bd:' + (dark ? '#374151' : '#e5e7eb') + ';padding:16px;display:flex;flex-direction:column;gap:12px;align-items:' + (left ? 'flex-start' : 'flex-end') + '}' +
      '.fab{width:56px;height:56px;border-radius:50%;border:0;background:var(--b);color:var(--on);cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}' +
      '.fab:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--b);outline-offset:2px}' +
      '.panel{width:360px;max-width:calc(100vw - 32px);max-height:min(560px,calc(100dvh - 104px));display:none;flex-direction:column;background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.3)}' +
      '.panel.open{display:flex}.hd{background:var(--b);color:var(--on);padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px}' +
      '.hd b{font-size:15px}.hd small{display:block;font-size:11px;opacity:.9;margin-top:2px}.x{background:none;border:0;color:inherit;cursor:pointer;font-size:20px;line-height:1;padding:4px}' +
      '.bd{padding:14px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:8px}.bub{background:var(--sf);border-radius:14px 14px 14px 4px;padding:9px 12px;font-size:14px;line-height:1.45;max-width:88%}' +
      '.me{background:var(--b);color:var(--on);border-radius:14px 14px 4px 14px;align-self:flex-end}' +
      'form{border-top:1px solid var(--bd);padding:10px;display:flex;flex-direction:column;gap:8px}' +
      'input,textarea{width:100%;border:1px solid var(--bd);background:var(--bg);color:var(--tx);border-radius:10px;padding:9px 11px;font-size:16px;resize:none}' +
      '.send{background:var(--b);color:var(--on);border:0;border-radius:10px;padding:10px;font-weight:600;font-size:14px;cursor:pointer}.send:disabled{opacity:.5;cursor:not-allowed}' +
      '.err{color:#dc2626;font-size:12px}.ok{font-size:14px;color:var(--tx)}' +
      '@media(max-width:480px){.panel.open{position:fixed;inset:0;width:100vw;max-width:none;max-height:none;height:100dvh;border-radius:0;border:0}}' +
      '@media(prefers-reduced-motion:no-preference){.panel.open{animation:in .18s ease-out}@keyframes in{from{opacity:0;transform:translateY(10px)}}}';
    root.appendChild(h('style', { text: css }));

    var wrap = h('div', { class: 'wrap' });
    var panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': c.title });
    var fab = h('button', { class: 'fab', type: 'button', 'aria-label': 'Open chat', 'aria-expanded': 'false' });
    fab.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

    var close = h('button', { class: 'x', type: 'button', 'aria-label': 'Close chat', text: '×' });
    var hd = h('div', { class: 'hd' }, [h('div', {}, [h('b', { text: c.title }), h('small', { text: st.online ? (c.business_name || 'We typically reply in minutes') : 'Offline' })]), close]);
    var bd = h('div', { class: 'bd', 'aria-live': 'polite' }, [h('div', { class: 'bub', text: st.online ? c.greeting : c.offline_message })]);
    panel.appendChild(hd);
    panel.appendChild(bd);

    if (st.canSend) {
      var cf = c.contact_field;
      var name = h('input', { type: 'text', placeholder: 'Your name (optional)', maxlength: '80', autocomplete: 'name', 'aria-label': 'Your name' });
      var email = h('input', { type: 'email', placeholder: cf === 'either' ? 'Email' : 'you@company.com', maxlength: '254', autocomplete: 'email', 'aria-label': 'Email' });
      var phone = h('input', { type: 'tel', placeholder: 'Phone number', maxlength: '40', autocomplete: 'tel', 'aria-label': 'Phone' });
      var msg = h('textarea', { rows: '2', placeholder: st.online ? 'Type a message…' : 'Leave a message…', maxlength: '2000', 'aria-label': 'Message', required: '' });
      var err = h('div', { class: 'err', role: 'alert' });
      var send = h('button', { class: 'send', type: 'submit', text: 'Send' });
      var form = h('form', {});
      form.appendChild(name);
      if (cf === 'email' || cf === 'either') form.appendChild(email);
      if (cf === 'phone' || cf === 'either') form.appendChild(phone);
      [msg, err, send].forEach(function (n) { form.appendChild(n); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        err.textContent = '';
        var body = msg.value.trim();
        if (!body) { err.textContent = 'Please write a message.'; return; }
        if (cf === 'email' && !email.value.trim()) { err.textContent = 'Please enter your email.'; return; }
        if (cf === 'phone' && !phone.value.trim()) { err.textContent = 'Please enter your phone number.'; return; }
        if (cf === 'either' && !email.value.trim() && !phone.value.trim()) { err.textContent = 'Please enter an email or phone number.'; return; }
        send.disabled = true; send.textContent = 'Sending…';
        rpc('submit_chat_widget_message', { p_key: KEY, p_host: location.hostname, p_name: name.value, p_email: email.value, p_phone: phone.value, p_body: body, p_page_url: location.href })
          .then(function () {
            bd.appendChild(h('div', { class: 'bub me', text: body }));
            bd.appendChild(h('div', { class: 'bub ok', text: cf === 'none' ? 'Thanks — your message was sent.' : 'Thanks — we got your message and will reply using the contact details you gave.' }));
            form.style.display = 'none';
            bd.scrollTop = bd.scrollHeight;
          })
          .catch(function (ex) {
            var m = String((ex && ex.message) || '');
            err.textContent = /BAD_EMAIL/.test(m) ? 'That email address looks invalid.' : /RATE_LIMITED/.test(m) ? 'Too many messages right now. Please try again shortly.' : 'Could not send. Please try again.';
            send.disabled = false; send.textContent = 'Send';
          });
      });
      panel.appendChild(form);
    }

    function setOpen(v) {
      panel.classList.toggle('open', v);
      fab.setAttribute('aria-expanded', String(v));
      fab.style.display = v && window.innerWidth <= 480 ? 'none' : 'flex';
      if (v) { var f = panel.querySelector('textarea'); if (f) setTimeout(function () { f.focus(); }, 50); } else fab.focus();
    }
    fab.addEventListener('click', function () { setOpen(!panel.classList.contains('open')); });
    close.addEventListener('click', function () { setOpen(false); });
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

    wrap.appendChild(panel);
    wrap.appendChild(fab);
    root.appendChild(wrap);
    document.body.appendChild(host);
  }

  function start() {
    rpc('get_public_chat_widget_config', { p_key: KEY, p_host: location.hostname })
      .then(function (c) { if (c && typeof c === 'object') mount(c); })
      .catch(function () { /* fail silently: never break the host page */ });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
