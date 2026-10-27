// Content script: adds an unobtrusive call button next to phone numbers and answers the popup's
// "what is on this page" question. Never sees tokens; talks to the service worker only.
(async () => {
  if (window.top !== window || window.__vireekExtension) return;
  window.__vireekExtension = true;

  const { findPhones, phoneFromTelHref, findEmails, formatPhone } = await import(
    chrome.runtime.getURL('lib/phone.js')
  );
  const t = (k, s) => chrome.i18n.getMessage(k, s) || k;
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'CODE',
    'PRE',
    'SVG',
    'CANVAS',
    'IFRAME',
  ]);
  const MAX_BUTTONS = 60;
  let settings = { inlineButtons: true, blockedHosts: [] };
  try {
    settings = {
      ...settings,
      ...((await chrome.storage.local.get('vk_settings')).vk_settings ?? {}),
    };
  } catch {
    /* keep defaults */
  }

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) =>
          resolve(chrome.runtime.lastError ? { ok: false, code: 'worker' } : r),
        );
      } catch {
        resolve({ ok: false, code: 'worker' });
      }
    });

  // ---- page context for the popup
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'vk:context') return false;
    const text = (document.body?.innerText ?? '').slice(0, 20000);
    const tel = [...document.querySelectorAll('a[href^="tel:" i]')]
      .map((a) => phoneFromTelHref(a.getAttribute('href')))
      .filter(Boolean);
    const mail = [...document.querySelectorAll('a[href^="mailto:" i]')]
      .map((a) => a.getAttribute('href').slice(7).split('?')[0])
      .filter(Boolean);
    respond({
      title: document.title.slice(0, 200),
      url: location.href,
      selection: String(getSelection() ?? '').slice(0, 500),
      phones: [...new Set([...tel, ...findPhones(text, 8).map((p) => p.e164)])].slice(0, 6),
      emails: [...new Set([...mail, ...findEmails(text, 5)])].slice(0, 5),
    });
    return false;
  });

  if (!settings.inlineButtons || settings.blockedHosts.includes(location.hostname)) return;

  // ---- inline buttons
  const CSS = `:host{all:initial}button{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin:0 3px;border-radius:9px;background:#203ad8;color:#fff;cursor:pointer;vertical-align:middle;opacity:.78;font:600 10px/1 system-ui}button:hover,button:focus-visible{opacity:1;outline:2px solid #6c82ff;outline-offset:1px}svg{width:10px;height:10px;fill:currentColor}`;
  const ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';
  let count = 0;
  const seen = new WeakSet();

  // NB: customElements is unavailable in a content script's isolated world: use plain spans.
  const makeHost = () => {
    const h = document.createElement('span');
    h.dataset.vireek = '1';
    return h;
  };

  function makeButton(e164) {
    const host = makeHost();
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><button type="button" aria-label="${t('btnTitle')}" title="${t('btnTitle')}">${ICON}</button>`;
    root.querySelector('button').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openCard(host, e164);
    });
    return host;
  }

  function decorateText(node) {
    const text = node.nodeValue;
    const hits = findPhones(text, 3);
    let cur = node;
    let offset = 0;
    for (const h of hits) {
      if (count >= MAX_BUTTONS) return;
      const tail = cur.splitText(h.end - offset);
      cur.parentNode.insertBefore(makeButton(h.e164), tail);
      count++;
      cur = tail;
      offset = h.end;
      seen.add(tail);
    }
  }

  function decorate(root) {
    if (count >= MAX_BUTTONS || !root) return;
    if (root.nodeType === 1) {
      if (
        SKIP.has(root.tagName.toUpperCase()) ||
        root.isContentEditable ||
        root.closest?.('[contenteditable="true"],[data-vireek]')
      )
        return;
      for (const a of root.matches('a[href^="tel:" i]')
        ? [root]
        : root.querySelectorAll('a[href^="tel:" i]')) {
        if (seen.has(a) || count >= MAX_BUTTONS) continue;
        seen.add(a);
        const p = phoneFromTelHref(a.getAttribute('href'));
        if (p) {
          a.after(makeButton(p));
          count++;
        }
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const el = n.parentElement;
        if (
          !el ||
          seen.has(n) ||
          SKIP.has(el.tagName.toUpperCase()) ||
          el.isContentEditable ||
          el.closest('a[href^="tel:" i],[data-vireek]')
        )
          return NodeFilter.FILTER_REJECT;
        return n.nodeValue.length >= 7 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode() && nodes.length < 400) nodes.push(walker.currentNode);
    for (const n of nodes) {
      seen.add(n);
      decorateText(n);
    }
  }

  // ---- confirm card (shadow DOM, one instance)
  let cardHost = null;
  function closeCard() {
    cardHost?.remove();
    cardHost = null;
  }
  function openCard(anchor, e164) {
    closeCard();
    cardHost = makeHost();
    const root = cardHost.attachShadow({ mode: 'closed' });
    const r = anchor.getBoundingClientRect();
    const top = Math.min(Math.max(8, r.bottom + 6), window.innerHeight - 150);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 270);
    root.innerHTML = `<style>
      :host{all:initial}.c{position:fixed;z-index:2147483647;top:${top}px;left:${left}px;width:256px;box-sizing:border-box;padding:12px;border-radius:12px;background:#fdfcfa;color:#17171a;border:1px solid #e7e5e0;box-shadow:0 12px 32px rgba(0,0,0,.18);font:13px/1.4 system-ui,sans-serif}
      @media (prefers-color-scheme:dark){.c{background:#101115;color:#f2f1ee;border-color:#24252c}}
      b{display:block;font-size:15px;margin-bottom:8px}.r{display:flex;gap:6px}
      button{all:initial;box-sizing:border-box;flex:1;text-align:center;padding:7px 6px;border-radius:8px;cursor:pointer;font:600 12px system-ui;border:1px solid #e7e5e0;color:inherit}
      button.p{background:#203ad8;border-color:#203ad8;color:#fff}button:focus-visible{outline:2px solid #6c82ff}button[disabled]{opacity:.5;cursor:default}
      .s{margin-top:8px;min-height:18px;font-size:12px}.e{color:#c83030}.k{color:#168458}
    </style><div class="c" role="dialog" aria-label="Vireek"><b dir="ltr"></b>
      <div class="r"><button class="p" data-a="call"></button><button data-a="lead"></button><button data-a="x"></button></div><div class="s" role="status"></div></div>`;
    root.querySelector('b').textContent = formatPhone(e164);
    const [callB, leadB, xB] = root.querySelectorAll('button');
    callB.textContent = t('cardCall');
    leadB.textContent = t('cardSaveLead');
    xB.textContent = t('cardCancel');
    const status = root.querySelector('.s');
    const say = (msg, cls = '') => {
      status.textContent = msg;
      status.className = `s ${cls}`;
    };
    const run = async (action, body, okMsg) => {
      callB.disabled = leadB.disabled = true;
      say('…');
      const res = await send({
        type: 'api',
        action,
        body: { ...body, page_url: location.href, page_title: document.title },
      });
      callB.disabled = leadB.disabled = false;
      if (res?.ok) {
        say(typeof okMsg === 'function' ? okMsg(res.data) : okMsg, 'k');
        return;
      }
      say(
        res?.code === 'signed_out' || res?.code === 'not_configured'
          ? t('cardNeedSignIn')
          : chrome.i18n.getMessage(`err_${res?.data?.code ?? res?.code}`) || t('errGeneric'),
        'e',
      );
    };
    callB.addEventListener('click', () =>
      run('click_to_call', { to: e164 }, () => t('ringingYou')),
    );
    leadB.addEventListener('click', () =>
      run('capture_lead', { phone: e164 }, (d) =>
        d.duplicate ? t('leadDuplicate') : t('leadSaved'),
      ),
    );
    xB.addEventListener('click', closeCard);
    document.documentElement.appendChild(cardHost);
    callB.focus();
  }
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') closeCard();
    },
    true,
  );
  document.addEventListener(
    'mousedown',
    (e) => {
      if (cardHost && !e.composedPath().includes(cardHost)) closeCard();
    },
    true,
  );

  // ---- initial scan + incremental updates (batched, idle)
  const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 50));
  idle(() => decorate(document.body));
  let queue = new Set();
  let timer = 0;
  new MutationObserver((muts) => {
    if (count >= MAX_BUTTONS) return;
    for (const m of muts)
      for (const n of m.addedNodes)
        if ((n.nodeType === 1 && !n.dataset?.vireek) || n.nodeType === 3)
          queue.add(n.nodeType === 3 ? n.parentNode : n);
    if (!timer && queue.size) {
      timer = setTimeout(() => {
        const batch = [...queue].slice(0, 40);
        queue = new Set();
        timer = 0;
        idle(() => batch.forEach((n) => n.isConnected && decorate(n)));
      }, 600);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
