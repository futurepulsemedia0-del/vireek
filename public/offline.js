// Companion script for /offline.html (external because the site CSP forbids inline scripts).
// Detects the connection coming back and reloads the page the user originally asked for.
(function () {
  'use strict';
  var PROBE_EVERY_MS = 10000;
  var PROBE_TIMEOUT_MS = 4000;
  var retryButton = document.getElementById('retry');
  var statusEl = document.getElementById('status');
  var checking = false;
  var reloading = false;

  function setStatus(text, tone) {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone);
    else statusEl.removeAttribute('data-tone');
  }

  // navigator.onLine only says "a network interface exists" — confirm with a real request.
  function probe() {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, PROBE_TIMEOUT_MS);
    return fetch('/favicon.svg?probe=' + Date.now(), { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (res) { return res.ok; })
      .catch(function () { return false; })
      .then(function (ok) { clearTimeout(timer); return ok; });
  }

  function reconnected() {
    if (reloading) return;
    reloading = true;
    setStatus('Back online — reloading…', 'ok');
    window.location.reload();
  }

  function check(manual) {
    if (checking || reloading) return;
    checking = true;
    if (manual && retryButton) retryButton.disabled = true;
    if (manual) setStatus('Checking your connection…');
    probe().then(function (ok) {
      checking = false;
      if (retryButton) retryButton.disabled = false;
      if (ok) reconnected();
      else if (manual) setStatus('Still offline. We’ll keep trying automatically.', 'warn');
    });
  }

  if (retryButton) retryButton.addEventListener('click', function () { check(true); });
  window.addEventListener('online', function () { check(false); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(false); });
  setInterval(function () { if (document.visibilityState === 'visible') check(false); }, PROBE_EVERY_MS);
})();
