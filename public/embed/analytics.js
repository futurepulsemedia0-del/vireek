/* Vireek embedded analytics. Static, no inline script (strict CSP), no third-party requests.
 * URL: /embed/analytics.html#token=<signed token>[&currency=EUR]
 * The token lives in the URL fragment, so it is never sent to any server except as the
 * Authorization header of the API call below. */
(function () {
  'use strict';

  var API = (document.querySelector('meta[name="vireek-api"]') || {}).content || '';
  var app = document.getElementById('app');
  var hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  var token = hash.get('token') || '';
  var currency = /^[A-Za-z]{3}$/.test(hash.get('currency') || '') ? hash.get('currency').toUpperCase() : 'USD';

  var meta = null;
  var state = { days: 30, groupBy: '', selected: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function show(message, isError) {
    clear(app);
    app.appendChild(el('div', 'state' + (isError ? ' error' : ''), message));
  }

  function format(unit, v) {
    if (v === null || v === undefined) return '—';
    try {
      if (unit === 'currency') return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
    } catch (e) { return v.toFixed(2); }
    if (unit === 'percent') return v.toFixed(1) + '%';
    if (unit === 'minutes') return v >= 120 ? (v / 60).toFixed(1) + ' h' : v.toFixed(v < 10 ? 1 : 0) + ' min';
    return new Intl.NumberFormat('en-US').format(v);
  }

  function call(path, body) {
    var opts = { headers: { Authorization: 'Bearer ' + token }, referrerPolicy: 'no-referrer' };
    if (body) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(API + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong.');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    var mode = theme && theme.mode === 'dark' ? 'dark' : theme && theme.mode === 'light' ? 'light' : (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.setAttribute('data-theme', mode);
    if (theme && /^#[0-9a-fA-F]{6}$/.test(theme.accent)) root.style.setProperty('--accent', theme.accent);
  }

  function deltaNode(r) {
    var d = r.delta;
    if (!d || d.value === null || d.value === undefined) return el('div', 'delta flat', 'No comparison');
    var up = d.value > 0;
    var flat = Math.abs(d.value) < 0.05;
    var good = flat ? null : (up === (r.better === 'up'));
    var text = (up ? '▲ ' : '▼ ') + Math.abs(d.value).toFixed(1) + (d.kind === 'pts' ? ' pts' : '%') + ' vs previous period';
    return el('div', 'delta ' + (flat ? 'flat' : good ? 'good' : 'bad'), flat ? 'No change vs previous period' : text);
  }

  var NS = 'http://www.w3.org/2000/svg';
  function trend(points, unit, label) {
    var W = 700, H = 200, P = { l: 8, r: 8, t: 12, b: 22 };
    var vals = points.map(function (p) { return p.cell.value; }).filter(function (v) { return v !== null; });
    if (vals.length < 2) return el('div', 'state', 'Not enough data in this period to draw a trend.');
    var min = Math.min(0, Math.min.apply(null, vals));
    var max = Math.max.apply(null, vals) || 1;
    var x = function (i) { return P.l + (i / Math.max(points.length - 1, 1)) * (W - P.l - P.r); };
    var y = function (v) { return P.t + (1 - (v - min) / (max - min || 1)) * (H - P.t - P.b); };
    var d = '', pen = false, last = null, first = null;
    points.forEach(function (p, i) {
      if (p.cell.value === null) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.cell.value).toFixed(1) + ' ';
      if (first === null) first = i;
      last = i;
      pen = true;
    });
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label + ' over time');
    [0, 0.5, 1].forEach(function (t) {
      var gy = P.t + t * (H - P.t - P.b);
      var line = document.createElementNS(NS, 'line');
      line.setAttribute('class', 'grid-line');
      line.setAttribute('x1', P.l); line.setAttribute('x2', W - P.r); line.setAttribute('y1', gy); line.setAttribute('y2', gy);
      svg.appendChild(line);
    });
    var area = document.createElementNS(NS, 'path');
    area.setAttribute('class', 'area');
    area.setAttribute('d', d + 'L' + x(last).toFixed(1) + ' ' + y(min).toFixed(1) + ' L' + x(first).toFixed(1) + ' ' + y(min).toFixed(1) + ' Z');
    if (d.indexOf('M') === d.lastIndexOf('M')) svg.appendChild(area);
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('class', 'line');
    path.setAttribute('d', d.trim());
    svg.appendChild(path);
    [[0, 'start'], [points.length - 1, 'end']].forEach(function (e) {
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'axis');
      t.setAttribute('x', e[1] === 'start' ? P.l : W - P.r);
      t.setAttribute('y', H - 6);
      t.setAttribute('text-anchor', e[1]);
      t.textContent = points[e[0]].bucket.slice(0, 10);
      svg.appendChild(t);
    });
    var title = document.createElementNS(NS, 'title');
    title.textContent = label + ': ' + format(unit, vals[vals.length - 1]) + ' latest';
    svg.appendChild(title);
    return svg;
  }

  function render(res, groups) {
    clear(app);
    var bar = el('div', 'bar');
    bar.appendChild(el('h1', '', meta.title || 'Analytics'));
    var controls = el('div', 'controls');

    var range = el('select');
    range.setAttribute('aria-label', 'Date range');
    var opts = [7, 30, 90, 180, 365].filter(function (d) { return d <= meta.max_range_days; });
    if (opts.indexOf(state.days) === -1) opts.push(state.days);
    opts.sort(function (a, b) { return a - b; }).forEach(function (d) {
      var o = el('option', '', 'Last ' + d + ' days'); o.value = d; if (d === state.days) o.selected = true; range.appendChild(o);
    });
    range.addEventListener('change', function () { state.days = Number(range.value); load(); });
    controls.appendChild(range);

    var sel = res.results.filter(function (r) { return r.id === state.selected; })[0] || res.results[0];
    var dims = (meta.allowed_group_by || []).filter(function () { return true; });
    if (dims.length) {
      var gb = el('select');
      gb.setAttribute('aria-label', 'Break down by');
      var none = el('option', '', 'No breakdown'); none.value = ''; gb.appendChild(none);
      var names = { service_type: 'Service type', technician: 'Technician', customer_type: 'Customer type' };
      dims.forEach(function (dm) { var o = el('option', '', names[dm] || dm); o.value = dm; if (dm === state.groupBy) o.selected = true; gb.appendChild(o); });
      gb.addEventListener('change', function () { state.groupBy = gb.value; load(); });
      controls.appendChild(gb);
    }
    bar.appendChild(controls);
    app.appendChild(bar);

    var grid = el('div', 'grid');
    res.results.forEach(function (r) {
      var card = el('div', 'card' + (r.id === sel.id ? ' sel' : ''));
      var btn = el('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', r.id === sel.id ? 'true' : 'false');
      btn.appendChild(el('div', 'label', r.label));
      btn.appendChild(el('div', 'value', format(r.unit, r.total.value)));
      btn.appendChild(deltaNode(r));
      btn.addEventListener('click', function () { state.selected = r.id; load(); });
      card.appendChild(btn);
      grid.appendChild(card);
    });
    app.appendChild(grid);

    var panel = el('section', 'panel card');
    panel.appendChild(el('h2', '', sel.label));
    var info = (meta.metrics.filter(function (m) { return m.id === sel.id; })[0] || {}).description;
    if (info) panel.appendChild(el('p', '', info));
    panel.appendChild(sel.series && sel.series.length ? trend(sel.series, sel.unit, sel.label) : el('div', 'state', 'No trend for this view.'));
    app.appendChild(panel);

    if (groups && groups.length) {
      var gp = el('section', 'panel card');
      gp.appendChild(el('h2', '', sel.label + ' by ' + (state.groupBy || '').replace('_', ' ')));
      var table = el('table');
      var head = el('tr');
      head.appendChild(el('th', '', 'Group'));
      var th = el('th', 'num', sel.label); head.appendChild(th);
      table.appendChild(head);
      groups.forEach(function (g) {
        var tr = el('tr');
        tr.appendChild(el('td', '', g.key));
        tr.appendChild(el('td', 'num', format(sel.unit, g.cell.value)));
        table.appendChild(tr);
      });
      gp.appendChild(table);
      app.appendChild(gp);
    }
    app.appendChild(el('p', 'note', 'Updated ' + new Date(res.generated_at).toLocaleString() + (res.truncated ? ' · Very large accounts show the most recent data only.' : '') + ' · Powered by Vireek'));
  }

  function fail(err) {
    if (err && err.status === 401) return show('This analytics link is invalid or has expired. Reload the page that contains it.', true);
    if (err && err.status === 429) return show('Too many requests. Please try again in a minute.', true);
    show((err && err.message) || 'Something went wrong. Please try again.', true);
  }

  function load() {
    var to = new Date();
    var from = new Date(to.getTime() - state.days * 86400000);
    var base = { from: from.toISOString(), to: to.toISOString(), granularity: meta.granularity === 'none' ? 'day' : meta.granularity, compare: true };
    var main = call('', Object.assign({ action: 'data' }, base));
    main.then(function (res) {
      var current = state.selected || res.results[0].id;
      state.selected = current;
      if (!state.groupBy) return render(res, null);
      return call('', { action: 'data', from: base.from, to: base.to, metrics: [current], groupBy: state.groupBy, granularity: 'none' })
        .then(function (g) { render(res, g.results[0] && g.results[0].groups); })
        .catch(function () { render(res, null); });
    }).catch(fail);
  }

  if (!token || !API) return show('This analytics link is incomplete.', true);
  call('?action=meta').then(function (m) {
    meta = m;
    applyTheme(m.theme);
    state.days = m.default_range_days;
    document.title = m.title || 'Analytics';
    if (!m.metrics.length) return show('Nothing to show yet.', false);
    state.selected = m.metrics[0].id;
    load();
  }).catch(fail);
})();
