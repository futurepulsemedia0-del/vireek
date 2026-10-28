/*! Vireek call tracking — dynamic number insertion (DNI).
    Swaps the phone number shown on your site for a tracking number chosen by where the visitor came from.
    Dependency-free, ES5, never throws into the host page.
    Server logic lives in supabase/migrations/20280102093000_dynamic_number_insertion.sql. Keep the bot pattern,
    the token format and the signal names in sync with dni_get_assignment. */
(function () {
  'use strict';
  var NS = (window.__vireekDNI = window.__vireekDNI || {});
  if (NS.loaded) return;
  NS.loaded = true;

  var STORE_KEY = '_vdni';
  var SESSION_MS = 30 * 60 * 1000;
  var BOT_RE = /(bot|crawl|spider|slurp|headless|lighthouse|pagespeed|mediapartners|inspectiontool|facebookexternalhit|monitor|curl\/|wget\/|python-requests)/i;
  var CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, TEMPLATE: 1, IFRAME: 1, SVG: 1 };
  var SEP = '[\\s().\\u2010-\\u2015-]*';

  /* ------------------------------- pure helpers ------------------------------- */
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function isNanp(d) { return d.length === 11 && d.charAt(0) === '1'; }

  /** Regex (with a leading boundary group) that finds `e164` written in any common US/CA or international style. */
  function buildMatcher(e164) {
    var d = digits(e164);
    if (d.length < 7) return null;
    var body;
    if (isNanp(d)) {
      var a = d.slice(1, 4), b = d.slice(4, 7), c = d.slice(7);
      body = '(?:\\+?1' + SEP + ')?\\(?' + a + '\\)?' + SEP + b + SEP + c;
    } else {
      var parts = d.split('').map(esc);
      body = '(?:\\+|00)?' + parts.join(SEP);
    }
    return new RegExp('(^|[^\\d])(' + body + ')(?!\\d)', 'g');
  }

  /** Replace every occurrence of `fromE164` in `text` with `toE164`, keeping the original punctuation/spacing. */
  function swapText(text, fromE164, toE164) {
    var re = buildMatcher(fromE164);
    var to = digits(toE164);
    if (!re || !to || digits(fromE164) === to) return text;
    return String(text).replace(re, function (_all, pre, hit) {
      var n = digits(hit).length;
      var src = n === to.length ? to : (isNanp(to) && n === 10 ? to.slice(1) : null);
      if (!src) return pre + '+' + to; // different digit count (other country): fall back to international
      var i = 0;
      return pre + hit.replace(/\d/g, function () { return src.charAt(i++); });
    });
  }

  function hrefMatches(href, e164) {
    var m = /^tel:(.*)$/i.exec(href || '');
    if (!m) return false;
    var raw = m[1];
    try { raw = decodeURIComponent(raw); } catch (e) { /* keep raw */ }
    var d = digits(raw.split(/[;,]/)[0]), f = digits(e164);
    return d === f || (isNanp(f) && d === f.slice(1));
  }

  function swapHref(href, fromE164, toE164) {
    return hrefMatches(href, fromE164) ? 'tel:+' + digits(toE164) : href;
  }

  function isBot(ua, webdriver) { return !!webdriver || BOT_RE.test(ua || ''); }

  function readSignals(url, referrer) {
    var out = {};
    var q = '';
    var path = '/';
    try { var u = new URL(url); q = u.search; path = u.pathname; } catch (e) { /* ignore */ }
    var params = {};
    q.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      try {
        var k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' ')).toLowerCase();
        var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        if (!(k in params)) params[k] = v;
      } catch (e) { /* malformed escape: skip */ }
    });
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
      if (params[k]) out[k] = params[k].slice(0, 120);
    });
    for (var i = 0; i < CLICK_IDS.length; i++) {
      if (params[CLICK_IDS[i]]) { out.click_id_type = CLICK_IDS[i]; out.click_id = params[CLICK_IDS[i]].slice(0, 120); break; }
    }
    out.landing_path = path.slice(0, 200); // path only — the query string never leaves the browser
    if (referrer) out.referrer = String(referrer).split('#')[0].slice(0, 300);
    return out;
  }

  function hasCampaignSignal(sig) {
    return !!(sig.utm_source || sig.utm_medium || sig.utm_campaign || sig.click_id_type);
  }
  function signature(sig) {
    return [sig.utm_source, sig.utm_medium, sig.utm_campaign, sig.click_id_type].join('|');
  }

  function newToken() {
    var a = new Uint8Array(16);
    try { (window.crypto || window.msCrypto).getRandomValues(a); } catch (e) { for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256); }
    var s = '';
    for (var j = 0; j < a.length; j++) s += (a[j] < 16 ? '0' : '') + a[j].toString(16);
    return s;
  }

  /* --------------------------------- storage ---------------------------------- */
  var memory = null;
  function load() {
    try { var raw = window.localStorage.getItem(STORE_KEY); if (raw) return JSON.parse(raw); } catch (e) { /* blocked */ }
    return memory;
  }
  function save(v) {
    memory = v;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (e) { /* blocked: memory only */ }
  }
  function wipe() {
    memory = null;
    try { window.localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------ DOM replacement ------------------------------ */
  var state = { def: null, cur: null, texts: [], attrs: [], marked: [], observer: null, timer: null };

  function inIgnored(node) {
    for (var n = node; n && n.nodeType === 1 || (n && n.nodeType === 3); n = n.parentNode) {
      if (n.nodeType === 1 && (SKIP_TAGS[n.nodeName.toUpperCase()] || n.isContentEditable || n.hasAttribute('data-vireek-dni-ignore'))) return true;
    }
    return false;
  }

  function trackText(node) {
    for (var i = 0; i < state.texts.length; i++) if (state.texts[i].node === node) return state.texts[i];
    var rec = { node: node, orig: node.nodeValue };
    state.texts.push(rec);
    return rec;
  }

  function scan(root) {
    if (!state.def || !root) return;
    var re = buildMatcher(state.def);
    if (!re) return;
    // 1) tel: links
    var links = root.nodeType === 1 ? [].slice.call(root.querySelectorAll('a[href^="tel:"]')) : [];
    if (root.nodeType === 1 && root.matches && root.matches('a[href^="tel:"]')) links.unshift(root);
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (inIgnored(a)) continue;
      var orig = a.getAttribute('data-vireek-dni-href') || a.getAttribute('href');
      if (!hrefMatches(orig, state.def)) continue;
      if (!a.hasAttribute('data-vireek-dni-href')) a.setAttribute('data-vireek-dni-href', orig);
      if (state.attrs.indexOf(a) < 0) state.attrs.push(a);
    }
    // 2) text nodes
    var walker = document.createTreeWalker(root, 4, null, false);
    var node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || node.nodeValue.length < 7 || inIgnored(node)) continue;
      re.lastIndex = 0;
      if (re.test(node.nodeValue)) trackText(node);
    }
    // 3) explicit placeholders
    var marks = root.nodeType === 1 ? root.querySelectorAll('[data-vireek-number]') : [];
    for (var k = 0; k < marks.length; k++) if (state.marked.indexOf(marks[k]) < 0) state.marked.push(marks[k]);
  }

  function apply() {
    if (!state.def || !state.cur) return;
    var to = state.cur;
    if (state.observer) state.observer.disconnect();
    try {
      for (var i = 0; i < state.texts.length; i++) {
        var t = state.texts[i];
        if (t.node.parentNode) t.node.nodeValue = swapText(t.orig, state.def, to);
      }
      for (var j = 0; j < state.attrs.length; j++) {
        var a = state.attrs[j];
        var orig = a.getAttribute('data-vireek-dni-href');
        a.setAttribute('href', swapHref(orig, state.def, to));
      }
      for (var m = 0; m < state.marked.length; m++) {
        var el = state.marked[m];
        var sample = el.getAttribute('data-vireek-dni-orig');
        if (sample === null) { sample = el.textContent || ''; el.setAttribute('data-vireek-dni-orig', sample); }
        var d = digits(sample);
        el.textContent = d.length >= 7 ? swapText(sample, '+' + (d.length === 10 ? '1' + d : d), to) : formatDisplay(to);
        if (el.tagName === 'A') el.setAttribute('href', 'tel:+' + digits(to));
      }
    } finally {
      observe();
    }
  }

  function formatDisplay(e164) {
    var d = digits(e164);
    return isNanp(d) ? '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7) : '+' + d;
  }

  function observe() {
    if (!window.MutationObserver || !document.body) return;
    if (!state.observer) {
      state.observer = new MutationObserver(function (muts) {
        var added = [];
        for (var i = 0; i < muts.length; i++) for (var j = 0; j < muts[i].addedNodes.length; j++) added.push(muts[i].addedNodes[j]);
        if (!added.length || state.timer) return;
        state.timer = setTimeout(function () {
          state.timer = null;
          try {
            for (var k = 0; k < added.length; k++) {
              var n = added[k];
              if (n.nodeType === 1) scan(n);
              else if (n.nodeType === 3 && n.parentNode && !inIgnored(n)) { var r = buildMatcher(state.def); if (r && r.test(n.nodeValue)) trackText(n); }
            }
            if (state.cur && state.cur !== state.def) apply();
          } catch (e) { /* never break the page */ }
        }, 60);
      });
    }
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function show(def, cur) {
    if (!def || !cur) return;
    state.def = def;
    state.cur = cur;
    if (document.body) { scan(document.body); apply(); }
    try {
      var detail = { number: cur, defaultNumber: def, swapped: cur !== def };
      window.dispatchEvent(new CustomEvent('vireek:dni', { detail: detail }));
      if (window.dataLayer && window.dataLayer.push) window.dataLayer.push({ event: 'vireek_dni', vireek_number: cur, vireek_swapped: cur !== def });
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------- network ---------------------------------- */
  function makeRpc(api, anon) {
    return function (body) {
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 5000) : null;
      return fetch(api + '/rest/v1/rpc/dni_get_assignment', {
        method: 'POST',
        headers: { apikey: anon, Authorization: 'Bearer ' + anon, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }, function (e) { if (timer) clearTimeout(timer); throw e; });
    };
  }

  function start(tag) {
    var key = tag.getAttribute('data-key');
    var api = (tag.getAttribute('data-api') || '').replace(/\/$/, '');
    var anon = tag.getAttribute('data-anon') || '';
    var needConsent = tag.getAttribute('data-consent') === 'required';
    if (!key || !api || !anon) { if (window.console) console.warn('[Vireek] call tracking snippet is missing data-key / data-api / data-anon.'); return; }
    if (isBot(navigator.userAgent, navigator.webdriver)) return;

    var rpc = makeRpc(api, anon);
    var consented = !needConsent;
    var heartbeat = null;

    function session(sig, now) {
      var st = load();
      var sigText = signature(sig);
      var fresh = !st || !st.t || now - (st.a || 0) > SESSION_MS || (hasCampaignSignal(sig) && st.s !== sigText);
      if (fresh) st = { t: newToken(), s: hasCampaignSignal(sig) ? sigText : '', c: null };
      st.a = now;
      return { st: st, fresh: fresh };
    }

    function run() {
      if (!consented) return;
      var now = Date.now();
      var sig = readSignals(location.href, document.referrer);
      var s = session(sig, now);
      // Instant swap from the cached assignment (same visit) while the server confirms it.
      if (!s.fresh && s.st.c && s.st.c.exp > now) show(s.st.c.def, s.st.c.num);
      save(s.st);
      rpc({ p_key: key, p_host: location.hostname, p_token: s.st.t, p_signals: sig }).then(function (res) {
        if (!res || !res.ok || !res.default || !res.number) return;
        var cur = load() || s.st;
        cur.c = { def: res.default, num: res.number, exp: Date.now() + Math.max(60, res.lease_seconds || 1800) * 1000 };
        save(cur);
        show(res.default, res.number);
        var every = Math.max(60, Math.floor((res.lease_seconds || 1800) / 3)) * 1000;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(function () { if (document.visibilityState !== 'hidden') run(); }, every);
      }).catch(function () { /* the page keeps its normal number */ });
    }

    NS.grantConsent = function () { consented = true; run(); };
    NS.revoke = function () { consented = false; if (heartbeat) clearInterval(heartbeat); wipe(); };
    NS.refresh = run;
    NS.current = function () { return state.cur; };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }

  NS._api = { buildMatcher: buildMatcher, swapText: swapText, swapHref: swapHref, hrefMatches: hrefMatches, isBot: isBot, readSignals: readSignals, hasCampaignSignal: hasCampaignSignal, formatDisplay: formatDisplay, show: show, state: state, scan: scan, apply: apply };

  var tag = document.currentScript;
  if (tag && tag.getAttribute('data-key')) {
    try { start(tag); } catch (e) { if (window.console) console.warn('[Vireek] call tracking failed to start', e); }
  }
})();
