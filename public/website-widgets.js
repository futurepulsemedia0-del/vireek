/*! Vireek website widgets — booking · request-a-quote · reviews badge.
    Dependency-free, Shadow-DOM isolated. One <script> tag per widget; several can live on the same page.
    Mirrors: default copy in src/lib/websiteWidgets.ts, slot rules in src/lib/bookingPolicy.ts (generateSlots),
    limits in supabase/migrations/20271021000000_website_widgets.sql. Keep them in sync. */
(function () {
  'use strict';
  var currentTag = document.currentScript;
  var NS = (window.__vireekWW = window.__vireekWW || {});
  // Loaded more than once (one tag per widget): the engine already exists, just hand it this tag.
  if (NS.api) {
    if (currentTag) NS.api.init(currentTag);
    return;
  }

  /* ------------------------------ constants ------------------------------ */
  var DEFAULTS = {
    booking: { title: 'Book online', subtitle: 'Pick a time that works for you.', button: 'Book now', success: "You're booked! We'll see you then." },
    quote: { title: 'Request a free quote', subtitle: 'Tell us what you need — we reply fast.', button: 'Get a quote', success: 'Thanks! We got your request and will be in touch shortly.' },
    reviews: { title: 'What customers say', subtitle: '', button: 'See all reviews', success: '' }
  };
  var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var MAX_SLOTS = 600;
  var MAX_DAY_BUTTONS = 30;
  var MIN = 60000;
  var uidN = 0;

  var ICONS = {
    cal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    quote: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
    star: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z"/></svg>',
    check: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>'
  };

  /* ------------------------------- helpers -------------------------------- */
  function uid(p) { uidN += 1; return (p || 'v') + uidN; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v; // static SVG constants only — never data
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function isHex(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }
  function lum(r, g, b) {
    var ch = [r, g, b].map(function (x) { var v = x / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function textOn(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return '#FFFFFF';
    return lum(parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)) > 0.4 ? '#111827' : '#FFFFFF';
  }
  function hexLum(hex) { return lum(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)); }
  function ratio(a, b) { var x = hexLum(a), y = hexLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function blend(hex, target, t) {
    var out = '#';
    for (var i = 1; i < 7; i += 2) {
      var a = parseInt(hex.slice(i, i + 2), 16), b = parseInt(target.slice(i, i + 2), 16);
      var v = Math.round(a + (b - a) * t).toString(16);
      out += v.length < 2 ? '0' + v : v;
    }
    return out;
  }
  /** Brand colour as TEXT/outline on the widget background: nudged toward white/black until it reads (>= 4.5:1). */
  function accentOn(brand, bg, dark) {
    if (ratio(brand, bg) >= 4.5) return brand;
    for (var t = 0.1; t <= 1.0001; t += 0.1) {
      var c = blend(brand, dark ? '#FFFFFF' : '#000000', t);
      if (ratio(c, bg) >= 4.5) return c;
    }
    return dark ? '#FFFFFF' : '#000000';
  }
  /** "Auto" theme = match the page: walk up to the first non-transparent background and judge its luminance. */
  function pageIsDark(from) {
    try {
      for (var n = from; n && n.nodeType === 1; n = n.parentElement) {
        var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?/.exec(getComputedStyle(n).backgroundColor || '');
        if (!m) continue;
        var a = m[4] === undefined ? 1 : (String(m[4]).indexOf('%') > -1 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        if (a > 0.5) return lum(+m[1], +m[2], +m[3]) < 0.35;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  function str(v, d) { return typeof v === 'string' && v.trim() ? v : d; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  /* ----------------------------- network layer ----------------------------- */
  function makeRpc(api, anon) {
    var hdr = { 'Content-Type': 'application/json', apikey: anon, Authorization: 'Bearer ' + anon };
    return function rpc(fn, body, keepalive) {
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 12000) : null;
      return fetch(api + '/rest/v1/rpc/' + fn, { method: 'POST', headers: hdr, body: JSON.stringify(body), keepalive: !!keepalive, signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          return r.text().then(function (t) {
            var j = null;
            try { j = t ? JSON.parse(t) : null; } catch (e) { /* ignore */ }
            if (!r.ok) { var err = new Error((j && j.message) || 'request failed'); err.status = r.status; throw err; }
            return j;
          });
        })
        .then(function (v) { if (timer) clearTimeout(timer); return v; }, function (e) { if (timer) clearTimeout(timer); throw e; });
    };
  }

  /* --------------------------- time zone slot engine --------------------------- */
  var fmtCache = {};
  function dtf(tz) {
    var k = tz || '';
    if (!fmtCache[k]) fmtCache[k] = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    return fmtCache[k];
  }
  function validTz(tz) {
    if (!tz || typeof tz !== 'string') return undefined;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return undefined; }
  }
  function parts(ms, tz) {
    var o = {};
    dtf(tz).formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10); });
    if (o.hour === 24) o.hour = 0;
    return o;
  }
  function offsetMs(ms, tz) {
    var p = parts(ms, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }
  /** Wall-clock time in `tz` -> UTC ms. null when that wall time does not exist (spring-forward gap). */
  function zonedToUtc(y, m, d, hh, mi, tz) {
    var guess = Date.UTC(y, m - 1, d, hh, mi);
    var t = guess - offsetMs(guess, tz);
    t = guess - offsetMs(t, tz);
    var p = parts(t, tz);
    if (p.year !== y || p.month !== m || p.day !== d || p.hour !== hh || p.minute !== mi) return null;
    return t;
  }
  function hm(s) {
    var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s || '');
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }
  /**
   * Same rules as generateSlots() in src/lib/bookingPolicy.ts (lead time, window, holidays, step = duration,
   * buffers around busy jobs) but evaluated in the BUSINESS time zone, and without the 40-slot cap.
   */
  function computeSlots(d, now) {
    var tz = validTz(d.timezone);
    var hours = d.hours && typeof d.hours === 'object' ? d.hours : {};
    var holidays = {};
    (d.holidays || []).forEach(function (x) { holidays[x] = 1; });
    var dur = num(d.duration_minutes, 60) > 0 ? num(d.duration_minutes, 60) : 60;
    var lead = num(d.lead_time_hours, 0), win = num(d.window_days, 14);
    var bb = num(d.buffer_before, 0), ba = num(d.buffer_after, 0);
    var earliest = now + lead * 60 * MIN, latest = now + win * 24 * 60 * MIN;
    var busy = (d.busy || []).map(function (b) { var s = Date.parse(b.start); return { s: s, e: s + num(b.minutes, 60) * MIN }; }).filter(function (b) { return isFinite(b.s); });
    function free(t) {
      var end = t + dur * MIN;
      for (var i = 0; i < busy.length; i++) if (busy[i].s < end + ba * MIN && busy[i].e > t - bb * MIN) return false;
      return true;
    }
    var base = parts(now, tz);
    var out = [];
    for (var i = 0; i <= win && out.length < MAX_SLOTS; i++) {
      var cal = new Date(Date.UTC(base.year, base.month - 1, base.day + i));
      var y = cal.getUTCFullYear(), m = cal.getUTCMonth() + 1, day = cal.getUTCDate();
      var key = y + '-' + pad(m) + '-' + pad(day);
      var w = hours[DAYS[cal.getUTCDay()]];
      if (!w || holidays[key]) continue;
      var o = hm(w.open), c = hm(w.close);
      if (o === null || c === null) continue;
      for (var mins = o; mins + dur <= c && out.length < MAX_SLOTS; mins += dur) {
        var t = zonedToUtc(y, m, day, Math.floor(mins / 60), mins % 60, tz);
        if (t === null || t < earliest || t > latest) continue;
        if (free(t)) out.push({ ms: t, key: key });
      }
    }
    return out;
  }
  function groupByDay(slots) {
    var days = [], idx = {};
    slots.forEach(function (s) {
      if (idx[s.key] === undefined) { idx[s.key] = days.length; days.push({ key: s.key, ms: s.ms, slots: [] }); }
      days[idx[s.key]].slots.push(s);
    });
    return days;
  }
  function fmt(ms, tz, o) { try { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz || undefined }, o)).format(new Date(ms)); } catch (e) { return ''; } }
  function money(cents) { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); } catch (e) { return '$' + (cents / 100).toFixed(2); } }

  /* -------------------------------- styles -------------------------------- */
  function buildCss(s, contained) {
    var r = Math.max(0, Math.min(24, num(s.radius, 14)));
    var rs = Math.max(4, r - 4);
    var css = [
      ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
      '.w{color:var(--tx);font-size:14px;line-height:1.45;-webkit-text-size-adjust:100%}',
      'button{font:inherit;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}',
      'button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--a);outline-offset:2px}',
      '.float{padding:16px;display:flex;flex-direction:column;gap:12px}.float.right{align-items:flex-end}.float.left{align-items:flex-start}',
      '.launch{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:0 20px;border:0;border-radius:' + Math.max(r, 12) + 'px;background:var(--b);color:var(--on);font-weight:600;font-size:15px;box-shadow:0 6px 20px rgba(0,0,0,.25)}',
      '.panel{display:none;flex-direction:column;width:380px;max-width:calc(100vw - 32px);max-height:min(620px,calc(100vh - 110px));max-height:min(620px,calc(100dvh - 110px));background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:' + r + 'px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.3)}',
      contained ? '.panel{max-height:calc(100% - 20px)}' : '',
      '.panel.open{display:flex}',
      '.hd{background:var(--b);color:var(--on);padding:14px 16px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px}',
      '.hd b{display:block;font-size:16px}.hd small{display:block;font-size:12px;opacity:.92;margin-top:2px}',
      '.x{background:none;border:0;color:inherit;font-size:22px;line-height:1;padding:4px 8px;margin:-4px -8px 0 0;border-radius:8px}',
      '.pbody{padding:16px;overflow:auto;flex:1}',
      '.card{background:var(--bg);color:var(--tx);border:1px solid var(--bd);border-radius:' + r + 'px;padding:20px;max-width:560px}',
      '.ihd b{display:block;font-size:18px}.ihd small{display:block;color:var(--mu);margin-top:2px}.ihd{margin-bottom:14px}',
      '.view{display:flex;flex-direction:column;gap:14px}',
      '.lbl{display:block;font-size:12px;font-weight:600;color:var(--mu);margin-bottom:4px}.req{color:var(--err)}',
      'input,select,textarea{width:100%;border:1px solid var(--bd);background:var(--bg);color:var(--tx);border-radius:' + rs + 'px;padding:10px 12px;font-size:16px;min-height:44px}',
      'textarea{resize:vertical;min-height:84px}',
      '.hint{font-size:12px;color:var(--mu);margin-top:3px}',
      '.days{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 8px;scrollbar-width:thin}',
      '.day{flex:0 0 auto;min-width:64px;padding:8px 10px;border:1px solid var(--bd);background:var(--bg);color:var(--tx);border-radius:' + rs + 'px;text-align:center;line-height:1.25}',
      '.day small{display:block;color:var(--mu);font-size:11px}.day[aria-checked=true]{background:var(--b);border-color:var(--b);color:var(--on)}.day[aria-checked=true] small{color:var(--on);opacity:.9}',
      '.slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
      '.slot{min-height:44px;padding:8px;border:1px solid var(--bd);background:var(--bg);color:var(--tx);border-radius:' + rs + 'px;font-weight:600;font-size:13px}.slot:hover:not(:disabled){border-color:var(--a);color:var(--a)}',
      '.sum{display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--sf);border-radius:' + rs + 'px;padding:10px 12px;font-weight:600}',
      '.link{background:none;border:0;color:var(--a);font-weight:600;padding:4px;text-decoration:underline}',
      '.btn{min-height:46px;border:0;border-radius:' + rs + 'px;background:var(--b);color:var(--on);font-weight:700;font-size:15px;padding:0 18px;width:100%}',
      '.btn.alt{background:transparent;color:var(--a);border:1px solid var(--a)}',
      '.err{color:var(--err);font-size:13px;min-height:1px}.note{background:var(--sf);border-radius:' + rs + 'px;padding:12px;color:var(--mu);font-size:13px}',
      '.ok{text-align:center;padding:12px 4px;display:flex;flex-direction:column;align-items:center;gap:10px}.ok svg{color:var(--okc)}.ok p{margin:0}.ok .big{font-size:16px;font-weight:700}.ok .mu{color:var(--mu);font-size:13px}',
      '.hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}',
      '.badge{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}.stars{display:inline-flex;gap:1px;color:#F5A623}.sw{display:inline-flex}.num{font-weight:800;font-size:18px}.cnt{color:var(--mu);font-size:13px}',
      '.cta{color:var(--a);font-weight:600;font-size:13px;text-decoration:underline}',
      '.rv{display:flex;flex-direction:column;gap:14px}.rvhd b{font-size:18px;display:block;margin-bottom:6px}',
      '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}',
      '.rc{background:var(--bg);border:1px solid var(--bd);border-radius:' + r + 'px;padding:14px;display:flex;flex-direction:column;gap:8px}',
      '.rc p{margin:0;font-size:14px}.rc footer{font-size:12px;color:var(--mu)}',
      '.pill{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:var(--bg);color:var(--tx);border:1px solid var(--bd);box-shadow:0 6px 20px rgba(0,0,0,.2)}',
      'button.pill{font-weight:inherit}',
      '@media(prefers-reduced-motion:no-preference){.panel.open{animation:in .18s ease-out}@keyframes in{from{opacity:0;transform:translateY(10px)}}}',
      contained ? '' : '@media(max-width:480px){.panel.open{position:fixed;inset:0;width:100vw;max-width:none;max-height:none;height:100vh;height:100dvh;border-radius:0;border:0}.slots{grid-template-columns:repeat(2,1fr)}}'
    ];
    return css.join('');
  }
  /** Constructable stylesheets are not blocked by a site's `style-src` CSP (inline <style> is); fall back when unsupported. */
  function addStyles(root, css) {
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (e) { /* fall through */ }
    root.appendChild(h('style', { text: css }));
  }
  function applyTheme(wrap, s, dark) {
    var brand = isHex(s.brand_color) ? s.brand_color : '#3448E8';
    var bg = dark ? '#111827' : '#FFFFFF';
    var vars = {
      '--b': brand, '--on': textOn(brand), '--a': accentOn(brand, bg, dark),
      '--bg': bg, '--sf': dark ? '#1F2937' : '#F3F4F6', '--tx': dark ? '#F9FAFB' : '#111827',
      '--mu': dark ? '#9CA3AF' : '#6B7280', '--bd': dark ? '#374151' : '#E5E7EB',
      '--err': dark ? '#F87171' : '#DC2626', '--okc': dark ? '#34D399' : '#059669'
    };
    for (var k in vars) wrap.style.setProperty(k, vars[k]);
  }

  /* ------------------------------ shared pieces ------------------------------ */
  function field(label, input, opts) {
    opts = opts || {};
    var id = uid('f');
    input.setAttribute('id', id);
    var l = h('label', { class: 'lbl', for: id }, [label, opts.required ? h('span', { class: 'req', text: ' *', 'aria-hidden': 'true' }) : null]);
    return h('div', null, [l, input, opts.hint ? h('div', { class: 'hint', text: opts.hint }) : null]);
  }
  function honeypot() {
    return h('div', { class: 'hp', 'aria-hidden': 'true' }, [h('input', { type: 'text', name: 'vww_url', tabindex: '-1', autocomplete: 'off' })]);
  }
  function hpValue(form) { var i = form.querySelector('input[name=vww_url]'); return i ? i.value : ''; }
  function emailOk(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v); }
  function phoneOk(v) { return v.replace(/\D/g, '').length >= 7; }
  function errText(e) {
    var m = String((e && e.message) || '');
    if (/slot_taken/.test(m)) return 'That time was just taken — please pick another.';
    if (/too_soon/.test(m)) return 'That time is too soon to book online. Please pick a later one.';
    if (/intake_required/.test(m)) return 'Please answer the required questions.';
    if (/intake_invalid/.test(m)) return 'One of your answers looks invalid. Please check the form.';
    if (/service_unavailable/.test(m)) return 'That service is not available online. Please choose another.';
    if (/booking_not_available/.test(m)) return 'Online booking is not available right now. Please call us.';
    if (/BAD_EMAIL/.test(m)) return 'That email address looks invalid.';
    if (/BAD_PHONE/.test(m)) return 'That phone number looks invalid.';
    if (/BAD_NAME|missing_customer_name/.test(m)) return 'Please enter your name.';
    if (/CONTACT_REQUIRED/.test(m)) return 'Please add a phone number or email so we can reach you.';
    if (/MESSAGE_REQUIRED/.test(m)) return 'Please tell us a bit about the job.';
    if (/RATE_LIMITED/.test(m)) return 'Too many requests right now. Please try again shortly.';
    return 'Could not send. Please check your connection and try again.';
  }
  function successView(text, lines, onDone, doneLabel) {
    var kids = [h('div', { html: ICONS.check }), h('p', { class: 'big', text: text })];
    lines.forEach(function (l) { if (l) kids.push(h('p', { class: 'mu', text: l })); });
    if (onDone) { var b = h('button', { type: 'button', class: 'btn alt', text: doneLabel || 'Done' }); b.addEventListener('click', onDone); kids.push(b); }
    return h('div', { class: 'ok', role: 'status' }, kids);
  }
  function notice(text) { return h('div', { class: 'note', role: 'status', text: text }); }

  /* --------------------------------- booking --------------------------------- */
  function bookingView(ctx, payload) {
    var s = payload.settings, d0 = payload.data || {}, o = s.options || {};
    var root = h('div', { class: 'view' });
    if (d0.unavailable) { root.appendChild(notice("Online booking isn't available right now — please call us.")); return { el: root }; }

    var data = d0;
    var tz = validTz(data.timezone);
    var services = Array.isArray(data.services) ? data.services : [];
    var st = { step: 'time', service: services[0] || '', dayKey: null, slotMs: null, days: [], dep: 0, done: null, val: { name: '', phone: '', email: '', notes: '', intake: {} }, err: '' };
    var visitorTz = '';
    try { visitorTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* ignore */ }

    function recompute() {
      st.days = groupByDay(computeSlots(data, Date.now()));
      if (st.slotMs !== null && !st.days.some(function (dd) { return dd.slots.some(function (x) { return x.ms === st.slotMs; }); })) { st.slotMs = null; if (st.step === 'details') st.step = 'time'; }
      if (!st.days.some(function (dd) { return dd.key === st.dayKey; })) st.dayKey = st.days.length ? st.days[0].key : null;
    }
    function slotLabel(ms) { return fmt(ms, tz, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmt(ms, tz, { hour: 'numeric', minute: '2-digit' }); }

    function renderTime() {
      if (services.length > 1) {
        var sel = h('select', { 'aria-label': 'Service' }, services.map(function (x) { return h('option', { value: x, text: x }); }));
        sel.value = st.service;
        sel.addEventListener('change', function () { st.service = sel.value; });
        root.appendChild(field('Service', sel));
      }
      if (!st.days.length) { root.appendChild(notice('No open times in the next ' + num(data.window_days, 14) + ' days — please call us to find a time together.')); return; }
      var group = h('div', { class: 'days', role: 'radiogroup', 'aria-label': 'Choose a day' });
      st.days.slice(0, MAX_DAY_BUTTONS).forEach(function (dd) {
        var b = h('button', { type: 'button', class: 'day', role: 'radio', 'aria-checked': String(dd.key === st.dayKey) }, [
          fmt(dd.ms, tz, { weekday: 'short' }), h('small', { text: fmt(dd.ms, tz, { month: 'short', day: 'numeric' }) })
        ]);
        b.addEventListener('click', function () { st.dayKey = dd.key; rerender(); });
        group.appendChild(b);
      });
      root.appendChild(group);
      var cur = st.days.filter(function (dd) { return dd.key === st.dayKey; })[0] || st.days[0];
      var grid = h('div', { class: 'slots', role: 'group', 'aria-label': 'Available times' });
      cur.slots.forEach(function (sl) {
        var b = h('button', { type: 'button', class: 'slot', text: fmt(sl.ms, tz, { hour: 'numeric', minute: '2-digit' }) });
        b.addEventListener('click', function () { st.slotMs = sl.ms; st.step = 'details'; st.err = ''; rerender(); });
        grid.appendChild(b);
      });
      root.appendChild(grid);
      if (tz && visitorTz && tz !== visitorTz) root.appendChild(h('div', { class: 'hint', text: 'Times shown in ' + (fmt(cur.ms, tz, { timeZoneName: 'short' }).split(' ').pop() || tz) + ' (' + (data.business_name || 'business') + ' local time).' }));
    }

    function intakeInput(q) {
      var v = st.val.intake[q.id] || '';
      var el;
      if (q.type === 'longtext') el = h('textarea', { maxlength: '1000', rows: '3' });
      else if (q.type === 'select' || q.type === 'yesno') {
        var opts = q.type === 'yesno' ? ['yes', 'no'] : (Array.isArray(q.options) ? q.options : []);
        el = h('select', null, [h('option', { value: '', text: 'Select…' })].concat(opts.map(function (x) { return h('option', { value: x, text: q.type === 'yesno' ? (x === 'yes' ? 'Yes' : 'No') : x }); })));
      } else el = h('input', { type: 'text', maxlength: '1000' });
      el.value = v;
      el.addEventListener('input', function () { st.val.intake[q.id] = el.value; });
      el.addEventListener('change', function () { st.val.intake[q.id] = el.value; });
      return field(String(q.label || ''), el, { required: !!q.required });
    }

    function renderDetails() {
      var sum = h('div', { class: 'sum' }, [h('span', { text: slotLabel(st.slotMs) })]);
      var change = h('button', { type: 'button', class: 'link', text: 'Change' });
      change.addEventListener('click', function () { st.step = 'time'; st.err = ''; rerender(); });
      sum.appendChild(change);
      root.appendChild(sum);

      var form = h('form', { class: 'view', novalidate: true });
      var name = h('input', { type: 'text', autocomplete: 'name', maxlength: '80' });
      var phone = h('input', { type: 'tel', autocomplete: 'tel', maxlength: '40' });
      var email = h('input', { type: 'email', autocomplete: 'email', maxlength: '254' });
      [[name, 'name'], [phone, 'phone'], [email, 'email']].forEach(function (p) { p[0].value = st.val[p[1]]; p[0].addEventListener('input', function () { st.val[p[1]] = p[0].value; }); });
      form.appendChild(field('Your name', name, { required: true }));
      form.appendChild(field('Phone', phone, { required: false }));
      form.appendChild(field('Email', email, { hint: 'Phone or email is required so we can confirm.' }));
      (Array.isArray(data.intake_questions) ? data.intake_questions : []).forEach(function (q) { if (q && q.id) form.appendChild(intakeInput(q)); });
      if (o.collect_notes !== false) {
        var notes = h('textarea', { maxlength: '1000', rows: '2' });
        notes.value = st.val.notes;
        notes.addEventListener('input', function () { st.val.notes = notes.value; });
        form.appendChild(field('Anything we should know?', notes));
      }
      if (num(data.deposit_cents, 0) > 0) form.appendChild(notice('A ' + money(data.deposit_cents) + ' deposit applies.' + (data.deposit_policy ? ' ' + data.deposit_policy : '')));
      form.appendChild(honeypot());
      var err = h('div', { class: 'err', role: 'alert', text: st.err });
      var go = h('button', { type: 'submit', class: 'btn', text: 'Confirm booking' });
      form.appendChild(err);
      form.appendChild(go);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = st.val;
        err.textContent = '';
        if (v.name.trim().length < 2) { err.textContent = 'Please enter your name.'; name.focus(); return; }
        if (!v.phone.trim() && !v.email.trim()) { err.textContent = 'Please add a phone number or email.'; phone.focus(); return; }
        if (v.email.trim() && !emailOk(v.email.trim())) { err.textContent = 'That email address looks invalid.'; email.focus(); return; }
        if (v.phone.trim() && !phoneOk(v.phone)) { err.textContent = 'That phone number looks invalid.'; phone.focus(); return; }
        var missing = (data.intake_questions || []).some(function (q) { return q && q.required && !String(st.val.intake[q.id] || '').trim(); });
        if (missing) { err.textContent = 'Please answer the required questions.'; return; }
        go.disabled = true; go.textContent = 'Booking…';
        ctx.call('submit_website_widget_booking', {
          p_key: ctx.key, p_host: ctx.host, p_name: v.name.trim(), p_phone: v.phone.trim(), p_email: v.email.trim(), p_service: st.service || '',
          p_start: new Date(st.slotMs).toISOString(), p_notes: v.notes.trim(), p_intake: v.intake, p_page_url: ctx.page, p_website: hpValue(form)
        }).then(function (res) {
          st.dep = res && num(res.deposit_due_cents, 0);
          st.done = slotLabel(st.slotMs); st.step = 'done'; rerender();
        }, function (ex) {
          if (/slot_taken|too_soon/.test(String(ex && ex.message))) {
            st.err = errText(ex);
            ctx.refresh().then(function (np) { if (np && np.data && !np.data.unavailable) data = np.data; }, function () { /* keep old data */ }).then(function () { st.slotMs = null; st.step = 'time'; recompute(); rerender(); });
            return;
          }
          err.textContent = errText(ex); go.disabled = false; go.textContent = 'Confirm booking';
        });
      });
      root.appendChild(form);
    }

    function renderDone() {
      var lines = [st.done, data.confirmation_message || '', st.dep > 0 ? 'Deposit due: ' + money(st.dep) + '.' : ''];
      var onDone = ctx.close ? function () { ctx.close(); } : function () { st.step = 'time'; st.slotMs = null; st.val = { name: '', phone: '', email: '', notes: '', intake: {} }; rerender(); };
      root.appendChild(successView(str(s.success_message, DEFAULTS.booking.success), lines, onDone, ctx.close ? 'Close' : 'Book another time'));
    }

    function rerender() {
      clear(root);
      if (st.step === 'time' && st.err) root.appendChild(h('div', { class: 'err', role: 'alert', text: st.err }));
      if (st.step === 'time') renderTime(); else if (st.step === 'details') renderDetails(); else renderDone();
    }
    recompute();
    rerender();
    return { el: root };
  }

  /* ---------------------------------- quote ---------------------------------- */
  function quoteView(ctx, payload) {
    var s = payload.settings, data = payload.data || {}, o = s.options || {};
    var services = Array.isArray(data.services) ? data.services : [];
    var need = o.contact_required === 'email' || o.contact_required === 'phone' ? o.contact_required : 'either';
    var root = h('div', { class: 'view' });
    var val = { name: '', phone: '', email: '', service: '', zip: '', message: '' };

    function renderForm() {
      clear(root);
      var form = h('form', { class: 'view', novalidate: true });
      var name = h('input', { type: 'text', autocomplete: 'name', maxlength: '80' });
      var phone = h('input', { type: 'tel', autocomplete: 'tel', maxlength: '40' });
      var email = h('input', { type: 'email', autocomplete: 'email', maxlength: '254' });
      var bind = function (el, k) { el.value = val[k]; el.addEventListener('input', function () { val[k] = el.value; }); el.addEventListener('change', function () { val[k] = el.value; }); };
      bind(name, 'name'); bind(phone, 'phone'); bind(email, 'email');
      form.appendChild(field('Your name', name, { required: true }));
      form.appendChild(field('Phone', phone, { required: need === 'phone', hint: need === 'either' ? 'Phone or email is required.' : null }));
      form.appendChild(field('Email', email, { required: need === 'email' }));
      var svc;
      if (services.length) {
        svc = h('select', null, [h('option', { value: '', text: 'Select a service…' })].concat(services.map(function (x) { return h('option', { value: x, text: x }); })));
      } else svc = h('input', { type: 'text', maxlength: '80', placeholder: 'e.g. AC repair' });
      bind(svc, 'service');
      form.appendChild(field(services.length ? 'Service' : 'What do you need help with?', svc));
      if (o.ask_zip) { var zip = h('input', { type: 'text', autocomplete: 'postal-code', maxlength: '12', inputmode: 'text' }); bind(zip, 'zip'); form.appendChild(field('ZIP / postal code', zip)); }
      var msg = h('textarea', { maxlength: '2000', rows: '3' });
      bind(msg, 'message');
      form.appendChild(field('Tell us about the job', msg, { required: !!o.message_required }));
      form.appendChild(honeypot());
      var err = h('div', { class: 'err', role: 'alert' });
      var go = h('button', { type: 'submit', class: 'btn', text: 'Send request' });
      form.appendChild(err); form.appendChild(go);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        err.textContent = '';
        var em = val.email.trim(), ph = val.phone.trim();
        if (val.name.trim().length < 2) { err.textContent = 'Please enter your name.'; name.focus(); return; }
        if (need === 'email' && !em) { err.textContent = 'Please enter your email.'; email.focus(); return; }
        if (need === 'phone' && !ph) { err.textContent = 'Please enter your phone number.'; phone.focus(); return; }
        if (need === 'either' && !em && !ph) { err.textContent = 'Please add a phone number or email.'; phone.focus(); return; }
        if (em && !emailOk(em)) { err.textContent = 'That email address looks invalid.'; email.focus(); return; }
        if (ph && !phoneOk(ph)) { err.textContent = 'That phone number looks invalid.'; phone.focus(); return; }
        if (o.message_required && !val.message.trim()) { err.textContent = 'Please tell us a bit about the job.'; msg.focus(); return; }
        go.disabled = true; go.textContent = 'Sending…';
        ctx.call('submit_website_widget_quote', {
          p_key: ctx.key, p_host: ctx.host, p_name: val.name.trim(), p_email: em, p_phone: ph, p_service: val.service.trim(),
          p_message: val.message.trim(), p_zip: val.zip.trim(), p_page_url: ctx.page, p_website: hpValue(form)
        }).then(function () {
          clear(root);
          root.appendChild(successView(str(s.success_message, DEFAULTS.quote.success), [], ctx.close ? function () { ctx.close(); } : function () { val = { name: '', phone: '', email: '', service: '', zip: '', message: '' }; renderForm(); }, ctx.close ? 'Close' : 'Send another request'));
        }, function (ex) { err.textContent = errText(ex); go.disabled = false; go.textContent = 'Send request'; });
      });
      root.appendChild(form);
    }
    renderForm();
    return { el: root };
  }

  /* --------------------------------- reviews --------------------------------- */
  function starsEl(avg, size) {
    var wrap = h('span', { class: 'stars', 'aria-hidden': 'true' });
    for (var i = 0; i < 5; i++) {
      var fill = Math.min(1, Math.max(0, Math.round((avg - i) * 10) / 10));
      var gid = uid('g');
      var svg = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24"><defs><linearGradient id="' + gid + '"><stop offset="' + (fill * 100) + '%" stop-color="currentColor"/><stop offset="' + (fill * 100) + '%" stop-color="currentColor" stop-opacity="0.22"/></linearGradient></defs><path fill="url(#' + gid + ')" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z"/></svg>';
      wrap.appendChild(h('span', { class: 'sw', html: svg }));
    }
    return wrap;
  }
  function avgText(avg) { return (Math.floor(avg * 10) / 10).toFixed(1); } // floor, never overstate (4.96 -> 4.9)
  function badgeEl(ctx, data, s, withCta) {
    var avg = num(data.average, 0), count = num(data.count, 0);
    var label = 'Rated ' + avgText(avg) + ' out of 5 from ' + count + (count === 1 ? ' review' : ' reviews');
    var b = h('span', { class: 'badge', role: 'group', 'aria-label': label }, [
      starsEl(avg, 18), h('span', { class: 'num', text: avgText(avg), 'aria-hidden': 'true' }), h('span', { class: 'cnt', text: '(' + count + (count === 1 ? ' review' : ' reviews') + ')', 'aria-hidden': 'true' })
    ]);
    if (withCta && data.cta_url && /^https:\/\//i.test(data.cta_url)) {
      var a = h('a', { class: 'cta', href: data.cta_url, target: '_blank', rel: 'noopener noreferrer', text: str(s.button_label, DEFAULTS.reviews.button) });
      a.addEventListener('click', function () { ctx.track('convert'); });
      b.appendChild(a);
    }
    return b;
  }
  function cardsEl(data) {
    var list = Array.isArray(data.cards) ? data.cards : [];
    if (!list.length) return null;
    var grid = h('div', { class: 'cards' });
    var PL = { google: 'Google', yelp: 'Yelp', facebook: 'Facebook' };
    list.forEach(function (c) {
      var when = '';
      try { when = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(c.date)); } catch (e) { /* ignore */ }
      grid.appendChild(h('article', { class: 'rc' }, [
        h('span', { role: 'img', 'aria-label': num(c.rating, 5) + ' out of 5 stars' }, [starsEl(num(c.rating, 5), 14)]),
        h('p', { text: '“' + String(c.text || '') + '”' }),
        h('footer', { text: [String(c.author || 'Customer'), PL[c.platform] || '', when].filter(Boolean).join(' · ') })
      ]));
    });
    return grid;
  }
  function reviewsView(ctx, payload, floating) {
    var s = payload.settings, data = payload.data || {}, o = s.options || {};
    var root = h('div', { class: 'rv' });
    if (!data.show) { if (ctx.preview) root.appendChild(notice('Hidden on your site until you have enough reviews.')); return { el: root }; }
    var cards = o.layout === 'cards' ? cardsEl(data) : null;
    if (!floating && cards && str(s.title, '')) root.appendChild(h('div', { class: 'rvhd' }, [h('b', { text: s.title })]));
    root.appendChild(badgeEl(ctx, data, s, true));
    if (cards) root.appendChild(cards);
    return { el: root, hasCards: !!cards };
  }

  /* ---------------------------------- shell ---------------------------------- */
  function render(container, payload, opts) {
    opts = opts || {};
    var s = (payload && payload.settings) || {};
    var type = payload && payload.type;
    if (!DEFAULTS[type]) return { destroy: function () {} };
    var ctx = opts.ctx;
    var floating = s.display_mode !== 'inline';
    var contained = !!opts.contained;
    var host = document.createElement('div');
    host.setAttribute('data-vireek-widget-root', type);
    var root = host.attachShadow({ mode: 'open' });
    addStyles(root, buildCss(s, contained));

    var wrap = h('div', { class: 'w' + (floating ? ' float ' + (s.position === 'left' ? 'left' : 'right') : '') });
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var dark = false;
    function recolor() {
      dark = s.theme === 'dark' ? true : s.theme === 'light' ? false : pageIsDark(host.isConnected ? host.parentElement : container);
      applyTheme(wrap, s, dark);
    }

    var panel = null, launcher = null, openedOnce = false;
    function setOpen(v) {
      if (!panel) return;
      panel.classList.toggle('open', v);
      if (launcher) {
        launcher.setAttribute('aria-expanded', String(v));
        launcher.style.display = v && !contained && window.innerWidth <= 480 ? 'none' : '';
      }
      if (v) {
        if (!openedOnce) { openedOnce = true; ctx.track('open'); }
        var f = panel.querySelector('button.slot, input, select, textarea, a');
        if (f) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 60);
      } else if (launcher) launcher.focus();
    }
    ctx.close = floating ? function () { setOpen(false); } : null;

    var view, title = str(s.title, DEFAULTS[type].title);
    if (type === 'booking') view = bookingView(ctx, payload);
    else if (type === 'quote') view = quoteView(ctx, payload);
    else view = reviewsView(ctx, payload, floating);

    if (floating) {
      if (type === 'reviews') {
        if (!view.hasCards) {
          wrap.appendChild(h('div', { class: 'pill' }, [view.el]));
        } else {
          panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': title }, [
            h('div', { class: 'hd' }, [h('div', null, [h('b', { text: title })])]),
            h('div', { class: 'pbody' }, [view.el])
          ]);
          var x0 = h('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '×' });
          x0.addEventListener('click', function () { setOpen(false); });
          panel.firstChild.appendChild(x0);
          var pillBtn = h('button', { type: 'button', class: 'pill', 'aria-expanded': 'false', 'aria-label': 'Show customer reviews' });
          pillBtn.appendChild(badgeEl(ctx, payload.data, s, false));
          launcher = pillBtn;
          wrap.appendChild(panel); wrap.appendChild(pillBtn);
          pillBtn.addEventListener('click', function () { setOpen(!panel.classList.contains('open')); });
        }
      } else {
        var sub = str(s.subtitle, DEFAULTS[type].subtitle);
        var x = h('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '×' });
        x.addEventListener('click', function () { setOpen(false); });
        panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': title }, [
          h('div', { class: 'hd' }, [h('div', null, [h('b', { text: title }), sub ? h('small', { text: sub }) : null]), x]),
          h('div', { class: 'pbody' }, [view.el])
        ]);
        launcher = h('button', { type: 'button', class: 'launch', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, [h('span', { html: type === 'booking' ? ICONS.cal : ICONS.quote }), h('span', { text: str(s.button_label, DEFAULTS[type].button) })]);
        launcher.addEventListener('click', function () { setOpen(!panel.classList.contains('open')); });
        wrap.appendChild(panel); wrap.appendChild(launcher);
      }
      host.style.cssText = 'all:initial;position:' + (contained ? 'absolute' : 'fixed') + ';z-index:2147483000;bottom:0;' + (s.position === 'left' ? 'left' : 'right') + ':0';
    } else {
      if (type === 'reviews') {
        wrap.appendChild(view.el);
      } else {
        var sub2 = str(s.subtitle, DEFAULTS[type].subtitle);
        wrap.appendChild(h('div', { class: 'card' }, [h('div', { class: 'ihd' }, [h('b', { text: title }), sub2 ? h('small', { text: sub2 }) : null]), view.el]));
        var first = false;
        wrap.addEventListener('focusin', function () { if (!first) { first = true; ctx.track('open'); } });
        wrap.addEventListener('pointerdown', function () { if (!first) { first = true; ctx.track('open'); } });
      }
      host.style.cssText = 'all:initial;display:block';
    }

    // Escape closes the panel whether focus is inside it or still on the launcher.
    if (panel) wrap.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false); });
    root.appendChild(wrap);
    container.appendChild(host);
    recolor();
    var onMq = function () { if (s.theme === 'auto') recolor(); };
    if (mq && mq.addEventListener) mq.addEventListener('change', onMq);

    // Impression: floating -> now; inline -> when at least 40% visible (falls back to now).
    if (floating || typeof IntersectionObserver !== 'function') ctx.track('view');
    else {
      var io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) { ctx.track('view'); io.disconnect(); } }, { threshold: 0.4 });
      io.observe(host);
    }
    if (opts.startOpen && panel) setOpen(true);

    return {
      destroy: function () {
        if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
        if (host.parentNode) host.parentNode.removeChild(host);
      }
    };
  }

  /* ------------------------------- bootstrapping ------------------------------- */
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }
  function trackFactory(rpc, key, host, preview) {
    var sent = {};
    return function (evt) {
      if (preview) return;
      if (evt === 'view') {
        var sk = 'vww_v_' + key;
        try { if (sessionStorage.getItem(sk)) return; sessionStorage.setItem(sk, '1'); } catch (e) { /* storage blocked: still send once per page */ if (sent.view) return; }
      }
      if (evt !== 'convert') { if (sent[evt]) return; sent[evt] = true; }
      rpc('track_website_widget_event', { p_key: key, p_host: host, p_event: evt }, true).catch(function () { /* analytics must never break the page */ });
    };
  }

  function init(tag) {
    var key = tag.getAttribute('data-key');
    var api = (tag.getAttribute('data-api') || '').replace(/\/$/, '');
    var anon = tag.getAttribute('data-anon') || '';
    if (!key || !api || !anon) return;
    NS.mounted = NS.mounted || {};
    if (NS.mounted[key]) return;
    NS.mounted[key] = true;
    var rpc = makeRpc(api, anon);
    var host = location.hostname;
    var load = function () { return rpc('get_public_website_widget', { p_key: key, p_host: host }); };

    load().then(function (payload) {
      if (!payload || !payload.type || !payload.settings) return;
      var type = payload.type, floating = payload.settings.display_mode !== 'inline';
      if (type === 'booking' && payload.data && payload.data.unavailable) return;
      if (type === 'reviews' && payload.data && !payload.data.show) return;
      whenReady(function () {
        var container = document.body;
        if (!floating) {
          container = document.querySelector('[data-vireek-widget="' + key + '"]');
          if (!container) { if (window.console) console.warn('[Vireek] Add <div data-vireek-widget="' + key + '"></div> where the widget should appear.'); return; }
        }
        var ctx = {
          key: key, host: host, page: location.href, preview: false,
          call: function (fn, body) { return rpc(fn, body); },
          refresh: function () { return load(); },
          track: trackFactory(rpc, key, host, false)
        };
        render(container, payload, { ctx: ctx });
      });
    }, function () { /* a widget must never break the host page */ });
  }

  /**
   * Dashboard live preview: renders the REAL widget from a draft (settings + data) with all network calls stubbed.
   * container must be position:relative with a fixed height when opts.contained is true.
   */
  function preview(container, payload, opts) {
    opts = opts || {};
    var ctx = {
      key: 'preview', host: 'preview', page: 'https://example.com/', preview: true,
      call: function (fn) {
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(fn === 'submit_website_widget_booking' ? { deposit_due_cents: num(payload.data && payload.data.deposit_cents, 0) } : true); }, 500);
        });
      },
      refresh: function () { return Promise.resolve(null); },
      track: function () {}
    };
    clear(container);
    return render(container, payload, { ctx: ctx, contained: opts.contained !== false, startOpen: opts.startOpen !== false });
  }

  NS.api = { init: init, preview: preview, _slots: computeSlots, _zonedToUtc: zonedToUtc, version: 1 };
  if (currentTag) init(currentTag);
})();
