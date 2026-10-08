'use strict';

// ───────────────────────── helpers ─────────────────────────
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (id) => parseFloat($('#' + id).value) || 0;
const chk = (id) => $('#' + id).checked;
const fmt = (n) => +n.toFixed(2);
const trunc = (s, n = 26) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function log(msg) {
  const el = $('#log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

// ───────────────────────── Wikipedia API ─────────────────────────
const API = 'https://en.wikipedia.org/w/api.php';
const BATCH = 20;      // titles per request
const MAX_CONT = 3;    // continuation requests per batch (caps hub pages)
const state = { ignore: new Set(), fmt: {}, nudge: { nodes: {}, labels: {} }, sel: null, vias: new Set(), path: null, graph: null, cancel: false, running: false, token: 0 };
const cache = { f: new Map(), b: new Map() }; // title -> neighbour titles (f = outgoing links, b = incoming)

async function api(params) {
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  for (let i = 0; i < 5; i++) {
    if (state.cancel) throw new Error('cancelled');
    const r = await fetch(url, { headers: { 'Api-User-Agent': 'six-degrees-wikipedia-plotter (personal project)' } });
    if (r.status === 429 || r.status >= 500) {
      const wait = Math.min(60, parseInt(r.headers.get('retry-after')) || 2 * (i + 1));
      log(`Wikipedia asked us to slow down; waiting ${wait}s…`);
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  throw new Error('Wikipedia API is busy, try again shortly');
}

async function resolveTitle(t) {
  const j = await api({ action: 'query', titles: t, redirects: '1' });
  const p = j.query.pages[0];
  if (p.missing || p.invalid) throw new Error(`No Wikipedia article called “${t}”`);
  return p.title;
}

async function fetchNeighbors(titles, dir) {
  const store = cache[dir];
  const todo = titles.filter((t) => !store.has(t));
  const base = dir === 'f'
    ? { prop: 'links', pllimit: 'max', plnamespace: '0' }
    : { prop: 'linkshere', lhlimit: 'max', lhnamespace: '0', lhprop: 'title' };
  const field = dir === 'f' ? 'links' : 'linkshere';
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const acc = new Map(batch.map((t) => [t, []]));
    let cont = {};
    for (let page = 0; page < MAX_CONT; page++) {
      if (state.cancel) throw new Error('cancelled');
      const j = await api({ action: 'query', titles: batch.join('|'), ...base, ...cont });
      for (const p of j.query?.pages ?? []) {
        if (p[field] && acc.has(p.title)) acc.get(p.title).push(...p[field].map((x) => x.title));
      }
      if (!j.continue) break;
      cont = j.continue;
    }
    for (const [t, a] of acc) store.set(t, a);
  }
  return titles.map((t) => store.get(t) || []);
}

// ───────────────────────── ignore list ─────────────────────────
const ignoreCache = new Map();   // typed title -> canonical title (redirects resolved)
const normTitle = (s) => { s = s.trim().replace(/_/g, ' '); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
async function syncIgnore() {
  const typed = [...new Set($('#ignoreList').value.split('\n').map(normTitle).filter(Boolean))];
  const todo = typed.filter((t) => !ignoreCache.has(t));
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    try {
      const j = await api({ action: 'query', titles: batch.join('|'), redirects: '1' });
      const hop = new Map();
      for (const x of [...(j.query?.normalized ?? []), ...(j.query?.redirects ?? [])]) hop.set(x.from, x.to);
      for (const t of batch) {
        let c = t;
        for (let k = 0; k < 5 && hop.has(c); k++) c = hop.get(c);
        ignoreCache.set(t, c);
      }
    } catch { for (const t of batch) ignoreCache.set(t, t); }
  }
  state.ignore = new Set(typed.flatMap((t) => [t, ignoreCache.get(t)]));
  return state.ignore;
}

// ───────────────────────── search ─────────────────────────
async function findPath(a, b, { maxExp, cap }, onProgress) {
  const par = { f: new Map([[a, null]]), b: new Map([[b, null]]) };
  const front = { f: [a], b: [b] };
  const rng = mulberry32(12345);

  for (let step = 0; step < maxExp; step++) {
    const live = ['f', 'b'].filter((s) => front[s].length);
    if (!live.length) return null;
    const side = live.length === 1 ? live[0] : front.f.length <= front.b.length ? 'f' : 'b';
    const other = side === 'f' ? 'b' : 'f';
    let cur = front[side];
    if (cur.length > cap) cur = shuffle(cur, rng).slice(0, cap);

    await onProgress({ step, side, count: cur.length, par });
    const lists = await fetchNeighbors(cur, side);

    const next = [];
    let meet = null;
    cur.forEach((t, i) => {
      for (const n of lists[i]) {
        if (par[side].has(n) || state.ignore.has(n)) continue;
        par[side].set(n, t);
        next.push(n);
        if (!meet && par[other].has(n)) meet = n;
      }
    });
    front[side] = next;
    if (meet) {
      const left = [];
      for (let x = meet; x !== null; x = par.f.get(x)) left.unshift(x);
      const right = [];
      for (let x = par.b.get(meet); x !== null && x !== undefined; x = par.b.get(x)) right.push(x);
      return left.concat(right);
    }
  }
  return null;
}

// ───────────────────────── graph building ─────────────────────────
function pairKey(a, b) { return a < b ? a + '\u0000' + b : b + '\u0000' + a; }

async function buildGraph(path, seed) {
  const k1 = num('k1'), k1End = num('k1End'), k2 = num('k2');
  const nodes = new Map();
  const edges = [];
  const seen = new Set();
  const addEdge = (s, t, kind) => {
    const k = pairKey(s, t);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ s, t, kind });
  };
  path.forEach((t, i) => nodes.set(t, { id: t, kind: 'path', i, end: i === 0 || i === path.length - 1, via: state.vias.has(t) }));
  for (let i = 1; i < path.length; i++) addEdge(path[i - 1], path[i], 'path');

  const rng = mulberry32(seed * 101 + 7);
  const grow = async (parents, count, kind) => {
    if (!parents.length) return [];
    await fetchNeighbors(parents, 'f');
    const added = [];
    for (const p of parents) {
      const take = typeof count === 'function' ? count(p) : count;
      if (take <= 0) continue;
      const pool = (cache.f.get(p) || []).filter((n) => !nodes.has(n));
      // shuffle first, then drop ignored pages, so ignoring one page only swaps in the next candidate
      for (const c of shuffle(pool, rng).filter((n) => !state.ignore.has(n)).slice(0, take)) {
        if (nodes.has(c)) continue;
        nodes.set(c, { id: c, kind, parent: p });
        addEdge(p, c, kind);
        added.push(c);
      }
    }
    return added;
  };
  const level1 = await grow(path, (p) => (nodes.get(p).end ? k1End : k1), 'b1');
  await grow(level1, k2, 'b2');

  if (chk('cross')) {
    for (const [id] of nodes) {
      for (const n of cache.f.get(id) || []) if (nodes.has(n) && n !== id) addEdge(id, n, 'cross');
    }
  }
  return { nodes: [...nodes.values()], edges };
}

// prefix = finished path so far, ending at this leg's start a; b = this leg's target
function previewGraph(par, a, b, prefix = [a]) {
  const rng = mulberry32(99);
  const trail = [...prefix, b];
  const nodes = new Map(trail.map((t, i) => [t, { id: t, kind: 'path', i, end: i === 0 || i === trail.length - 1, via: state.vias.has(t) }]));
  const edges = [];
  for (let i = 1; i < prefix.length; i++) edges.push({ s: prefix[i - 1], t: prefix[i], kind: 'path' });
  for (const side of ['f', 'b']) {
    const keys = [...par[side].keys()].filter((k) => par[side].get(k) !== null);
    for (const k of shuffle(keys, rng).slice(0, 18)) {
      for (let x = k; !nodes.has(x); x = par[side].get(x)) {
        const p = par[side].get(x);
        nodes.set(x, { id: x, kind: 'b1', parent: p });
        edges.push({ s: p, t: x, kind: 'b1' });
      }
    }
  }
  return { nodes: [...nodes.values()], edges, preview: true };
}

// ───────────────────────── stroke text (Hershey single-line fonts) ─────────────────────────
const CAP = 21, BASE = 22, SPACE = 14;   // font units (see fonts.js)
const glyphCache = {};
function fontGlyphs(key) {
  if (glyphCache[key]) return glyphCache[key];
  return (glyphCache[key] = HERSHEY[key].g.map(([o, d]) => {
    const lines = [];
    let cur = null;
    for (const m of d.matchAll(/([ML])|(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
      if (m[1] === 'M') lines.push((cur = []));
      else if (m[2] !== undefined && cur) cur.push([+m[2], +m[3]]);
    }
    return { adv: o * 2, lines };   // 'o' in the data is half the advance width
  }));
}
const CHAR_MAP = { '–': '-', '—': '-', '’': "'", '‘': "'", '“': '"', '”': '"', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ı: 'i' };
const normText = (s) => s.replace(/[–—’‘“”øØłŁđĐßæÆœŒı]/g, (c) => CHAR_MAP[c]).normalize('NFD').replace(/[̀-ͯ]/g, '');
const glyphFor = (g, ch) => { const c = ch.charCodeAt(0); return c >= 33 && c <= 126 ? g[c - 33] : null; };
const fontKey = () => $('#font').value;

function textWidth(s, k, font) {
  const g = fontGlyphs(font);
  let w = 0;
  for (const ch of normText(s)) w += ch === ' ' ? SPACE * k : (glyphFor(g, ch)?.adv ?? 0) * k;
  return w;
}
function wrapText(s, k, maxW, font) {
  const lines = [];
  let cur = '';
  for (const word of s.split(' ')) {
    const t = cur ? cur + ' ' + word : word;
    if (cur && textWidth(t, k, font) > maxW) { lines.push(cur); cur = word; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
// A wrapped, sized block of text. cap = cap height (mm), lh = line pitch, desc = descender room,
// w/h = overall size including descenders.
function makeBlock(str, size, maxW, font, truncAt, forced = null) {
  const cap = size * 0.72, k = cap / CAP, desc = cap / 3;
  const lines = forced || (maxW > 0 ? wrapText(str, k, maxW, font) : [truncAt ? trunc(str, truncAt) : str]);
  const lh = size * 1.25;
  return { lines, k, cap, lh, desc, font, w: Math.max(...lines.map((l) => textWidth(l, k, font))), h: cap + desc + (lines.length - 1) * lh };
}
// Split text into at most N lines of roughly equal width
function balancedLines(str, k, n, font) {
  const words = str.split(' ');
  if (n <= 1 || words.length < 2) return [str];
  let lo = Math.max(...words.map((w) => textWidth(w, k, font))), hi = textWidth(str, k, font);
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (wrapText(str, k, mid, font).length <= n) hi = mid; else lo = mid;
  }
  return wrapText(str, k, hi, font);
}
// Per-article format overrides (state.fmt[title]): text, lines, scale, rScale, label (true/false)
const labelVisible = (n) => state.fmt[n.id]?.label ?? (n.kind === 'path' || chk('showBL'));
function textBlock(n) {
  const f = (!n.preview && state.fmt[n.id]) || {};
  const isPath = n.kind === 'path';
  const size = (isPath ? num('fs') * (n.end ? num('endScale') || 1 : 1) : num('fs') * 0.75) * (f.scale || 1);
  const font = fontKey(), k = (size * 0.72) / CAP;
  const str = f.text || n.id;
  let forced = null;
  if (str.includes('\n')) forced = str.split('\n').map((l) => l.trim()).filter(Boolean);
  else if (f.lines) forced = balancedLines(str, k, f.lines, font);
  return makeBlock(str, size, num(isPath ? 'wrapPath' : 'wrapSat'), font, f.text ? 0 : isPath ? 30 : 26, forced);
}
// Polyline path data for a block; first = baseline of line 1, anchor = start|middle|end
function strokeLines(b, x, first, anchor) {
  const g = fontGlyphs(b.font);
  let d = '';
  b.lines.forEach((line, li) => {
    const lw = textWidth(line, b.k, b.font);
    let cx = anchor === 'start' ? x : anchor === 'end' ? x - lw : x - lw / 2;
    const by = first + li * b.lh;
    for (const ch of normText(line)) {
      if (ch === ' ') { cx += SPACE * b.k; continue; }
      const gl = glyphFor(g, ch);
      if (!gl) continue;
      for (const pl of gl.lines) {
        if (pl.length < 2) continue;
        d += 'M' + pl.map(([px, py]) => fmt(cx + px * b.k) + ' ' + fmt(by + (py - BASE) * b.k)).join('L');
      }
      cx += gl.adv * b.k;
    }
  });
  return d;
}
function boxFor(b, ax, first, anchor) {
  const x0 = anchor === 'start' ? ax : anchor === 'end' ? ax - b.w : ax - b.w / 2;
  return { x0, y0: first - b.cap, x1: x0 + b.w, y1: first + (b.lines.length - 1) * b.lh + b.desc };
}

// ───────────────────────── credit / attribution ─────────────────────────
const PROJECT_URL = 'https://github.com/bobsabayesian/six-degrees-wikipedia';
const CREDIT_TEXT = 'Made with Six Degrees of Wikipedia - github.com/bobsabayesian/six-degrees-wikipedia';

// ───────────────────────── title ─────────────────────────
// Lays out the title/subtitle and returns the zone left over for the map.
function titleLayout(graph) {
  const W = num('pw'), H = num('ph'), m = num('margin');
  const zone = { x0: m, y0: m, x1: W - m, y1: H - m };
  const out = { zone, items: [], box: null };

  // small credit line in the bottom-right corner (on by default)
  let bottom = H - m;
  if (chk('showCredit')) {
    const cb = makeBlock(CREDIT_TEXT, 2.2, W - 2 * m, fontKey());
    out.items.push({ role: 'credit', b: cb, ax: W - m, anchor: 'end', first: bottom - cb.desc });
    bottom -= cb.h + 2.5;
    zone.y1 = bottom;
  }
  if (!chk('showTitle')) return out;

  const pathNodes = graph.nodes.filter((n) => n.kind === 'path').sort((a, b) => a.i - b.i);
  const first = pathNodes[0]?.id ?? '', last = pathNodes.at(-1)?.id ?? '';
  const font = $('#titleFont').value, size = num('titleSize') || 8, maxW = W - 2 * m;
  const title = makeBlock($('#titleText').value.trim() || `${first} to ${last}`, size, maxW, font);
  const items = [{ role: 'title', b: title }];
  if (chk('showSub') && !graph.preview) {
    const deg = pathNodes.length - 1;
    const sub = $('#subText').value.trim() || `${deg} ${deg === 1 ? 'degree' : 'degrees'} of separation`;
    items.push({ role: 'subtitle', b: makeBlock(sub, size * 0.45, maxW, font) });
  }
  const gap = size * 0.35, band = 4;
  const total = items.reduce((t, it) => t + it.b.h, 0) + gap * (items.length - 1);
  const top = $('#titlePos').value === 'top';
  let y = top ? m : bottom - total;
  const align = $('#titleAlign').value;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const ax = align === 'left' ? m : align === 'right' ? W - m : W / 2;
  let box = null;
  for (const it of items) {
    it.first = y + it.b.cap;
    it.anchor = anchor; it.ax = ax;
    const bx = boxFor(it.b, ax, it.first, anchor);
    box = box ? { x0: Math.min(box.x0, bx.x0), y0: Math.min(box.y0, bx.y0), x1: Math.max(box.x1, bx.x1), y1: Math.max(box.y1, bx.y1) } : bx;
    y += it.b.h + gap;
  }
  if (top) zone.y0 = m + total + band; else zone.y1 = bottom - total - band;
  out.items.push(...items); out.box = box;
  return out;
}

// ───────────────────────── label placement ─────────────────────────
const nodeRadius = (n) => (n.kind === 'path' ? (n.end ? num('rEnd') : num('rPath')) : n.kind === 'b1' ? num('rBranch') : num('rBranch') * 0.75) * (state.fmt[n.id]?.rScale || 1);
const PAD = 0.6;
function overlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + PAD;
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + PAD;
  return w > 0 && h > 0 ? w * h : 0;
}
function hitsCircle(box, c) {
  const nx = Math.min(box.x1, Math.max(box.x0, c.x)), ny = Math.min(box.y1, Math.max(box.y0, c.y));
  return Math.hypot(nx - c.x, ny - c.y) < c.r;
}

// Points along every edge (curved like the render), used as obstacles for labels
function edgeSamples(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const curved = chk('curved');
  const pts = [];
  for (const e of graph.edges) {
    const a = byId.get(e.s), b = byId.get(e.t);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const off = curved ? len * 0.1 * ((a.id.length + b.id.length) % 2 ? 1 : -1) : 0;
    const cx = (a.x + b.x) / 2 - (dy / len) * off, cy = (a.y + b.y) / 2 + (dx / len) * off;
    const steps = Math.max(6, Math.ceil(len / 1.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y });
    }
  }
  return pts;
}

// Choose a position for every label: no overlap with other labels, node circles or the title,
// and always inside the margin zone.
function placeLabels(graph, T) {
  const Z = T.zone, showBL = chk('showBL');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const circles = graph.nodes.map((n) => ({ x: n.x, y: n.y, r: nodeRadius(n) + 0.4 }));
  const samples = edgeSamples(graph);
  const placed = T.box ? [T.box] : [];
  const order = [
    ...graph.nodes.filter((n) => n.kind === 'path').sort((a, b) => a.i - b.i),
    ...graph.nodes.filter((n) => n.kind !== 'path'),
  ];

  for (const n of order) {
    if (!graph.preview ? !labelVisible(n) : n.kind !== 'path' && !showBL) { n.lbl = null; continue; }
    const b = textBlock(n), r = nodeRadius(n), nl = b.lines.length;
    const cands = [];
    if (n.kind === 'path') {
      const prefAbove = n.i % 2 === 0;
      for (let L = 0; L < 3; L++) {
        for (const above of [prefAbove, !prefAbove]) {
          for (const anchor of ['middle', 'start', 'end']) {
            const ax = anchor === 'middle' ? n.x : anchor === 'start' ? n.x - r : n.x + r;
            const lift = L * (b.h + 0.8);
            const first = above ? n.y - r - 1.6 - b.desc - (nl - 1) * b.lh - lift : n.y + r + 1.6 + b.cap + lift;
            cands.push({ ax, first, anchor });
          }
        }
      }
    } else {
      const p = byId.get(n.parent);
      const th = p ? Math.atan2(n.y - p.y, n.x - p.x) : -Math.PI / 2;
      for (const da of [0, 0.785, -0.785, 1.571, -1.571, 2.356, -2.356, Math.PI]) {
        const ux = Math.cos(th + da), uy = Math.sin(th + da), d = r + 1.2;
        const anchor = ux > 0.35 ? 'start' : ux < -0.35 ? 'end' : 'middle';
        const first = uy > 0.35 ? n.y + uy * d + b.cap
          : uy < -0.35 ? n.y + uy * d - (nl - 1) * b.lh - b.desc
          : n.y - b.h / 2 + b.cap;
        cands.push({ ax: n.x + ux * d, first, anchor });
      }
    }

    let best = null;
    cands.forEach((c, idx) => {
      let box = boxFor(b, c.ax, c.first, c.anchor);
      // push inside the margins
      const dx = box.x0 < Z.x0 ? Z.x0 - box.x0 : box.x1 > Z.x1 ? Z.x1 - box.x1 : 0;
      const dy = box.y0 < Z.y0 ? Z.y0 - box.y0 : box.y1 > Z.y1 ? Z.y1 - box.y1 : 0;
      const ax = c.ax + dx, first = c.first + dy;
      box = boxFor(b, ax, first, c.anchor);
      let score = idx * 0.05 + (Math.abs(dx) + Math.abs(dy)) * 0.3;
      for (const o of placed) score += overlapArea(box, o) * 10;
      for (const ci of circles) if (hitsCircle(box, ci)) score += 25;
      const edgeCost = n.kind === 'path' ? 6 : 2;
      for (const p of samples) if (p.x > box.x0 - 0.3 && p.x < box.x1 + 0.3 && p.y > box.y0 - 0.3 && p.y < box.y1 + 0.3) score += edgeCost;
      if (!best || score < best.score) best = { score, ax, first, anchor: c.anchor, box, b };
    });
    const o = graph.preview ? null : state.nudge.labels[n.id];
    if (o) {
      const dx = Math.min(Math.max(o.dx, Z.x0 - best.box.x0), Z.x1 - best.box.x1);
      const dy = Math.min(Math.max(o.dy, Z.y0 - best.box.y0), Z.y1 - best.box.y1);
      best.ax += dx; best.first += dy;
      best.box = boxFor(b, best.ax, best.first, best.anchor);
    }
    n.lbl = best;
    placed.push(best.box);
  }
}

// ───────────────────────── layout ─────────────────────────
function layout(graph, seed) {
  const W = num('pw'), H = num('ph');
  const T = titleLayout(graph), Z = T.zone;
  const zw = Z.x1 - Z.x0, zh = Z.y1 - Z.y0;
  const s = Math.min(3, Math.max(0.5, Math.sqrt((W * H) / (297 * 210))));   // spacing scales with paper size
  const rng = mulberry32(seed * 7919 + 1);
  const pathNodes = graph.nodes.filter((n) => n.kind === 'path').sort((x, y) => x.i - y.i);
  const np = pathNodes.length;

  for (const n of graph.nodes) {
    if (n.kind === 'path') {
      const f = np > 1 ? n.i / (np - 1) : 0.5;
      n.x = n.fx = Z.x0 + zw * (0.07 + 0.86 * f);
      n.y = n.fy = Z.y0 + zh / 2 + Math.sin(f * Math.PI * 2) * zh * 0.14;
    } else {
      n.x = Z.x0 + zw / 2 + (rng() - 0.5) * zw * 0.6;
      n.y = Z.y0 + zh / 2 + (rng() - 0.5) * zh * 0.6;
      n.fx = n.fy = null;
    }
    const b = n.kind === 'path' || chk('showBL') ? textBlock(n) : { w: 0, h: 0 };
    n.cr = Math.max(n.kind === 'path' ? 3 : 1.5, Math.hypot(b.w, b.h) * 0.35) + 1;
  }

  // Fixed "ghost" obstacles reserve a pocket for each path label so satellites and their edges keep clear
  const ghosts = [];
  for (const n of pathNodes) {
    const b = textBlock(n), r = nodeRadius(n);
    const cy = n.i % 2 === 0 ? n.y - r - 1.6 - b.h / 2 : n.y + r + 1.6 + b.h / 2;
    const gr = b.h / 2 + 0.8, span = Math.max(0, b.w - 2 * gr), count = Math.max(1, Math.ceil(span / (gr * 1.2)) + 1);
    for (let g = 0; g < count; g++) {
      const gx = count === 1 ? n.x : n.x - span / 2 + (span * g) / (count - 1);
      ghosts.push({ id: `ghost${n.i}.${g}`, ghost: true, x: gx, y: cy, fx: gx, fy: cy, cr: gr });
    }
  }

  const links = graph.edges.map((e) => ({ source: e.s, target: e.t, kind: e.kind }));
  const dist = { path: 30 * s, b1: 24 * s, b2: 16 * s, cross: 50 * s };
  const sim = d3.forceSimulation([...graph.nodes, ...ghosts])
    .randomSource(rng)
    .force('link', d3.forceLink(links).id((d) => d.id)
      .distance((l) => dist[l.kind]).strength((l) => (l.kind === 'cross' ? 0.01 : l.kind === 'path' ? 0.2 : 0.5)))
    .force('charge', d3.forceManyBody().strength((d) => (d.ghost ? 0 : -45 * s)))
    .force('collide', d3.forceCollide().radius((d) => d.cr).iterations(2))
    .force('x', d3.forceX(Z.x0 + zw / 2).strength(0.015))
    .force('y', d3.forceY(Z.y0 + zh / 2).strength(0.04))
    .stop();
  for (let i = 0; i < 350; i++) {
    sim.tick();
    for (const n of graph.nodes) {
      n.x = Math.min(Z.x1, Math.max(Z.x0, n.x));
      n.y = Math.min(Z.y1, Math.max(Z.y0, n.y));
    }
  }
  for (const n of graph.nodes) { n.sx = n.x; n.sy = n.y; }   // simulated positions, before manual nudges
  graph.title = T;
  finalize(graph);
}

// Apply manual nudges on top of the simulated layout, then place labels.
// Nudges are post-simulation, so moving one item never disturbs the rest of the map.
function finalize(graph) {
  const W = num('pw'), H = num('ph');
  for (const n of graph.nodes) {
    const o = graph.preview ? null : state.nudge.nodes[n.id];
    n.x = o ? o[0] * W : n.sx;
    n.y = o ? o[1] * H : n.sy;
  }
  placeLabels(graph, graph.title);
}

// ───────────────────────── pens & roles ─────────────────────────
const ROLES = [
  ['title', 'Title'], ['subtitle', 'Subtitle'], ['credit', 'Credit line'],
  ['startNode', 'Start node'], ['startLabel', 'Start label'],
  ['endNode', 'End node'], ['endLabel', 'End label'],
  ['viaNode', 'Via nodes'], ['viaLabel', 'Via labels'],
  ['pathEdge', 'Path edges'], ['pathNode', 'Path nodes (between)'], ['pathLabel', 'Path labels (between)'],
  ['fillPath', 'Path node fill'],
  ['branchEdge', 'Branch edges'], ['branchNode', 'Branch nodes'], ['branchLabel', 'Branch labels'],
  ['branch2Edge', 'Sub-branch edges'], ['branch2Node', 'Sub-branch nodes'], ['branch2Label', 'Sub-branch labels'],
  ['fillBranch', 'Branch node fill'],
  ['crossEdge', 'Cross-links'], ['frame', 'Page border'],
];
const DEFAULT_PENS = [
  { id: 'p1', name: 'Black', color: '#111111', width: 0.4 },
  { id: 'p2', name: 'Red', color: '#c0392b', width: 0.6 },
  { id: 'p3', name: 'Blue', color: '#1f5fbf', width: 0.3 },
  { id: 'p4', name: 'Grey', color: '#8a8a8a', width: 0.2 },
  { id: 'p5', name: 'Green', color: '#2e8b57', width: 0.6 },
  { id: 'p6', name: 'Purple', color: '#7b3fa0', width: 0.6 },
  { id: 'p7', name: 'Orange', color: '#d98a00', width: 0.6 },
];
const DEFAULT_ASSIGN = {
  title: 'p1', subtitle: 'p1', credit: 'p4',
  startNode: 'p5', startLabel: 'p5', endNode: 'p6', endLabel: 'p6', viaNode: 'p7', viaLabel: 'p7',
  pathEdge: 'p2', pathNode: 'p2', pathLabel: 'p2', fillPath: '',
  branchEdge: 'p3', branchNode: 'p3', branchLabel: 'p1', fillBranch: '',
  branch2Edge: 'p4', branch2Node: 'p4', branch2Label: 'p4',
  crossEdge: 'p4', frame: '',
};
// Roles added after a settings blob was saved inherit from the older, coarser role
const ROLE_FALLBACK = {
  startNode: 'pathNode', endNode: 'pathNode', startLabel: 'pathLabel', endLabel: 'pathLabel',
  viaNode: 'pathNode', viaLabel: 'pathLabel',
  branch2Node: 'branchNode', branch2Label: 'branchLabel',
};
let pens = structuredClone(DEFAULT_PENS);
let assign = { ...DEFAULT_ASSIGN };

function renderPenUI() {
  const box = $('#pens');
  box.innerHTML = '';
  pens.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pen';
    row.innerHTML = `<span title="Layer number">${i + 1}</span>
      <input type="color" value="${p.color}">
      <input class="name" value="${esc(p.name)}">
      <input class="w" type="number" step="0.05" min="0.05" value="${p.width}" title="Line width (mm)">
      <button title="Remove pen">✕</button>`;
    const [, color, name, w, del] = row.children;
    color.oninput = () => { p.color = color.value; changed(false); };
    name.oninput = () => { p.name = name.value; renderRoles(); changed(false); };
    w.oninput = () => { p.width = parseFloat(w.value) || 0.3; changed(false); };
    del.onclick = () => {
      pens.splice(i, 1);
      for (const r in assign) if (assign[r] === p.id) assign[r] = '';
      renderPenUI(); changed(false);
    };
    box.appendChild(row);
  });
  renderRoles();
}
function renderRoles() {
  const roles = $('#roles');
  roles.innerHTML = '';
  for (const [key, label] of ROLES) {
    const row = document.createElement('div');
    row.className = 'role';
    const opts = ['<option value="">— none —</option>']
      .concat(pens.map((p, i) => `<option value="${p.id}">${i + 1} ${esc(p.name)}</option>`)).join('');
    row.innerHTML = `<span>${label}</span><select>${opts}</select>`;
    const sel = row.querySelector('select');
    sel.value = assign[key] || '';
    sel.onchange = () => { assign[key] = sel.value; changed(false); };
    roles.appendChild(row);
  }
}
$('#addPen').onclick = () => {
  pens.push({ id: 'p' + Date.now().toString(36), name: 'Pen ' + (pens.length + 1), color: '#000000', width: 0.4 });
  renderPenUI(); changed(false);
};

// ───────────────────────── SVG rendering ─────────────────────────
// Fill a disc with pen strokes: concentric rings or 45° hatching, spaced by the fill pen's width.
function fillDisc(cx, cy, r, step, style) {
  if (r <= 0.05) return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="0.05"/>`;
  if (style === 'hatch') {
    let d = '';
    const c = Math.SQRT1_2;   // direction (c, c), normal (-c, c)
    for (let t = -r + step / 2; t < r; t += step) {
      const half = Math.sqrt(Math.max(0, r * r - t * t));
      const px = cx - c * t, py = cy + c * t;
      d += `M${fmt(px - c * half)} ${fmt(py - c * half)}L${fmt(px + c * half)} ${fmt(py + c * half)}`;
    }
    return `<path d="${d}"/>`;
  }
  let out = '';
  for (let rr = r; rr > 0.05; rr -= step) out += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(rr)}"/>`;
  if (r % step > 0.05 + step * 0.5) out += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="0.05"/>`;
  return out;
}

function renderSVG(graph) {
  const W = num('pw'), H = num('ph'), m = num('margin');
  const curved = chk('curved'), fillStyle = $('#fillStyle').value;
  const buckets = new Map(pens.map((p) => [p.id, []]));
  const add = (role, str) => { const b = buckets.get(assign[role]); if (b) b.push(str); };
  const penOf = (role) => !!buckets.get(assign[role]);
  const penObj = (role) => pens.find((p) => p.id === assign[role]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const np = graph.nodes.filter((n) => n.kind === 'path').length;
  // role family of a node: start | end | path | b1 | b2
  const family = (n) => (n.kind !== 'path' ? n.kind : n.i === 0 ? 'start' : n.i === np - 1 ? 'end' : n.via ? 'via' : 'path');
  const NODE_ROLE = { start: 'startNode', end: 'endNode', via: 'viaNode', path: 'pathNode', b1: 'branchNode', b2: 'branch2Node' };
  const LABEL_ROLE = { start: 'startLabel', end: 'endLabel', via: 'viaLabel', path: 'pathLabel', b1: 'branchLabel', b2: 'branch2Label' };
  const edgeRole = { path: 'pathEdge', b1: 'branchEdge', b2: 'branch2Edge', cross: 'crossEdge' };

  if (penOf('frame')) add('frame', `<rect x="${m / 2}" y="${m / 2}" width="${W - m}" height="${H - m}"/>`);

  for (const it of graph.title?.items ?? []) {
    const d = strokeLines(it.b, it.ax, it.first, it.anchor);
    if (d) add(it.role, `<path d="${d}"/>`);
  }

  // edges, trimmed so they stop at the node circles
  const edgeD = {};
  for (const e of graph.edges) {
    const a = byId.get(e.s), b = byId.get(e.t);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const ux = dx / len, uy = dy / len;
    const ta = penOf(NODE_ROLE[family(a)]) ? nodeRadius(a) + 0.6 : 0;
    const tb = penOf(NODE_ROLE[family(b)]) ? nodeRadius(b) + 0.6 : 0;
    if (len <= ta + tb) continue;
    const x1 = a.x + ux * ta, y1 = a.y + uy * ta, x2 = b.x - ux * tb, y2 = b.y - uy * tb;
    let d;
    if (curved) {
      const sign = (a.id.length + b.id.length) % 2 ? 1 : -1;
      const off = len * 0.1 * sign;
      d = `M${fmt(x1)} ${fmt(y1)}Q${fmt((x1 + x2) / 2 - uy * off)} ${fmt((y1 + y2) / 2 + ux * off)} ${fmt(x2)} ${fmt(y2)}`;
    } else {
      d = `M${fmt(x1)} ${fmt(y1)}L${fmt(x2)} ${fmt(y2)}`;
    }
    (edgeD[e.kind] ||= []).push(d);
  }
  for (const k in edgeD) add(edgeRole[k], `<path d="${edgeD[k].join('')}"/>`);

  // nodes, fills, labels
  for (const n of graph.nodes) {
    const fam = family(n), r = nodeRadius(n);
    const nodeRole = NODE_ROLE[fam];
    add(nodeRole, `<circle cx="${fmt(n.x)}" cy="${fmt(n.y)}" r="${r}"/>`);
    const fillRole = n.kind === 'path' ? 'fillPath' : 'fillBranch';
    if (penOf(fillRole)) {
      const step = Math.max(0.1, penObj(fillRole).width * 0.9);
      const outline = penOf(nodeRole) ? penObj(nodeRole).width / 2 : 0;
      add(fillRole, fillDisc(n.x, n.y, r - outline - penObj(fillRole).width / 2, step, fillStyle));
    }
    const l = n.lbl;
    if (l && penOf(LABEL_ROLE[fam])) {
      const d = strokeLines(l.b, l.ax, l.first, l.anchor);
      if (d) add(LABEL_ROLE[fam], `<path d="${d}"/>`);
    }
  }

  const layers = pens.map((p, i) => {
    const items = buckets.get(p.id);
    if (!items.length) return '';
    const label = `${i + 1} ${p.name}`;
    return `<g id="layer${i + 1}" inkscape:groupmode="layer" inkscape:label="${esc(label)}" fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round">\n${items.join('\n')}\n</g>`;
  }).filter(Boolean).join('\n');

  const meta = `<metadata>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
<rdf:Description>
<dc:creator>Made with Six Degrees of Wikipedia (${PROJECT_URL})</dc:creator>
<dc:source>${PROJECT_URL}</dc:source>
<dc:rights>Software: PolyForm Noncommercial License 1.0.0, Copyright 2026 bobsabayesian. Commercial use of the software requires a separate licence: ${PROJECT_URL}</dc:rights>
<dc:description>Link data from Wikipedia (https://www.wikipedia.org), used under CC BY-SA.</dc:description>
</rdf:Description>
</rdf:RDF>
</metadata>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">\n${meta}\n${layers}\n</svg>`;
}

function show(graph) {
  const paper = $('#paper');
  paper.innerHTML = renderSVG(graph);
  paper.style.setProperty('--ar', num('pw') / num('ph'));
  if (graph === state.graph && !graph.preview) addHandles(graph, paper.querySelector('svg'));
}

// Invisible hit areas for dragging (UI only; never part of the exported SVG)
function addHandles(graph, svg) {
  const sel = state.sel;
  const cls = (kind, id) => 'h' + (sel && sel.kind === kind && sel.id === id ? ' sel' : '');
  let out = '';
  for (const n of graph.nodes) {
    const b = n.lbl?.box;
    if (b) out += `<rect class="${cls('label', n.id)}" data-h="label" data-id="${esc(n.id)}" x="${fmt(b.x0 - 0.5)}" y="${fmt(b.y0 - 0.5)}" width="${fmt(b.x1 - b.x0 + 1)}" height="${fmt(b.y1 - b.y0 + 1)}"/>`;
  }
  for (const n of graph.nodes) {
    out += `<circle class="${cls('node', n.id)}" data-h="node" data-id="${esc(n.id)}" cx="${fmt(n.x)}" cy="${fmt(n.y)}" r="${fmt(Math.max(nodeRadius(n) + 1, 2.5))}"/>`;
  }
  svg.insertAdjacentHTML('beforeend', `<g id="nudge">${out}</g>`);
}

// ───────────────────────── nudging (drag / arrow keys) ─────────────────────────
function refresh() { if (state.graph) { finalize(state.graph); show(state.graph); } }
function resetNudges() { state.nudge = { nodes: {}, labels: {} }; state.sel = null; }
const paperEl = $('#paper');
let drag = null;
function toMM(e) {
  const svg = paperEl.querySelector('svg');
  const ctm = svg.getScreenCTM();
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  return ctm ? pt.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
}
function setNode(id, x, y) {
  const W = num('pw'), H = num('ph'), m = num('margin');
  state.nudge.nodes[id] = [Math.min(W - m, Math.max(m, x)) / W, Math.min(H - m, Math.max(m, y)) / H];
}
paperEl.addEventListener('pointerdown', (e) => {
  const h = e.target.closest?.('[data-h]');
  if (!state.graph) return;
  if (!h) { if (state.sel) { state.sel = null; renderInspector(); refresh(); } return; }
  document.activeElement?.blur?.();
  const kind = h.dataset.h, id = h.dataset.id;
  const n = state.graph.nodes.find((x) => x.id === id);
  const p = toMM(e);
  const changedSel = state.sel?.id !== id;
  state.sel = { kind, id };
  if (changedSel) renderInspector();
  drag = { kind, id, sx: p.x, sy: p.y, orig: kind === 'node' ? [n.x, n.y] : { ...(state.nudge.labels[id] || { dx: 0, dy: 0 }) } };
  paperEl.setPointerCapture(e.pointerId);
  e.preventDefault();
  refresh();
});
paperEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = toMM(e), dx = p.x - drag.sx, dy = p.y - drag.sy;
  if (drag.kind === 'node') setNode(drag.id, drag.orig[0] + dx, drag.orig[1] + dy);
  else state.nudge.labels[drag.id] = { dx: drag.orig.dx + dx, dy: drag.orig.dy + dy };
  refresh();
});
paperEl.addEventListener('pointerup', () => { drag = null; });
paperEl.addEventListener('dblclick', (e) => {
  const h = e.target.closest?.('[data-h]');
  if (!h) return;
  delete (h.dataset.h === 'node' ? state.nudge.nodes : state.nudge.labels)[h.dataset.id];
  refresh();
});
window.addEventListener('keydown', (e) => {
  if (!state.sel || !state.graph || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!dir) return;
  e.preventDefault();
  const step = e.shiftKey ? 2 : 0.5, dx = dir[0] * step, dy = dir[1] * step;
  const { kind, id } = state.sel;
  if (kind === 'node') {
    const n = state.graph.nodes.find((x) => x.id === id);
    if (n) setNode(id, n.x + dx, n.y + dy);
  } else {
    const o = state.nudge.labels[id] || { dx: 0, dy: 0 };
    state.nudge.labels[id] = { dx: o.dx + dx, dy: o.dy + dy };
  }
  refresh();
});
// ── inspector: per-article format ──
const ins = {
  box: $('#inspector'), name: $('#insName'), text: $('#insText'), scale: $('#insScale'), r: $('#insR'), show: $('#insShow'),
};
const selNode = () => state.sel && state.graph?.nodes.find((n) => n.id === state.sel.id);
function renderInspector() {
  const n = selNode();
  ins.box.hidden = !n;
  if (!n) return;
  const f = state.fmt[n.id] || {};
  ins.name.textContent = n.id;
  ins.text.value = f.text ?? n.id;
  ins.scale.value = f.scale ?? 1;
  ins.r.value = f.rScale ?? 1;
  ins.show.checked = labelVisible(n);
}
function setFmt(patch) {
  const n = selNode();
  if (!n) return;
  const f = { ...(state.fmt[n.id] || {}) };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === null) delete f[k]; else f[k] = v; }
  if (Object.keys(f).length) state.fmt[n.id] = f; else delete state.fmt[n.id];
  refresh();
}
ins.text.addEventListener('input', () => {
  const n = selNode();
  setFmt({ text: ins.text.value.trim() && ins.text.value !== n.id ? ins.text.value : undefined });
});
document.querySelectorAll('#inspector [data-lines]').forEach((btn) => {
  btn.onclick = () => {
    const n = selNode();
    if (!n) return;
    const f = state.fmt[n.id] || {};
    let text = f.text;
    if (text && text.includes('\n')) { text = text.replace(/\s*\n\s*/g, ' '); ins.text.value = text; }   // explicit breaks would override
    setFmt({ lines: +btn.dataset.lines || undefined, text: text === n.id ? undefined : text });
  };
});
ins.scale.addEventListener('input', () => { const v = parseFloat(ins.scale.value); setFmt({ scale: v > 0 && v !== 1 ? v : undefined }); });
ins.r.addEventListener('input', () => { const v = parseFloat(ins.r.value); setFmt({ rScale: v > 0 && v !== 1 ? v : undefined }); });
ins.show.addEventListener('change', () => {
  const n = selNode();
  const def = n.kind === 'path' || chk('showBL');
  setFmt({ label: ins.show.checked === def ? undefined : ins.show.checked });
});
$('#insIgnore').onclick = async () => {
  const n = selNode();
  if (!n) return;
  if (n.end || n.via) { $('#status').textContent = 'The start, end and via pages can’t be ignored.'; return; }
  const box = $('#ignoreList');
  box.value = (box.value.trim() ? box.value.trim() + '\n' : '') + n.id;
  persist();
  state.sel = null; renderInspector();
  await syncIgnore();
  if (n.kind === 'path') $('#find').click();   // the route itself changes, so search again
  else await rebuild();
};
$('#insReset').onclick = () => { const n = selNode(); if (n) { delete state.fmt[n.id]; renderInspector(); refresh(); } };
$('#insClose').onclick = () => { state.sel = null; renderInspector(); refresh(); };

$('#resetNudges').onclick = () => { resetNudges(); refresh(); };

// ───────────────────────── pipeline ─────────────────────────
async function rebuild() {
  if (!state.path || state.running) return;
  const token = ++state.token;
  try {
    const graph = await buildGraph(state.path, num('seed'));
    if (token !== state.token) return;
    layout(graph, num('seed'));
    state.graph = graph;
    show(graph);
    $('#export').disabled = false; $('#exportJpg').disabled = false;
    $('#status').textContent = `${state.path.length - 1} links: ${state.path.join(' → ')}  ·  ${graph.nodes.length} pages, ${graph.edges.length} edges`;
  } catch (e) {
    if (e.message !== 'cancelled') { $('#status').textContent = 'Error: ' + e.message; log('Error: ' + e.message); }
  }
}
const rebuildSoon = debounce(rebuild, 300);

function persist() {
  try {
    const vals = {};
    document.querySelectorAll('[data-save]').forEach((el) => { vals[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
    localStorage.setItem('sdw', JSON.stringify({ vals, pens, assign, preset: $('#preset').value, vias: viaValues() }));
  } catch { /* storage unavailable */ }
}
// relayout=true → recompute graph/layout; false → restyle only
function changed(relayout) {
  persist();
  if (relayout) rebuildSoon();
  else if (state.graph) show(state.graph);
}

// ───────────────────────── UI wiring ─────────────────────────
const LAYOUT_IDS = ['k1', 'k2', 'cross', 'seed', 'pw', 'ph', 'margin', 'fs', 'showBL', 'font', 'wrapSat', 'wrapPath', 'rPath', 'rBranch', 'rEnd', 'endScale', 'k1End',
  'showCredit', 'showTitle', 'titleText', 'showSub', 'subText', 'titlePos', 'titleAlign', 'titleSize', 'titleFont'];
document.querySelectorAll('[data-save]').forEach((el) => {
  el.addEventListener('input', () => changed(LAYOUT_IDS.includes(el.id)));
});
function applyPaper() {
  const v = $('#preset').value;
  if (!v) return;
  const [short, long] = v.split(',').map(Number);
  const land = $('#orient').value === 'landscape';
  $('#pw').value = land ? long : short;
  $('#ph').value = land ? short : long;
  changed(true);
}
$('#preset').onchange = applyPaper;
$('#orient').onchange = applyPaper;
['pw', 'ph'].forEach((id) => $('#' + id).addEventListener('input', () => { $('#preset').value = ''; persist(); }));
$('#reshuffle').onclick = () => { $('#seed').value = Math.floor(Math.random() * 99999); resetNudges(); changed(true); };
$('#seed').addEventListener('input', resetNudges);

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('sdw') || 'null');
    if (!s) return;
    for (const [id, v] of Object.entries(s.vals || {})) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
    }
    if (Array.isArray(s.pens) && s.pens.length) pens = s.pens;
    if (s.assign) {
      assign = { ...DEFAULT_ASSIGN, ...s.assign };
      for (const [role, from] of Object.entries(ROLE_FALLBACK)) if (!(role in s.assign)) assign[role] = s.assign[from] ?? '';
    }
    if (s.preset !== undefined) $('#preset').value = s.preset;
    (s.vias || []).forEach((v) => addVia(v));
  } catch { /* ignore corrupt state */ }
}

// autocomplete
function wireAutocomplete(box) {
  const input = box.querySelector('input'), list = box.querySelector('.suggest');
  let seq = 0;
  const lookup = debounce(async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) { list.innerHTML = ''; return; }
    try {
      const j = await api({ action: 'query', generator: 'prefixsearch', gpssearch: q, gpslimit: '7', gpsnamespace: '0', prop: 'description' });
      if (mine !== seq) return;
      const pages = (j.query?.pages ?? []).sort((a, b) => a.index - b.index);
      list.innerHTML = '';
      for (const p of pages) {
        const li = document.createElement('li');
        li.innerHTML = `${esc(p.title)}<small>${esc(p.description || '')}</small>`;
        li.onmousedown = (e) => { e.preventDefault(); input.value = p.title; list.innerHTML = ''; persist(); };
        list.appendChild(li);
      }
    } catch { /* ignore */ }
  }, 180);
  input.addEventListener('input', lookup);
  input.addEventListener('blur', () => { seq++; setTimeout(() => (list.innerHTML = ''), 100); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { list.innerHTML = ''; $('#find').click(); } });
}
document.querySelectorAll('.ac').forEach(wireAutocomplete);


// ignore list: apply live
$('#ignoreList').addEventListener('input', debounce(async () => {
  await syncIgnore();
  const hit = state.path?.find((t) => state.ignore.has(t));
  if (hit) $('#status').textContent = `“${hit}” is on the current path. Click “Find connection” again to route around it.`;
  else await rebuild();
}, 700));

// via topics
function addVia(value = '') {
  const row = document.createElement('div');
  row.className = 'viaRow';
  row.innerHTML = '<div class="ac"><input class="via" placeholder="Must pass through…" autocomplete="off"><ul class="suggest"></ul></div><button title="Remove">✕</button>';
  const input = row.querySelector('input');
  input.value = value;
  input.addEventListener('input', persist);
  row.querySelector('button').onclick = () => { row.remove(); persist(); };
  $('#vias').appendChild(row);
  wireAutocomplete(row.querySelector('.ac'));
  return input;
}
const viaValues = () => [...document.querySelectorAll('#vias input.via')].map((i) => i.value.trim());
$('#addVia').onclick = () => addVia().focus();

// find
$('#stop').onclick = () => { state.cancel = true; };
$('#find').onclick = async () => {
  if (state.running) return;
  state.running = true; state.cancel = false;
  $('#find').disabled = true; $('#stop').disabled = false; $('#export').disabled = true; $('#exportJpg').disabled = true;
  $('#log').textContent = '';
  const status = (s) => { $('#status').textContent = s; };
  let found = null;
  try {
    status('Resolving titles…');
    const typed = [$('#topicA').value.trim(), ...viaValues().filter(Boolean), $('#topicB').value.trim()];
    await syncIgnore();
    const stops = await Promise.all(typed.map(resolveTitle));
    const banned = stops.find((t) => state.ignore.has(t));
    if (banned) throw new Error(`“${banned}” is a start, end or via topic, but it is also in your ignore list`);
    if (new Set(stops).size !== stops.length) throw new Error('Each topic (including via topics) must be different');
    const inputs = [$('#topicA'), ...[...document.querySelectorAll('#vias input.via')].filter((i) => i.value.trim()), $('#topicB')];
    inputs.forEach((el, i) => { el.value = stops[i]; });
    persist();
    state.vias = new Set(stops.slice(1, -1));
    log(`Searching: ${stops.join('  →  ')}`);

    let path = [stops[0]];
    for (let leg = 0; leg < stops.length - 1; leg++) {
      const a = stops[leg], b = stops[leg + 1];
      const tag = stops.length > 2 ? `[leg ${leg + 1}/${stops.length - 1}] ` : '';
      const prefix = path;
      const part = await findPath(a, b, { maxExp: num('maxExp'), cap: num('cap') }, async ({ step, side, count, par }) => {
        log(`${tag}#${step + 1} expanding ${count} pages ${side === 'f' ? `forward from “${a}”` : `backward from “${b}”`}  (seen ${par.f.size} / ${par.b.size})`);
        status(`${tag}Searching… step ${step + 1}, ${par.f.size + par.b.size} pages seen`);
        const g = previewGraph(par, a, b, prefix);
        layout(g, 1);
        show(g);
        await sleep(0);
      });
      if (!part) {
        status(`No connection found from “${a}” to “${b}” within the search limits. Try a larger frontier cap or more expansions.`);
        log(`No path found for ${a} → ${b}.`);
        return;
      }
      if (stops.length > 2) log(`${tag}Found: ${part.join(' → ')}`);
      // join the leg, cutting out any loop back onto a page we already visited (never cutting a via stop)
      for (const t of part.slice(1)) {
        const at = path.indexOf(t);
        if (at < 0) path.push(t);
        else if (!path.slice(at + 1).some((x) => state.vias.has(x))) path.length = at + 1;
        else log(`Note: “${t}” is visited twice; keeping the first visit`);
      }
    }
    log(`Found: ${path.join(' → ')}`);
    state.path = found = path;
    resetNudges();
    state.fmt = {};
    renderInspector();
  } catch (e) {
    if (e.message === 'cancelled') { status('Stopped.'); log('Stopped.'); }
    else { status('Error: ' + e.message); log('Error: ' + e.message); }
  } finally {
    state.running = false;
    $('#find').disabled = false; $('#stop').disabled = true;
  }
  if (found) { status('Adding branches…'); await rebuild(); }
};

// export
$('#export').onclick = () => {
  if (!state.graph) return;
  const svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + renderSVG(state.graph);
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), fileSlug() + '.svg');
};

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileSlug = () => {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug(state.path[0])}_to_${slug(state.path.at(-1))}`;
};
$('#exportJpg').onclick = async () => {
  if (!state.graph) return;
  const W = num('pw'), H = num('ph');
  const px = Math.min(12000, Math.max(500, Math.round(num('jpgW')) || 3000));
  const py = Math.round((px * H) / W);
  const url = URL.createObjectURL(new Blob([renderSVG(state.graph)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = px; canvas.height = py;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px, py);
    ctx.drawImage(img, 0, 0, px, py);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) throw new Error('image too large for this browser; lower the JPG width');
    downloadBlob(blob, fileSlug() + '.jpg');
  } catch (e) {
    $('#status').textContent = 'JPG export failed: ' + e.message;
  } finally {
    URL.revokeObjectURL(url);
  }
};

restore();
renderPenUI();
