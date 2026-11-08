/* Applies saved accessibility settings before first paint (no flash). Keep in sync with src/lib/a11y/apply.ts (parity-tested).
   Color-blindness filter is applied by React after load (its SVG defs do not exist yet). */
(function () {
  // Single motion signal for CSS: html[data-motion=full|reduce|stop]. Keep in sync with src/lib/motionPolicy.ts.
  function motionAttr(stop, reduce) {
    var os = false;
    try { os = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
    document.documentElement.setAttribute('data-motion', stop ? 'stop' : (reduce || os) ? 'reduce' : 'full');
  }
  motionAttr(false, false);
  try {
    var raw = localStorage.getItem('vireek-a11y-settings');
    if (!raw) return;
    var s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return;
    var D = { textSize: 1, contentScale: 1, lineHeight: 1.6, letterSpacing: 0, wordSpacing: 0 };
    var R = { textSize: [0.875, 1.5], contentScale: [0.9, 1.2], lineHeight: [1.4, 2.2], letterSpacing: [0, 0.2], wordSpacing: [0, 0.3] };
    function num(k) {
      var v = s[k];
      if (typeof v !== 'number' || !isFinite(v)) return D[k];
      return Math.min(R[k][1], Math.max(R[k][0], v));
    }
    function on(k) { return s[k] === true; }
    function near(a, b) { return Math.abs(a - b) < 1e-6; }
    var ts = num('textSize'), cs = num('contentScale'), lh = num('lineHeight'), ls = num('letterSpacing'), ws = num('wordSpacing');
    var f = [];
    if (on('invertColors')) f.push('invert(1) hue-rotate(180deg)');
    if (on('grayscale')) f.push('grayscale(1)');
    if (on('monochrome')) f.push('grayscale(1) contrast(1.1)');
    if (on('highSaturation')) f.push('saturate(1.8)');
    if (on('lowSaturation')) f.push('saturate(0.5)');
    var root = document.documentElement, st = root.style, c = root.classList;
    st.setProperty('--a11y-font-scale', String(ts));
    st.setProperty('--a11y-content-scale', String(cs));
    st.setProperty('--a11y-line-height', String(lh));
    st.setProperty('--a11y-letter-spacing', ls + 'em');
    st.setProperty('--a11y-word-spacing', ws + 'em');
    st.setProperty('--a11y-filter', f.length ? f.join(' ') : 'none');
    var m = {
      'a11y-readable-font': on('readableFont'), 'a11y-dyslexia-font': on('dyslexiaFont'),
      'a11y-large-cursor': on('largeCursor'), 'a11y-highlight-links': on('highlightLinks'),
      'a11y-highlight-headings': on('highlightHeadings'),
      'a11y-strong-focus': on('strongFocus') || on('highlightKeyboardFocus'),
      'a11y-high-contrast': on('highContrast'), 'a11y-dark-contrast': on('darkContrast'),
      'a11y-light-contrast': on('lightContrast'), 'a11y-reading-mode': on('readingMode'),
      'a11y-reduce-motion': on('reduceMotion'), 'a11y-stop-animations': on('stopAnimations'),
      'a11y-hide-images': on('hideImages'), 'a11y-screen-reader': on('screenReaderMode'),
      'a11y-text-scaled': !near(ts, 1), 'a11y-zoomed': !near(cs, 1),
      'a11y-lh': !near(lh, 1.6), 'a11y-ls': ls > 0, 'a11y-ws': ws > 0
    };
for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) c.toggle(k, m[k]);
    motionAttr(on('stopAnimations'), on('reduceMotion'));
  } catch (e) { /* storage blocked or corrupt JSON: React applies defaults */ }
})();
