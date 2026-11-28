/* global X32, EQMath */
'use strict';

// ---------------------------------------------------------------------------
// Saved settings: kept in a file by the main process (see main/store.js).
// ---------------------------------------------------------------------------
const store = (() => {
  const onDisk = window.x32.loadSettings();
  const saved = new Map(Object.entries(onDisk || {}));
  const api = {
    getItem: (k) => (saved.has(k) ? saved.get(k) : null),
    setItem: (k, v) => {
      const next = String(v);
      if (saved.get(k) === next) return;
      saved.set(k, next);
      window.x32.saveSetting(k, next);
    },
  };
  if (!onDisk) {
    // First start after updating: bring over what older versions kept in the
    // browser storage. Mix groups used to be saved per console IP, so they
    // looked lost when the console's address changed; merge them into one set.
    const old = window.localStorage;
    for (let i = 0; i < old.length; i++) {
      const k = old.key(i);
      if (!k.startsWith('mixGroups:')) api.setItem(k, old.getItem(k));
    }
    const current = `mixGroups:${old.getItem('host') || 'default'}`;
    const others = Array.from({ length: old.length }, (_, i) => old.key(i)).filter((k) => k.startsWith('mixGroups:') && k !== current);
    const merged = {};
    for (const k of [current, ...others]) {
      let groups = {};
      try {
        groups = JSON.parse(old.getItem(k)) || {};
      } catch {
        /* unreadable entry: skip it */
      }
      for (const [bus, g] of Object.entries(groups)) {
        if (!merged[bus] && (g.dcas?.length || g.mutes?.length)) merged[bus] = g;
      }
    }
    if (Object.keys(merged).length) api.setItem('mixGroups', JSON.stringify(merged));
  }
  return api;
})();

// ---------------------------------------------------------------------------
// State store: path -> value, with per-path watchers.
// ---------------------------------------------------------------------------
const state = new Map();
const watchers = new Map();
const dragging = new Set(); // paths the user is actively dragging: ignore echoes

function apply(path, value) {
  state.set(path, value);
  const set = watchers.get(path);
  if (set) for (const fn of set) fn(value);
}

function makeScope() {
  const offs = [];
  return {
    watch(path, fn) {
      if (!watchers.has(path)) watchers.set(path, new Set());
      watchers.get(path).add(fn);
      offs.push(() => watchers.get(path).delete(fn));
      fn(state.get(path));
    },
    watchAll(paths, fn) {
      let queued = false;
      const run = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          fn();
        });
      };
      for (const p of paths) {
        if (!watchers.has(p)) watchers.set(p, new Set());
        watchers.get(p).add(run);
        offs.push(() => watchers.get(p).delete(run));
      }
      fn();
    },
    add(off) {
      offs.push(off);
    },
    dispose() {
      offs.splice(0).forEach((f) => f());
    },
  };
}

// Outgoing sets are coalesced per animation frame so drags don't flood UDP.
// "local:" paths are app-only controls (mix groups). They never reach the console;
// a handler turns a user change into real parameter changes.
const outbox = new Map();
const localHandlers = new Map();
let outScheduled = false;
function setParam(path, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return; // never send NaN/Infinity
  apply(path, value);
  if (path.startsWith('local:')) {
    localHandlers.get(path)?.(value);
    return;
  }
  outbox.set(path, value);
  if (!outScheduled) {
    outScheduled = true;
    // A timer (not requestAnimationFrame) so changes still go out while the
    // window is minimized or covered.
    setTimeout(() => {
      outScheduled = false;
      for (const [p, v] of outbox) window.x32.set(p, v);
      outbox.clear();
    }, 16);
  }
}
const command = (address, args = []) => window.x32.command(address, args);
const int = (value) => ({ type: 'i', value });
const str = (value) => ({ type: 's', value });

async function load(paths) {
  const snap = await window.x32.query(paths);
  for (const [p, v] of snap) if (!dragging.has(p)) apply(p, v);
}

window.x32.onUpdates((batch) => {
  for (const [p, v] of batch) if (!dragging.has(p)) apply(p, v);
});

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}
const $ = (id) => document.getElementById(id);
const nameOf = (s) => state.get(s.name) || s.defaultName;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Controls stay inert until the console has reported the value, so a drag
// never starts from a placeholder and jumps the real setting.
// Nothing is edited while offline: a change that can't reach the console must
// not be recorded as done.
const known = (path) => connState === 'connected' && state.has(path) && state.get(path) !== undefined;

// Right-click menu. items: [{label, action, danger?} | 'sep']
let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
function showMenu(e, title, items) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  const menu = el('div', { class: 'ctx-menu' }, [
    title ? el('div', { class: 'ctx-title', text: title }) : null,
    ...items.map((it) =>
      it === 'sep'
        ? el('div', { class: 'ctx-sep' })
        : el('button', {
            class: `ctx-item${it.danger ? ' danger-text' : ''}${it.checked ? ' checked' : ''}`,
            text: it.label,
            onclick: () => {
              closeMenu();
              it.action();
            },
          }, it.swatch ? [el('span', { class: 'ctx-swatch', style: `background:${it.swatch}` })] : []),
    ),
  ]);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 6)}px`;
  openMenu = menu;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);

// Fader position after moving by `deltaDb` (mouse wheel steps in dB).
function stepFaderDb(v, deltaDb) {
  const db = X32.faderToDb(v);
  if (db === -Infinity) return deltaDb > 0 ? X32.dbToFader(-60) : 0;
  const next = db + deltaDb;
  return next < -89 ? 0 : X32.dbToFader(Math.min(10, next));
}
const levelMenu = (path, label) => [
  { label: '0 dB (unity)', action: () => setParam(path, 0.75) },
  { label: '−5 dB', action: () => setParam(path, X32.dbToFader(-5)) },
  { label: '−10 dB', action: () => setParam(path, X32.dbToFader(-10)) },
  { label: '−20 dB', action: () => setParam(path, X32.dbToFader(-20)) },
  { label: `−∞ (${label})`, action: () => setParam(path, 0), danger: true },
];

function toast(msg) {
  const t = el('div', { class: 'toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 1600);
  setTimeout(() => t.remove(), 2000);
}

// ---------------------------------------------------------------------------
// Meters (one rAF loop for every meter element on screen)
// ---------------------------------------------------------------------------
const meterValues = { 0: [], 1: [], 2: [] };
const meterEls = new Set();
const frameTasks = new Set();
window.x32.onMeters(({ bank, values }) => {
  meterValues[bank] = values;
});

const linToDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
// Meter scale: 0 dBFS at top, -60 at bottom, with more resolution near the top.
function meterPos(lin) {
  const db = linToDb(lin);
  if (db <= -60) return 0;
  if (db >= 0) return 1;
  return db > -18 ? 0.55 + ((db + 18) / 18) * 0.45 : ((db + 60) / 42) * 0.55;
}

function Meter(scope, bank, index) {
  const bar = el('div', { class: 'meter-bar' });
  const peak = el('div', { class: 'meter-peak' });
  const clip = el('div', { class: 'meter-clip', title: 'Clip (click to reset)' });
  const m = el('div', { class: 'meter' }, [clip, el('div', { class: 'meter-well' }, [bar, peak])]);
  const rec = { bar, peak, clip, bank, index, level: 0, peakLevel: 0, peakAt: 0, clipped: false };
  clip.addEventListener('click', (e) => {
    e.stopPropagation();
    rec.clipped = false;
    clip.classList.remove('on');
  });
  meterEls.add(rec);
  scope.add(() => meterEls.delete(rec));
  return m;
}

function frameLoop(now) {
  for (const r of meterEls) {
    const raw = meterValues[r.bank][r.index] || 0;
    const target = meterPos(raw);
    r.level = target > r.level ? target : Math.max(target, r.level - 0.02);
    if (r.level >= r.peakLevel || now - r.peakAt > 1500) {
      r.peakLevel = r.level;
      r.peakAt = now;
    }
    if (raw >= 0.98 && !r.clipped) { // same threshold as the clip alert
      r.clipped = true;
      r.clip.classList.add('on');
    }
    r.bar.style.clipPath = `inset(${(1 - r.level) * 100}% 0 0 0)`;
    r.peak.style.bottom = `${r.peakLevel * 100}%`;
    r.peak.style.opacity = r.peakLevel > 0.02 ? 1 : 0;
  }
  for (const fn of frameTasks) fn(now);
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

function onFrame(scope, fn) {
  frameTasks.add(fn);
  scope.add(() => frameTasks.delete(fn));
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
// Shared drag handling for every control: left button only, pointer capture,
// and window-level release, so a re-render in the middle of a drag can never
// leave a value stuck ignoring the console. The value is re-read afterwards.
function beginDrag(e, target, paths, onMove) {
  if (e.button !== 0) return false;
  e.preventDefault();
  try {
    target.setPointerCapture(e.pointerId);
  } catch {
    /* element may already be gone */
  }
  for (const p of paths) dragging.add(p);
  const move = (ev) => {
    if (ev.pointerId === e.pointerId) onMove(ev);
  };
  let ended = false;
  const end = (ev) => {
    if (ended || (ev && ev.pointerId !== undefined && ev.pointerId !== e.pointerId)) return;
    ended = true;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    target.removeEventListener('lostpointercapture', end);
    for (const p of paths) dragging.delete(p);
    const real = paths.filter((p) => !p.startsWith('local:'));
    if (real.length) setTimeout(() => load(real), 300);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  target.addEventListener('lostpointercapture', end);
  return true;
}

const FADER_TICKS = [10, 5, 0, -5, -10, -20, -30, -50];

function Fader(scope, path) {
  const cap = el('div', { class: 'fader-cap' });
  const scale = el('div', { class: 'fader-scale' }, [
    ...FADER_TICKS.map((db) => el('span', { class: db === 0 ? 'zero' : '', style: `--y:${X32.dbToFader(db)}`, text: db > 0 ? `+${db}` : String(db) })),
    el('span', { style: '--y:0', text: '∞' }),
  ]);
  const track = el('div', { class: 'fader-track' }, [el('div', { class: 'fader-slot' }), cap]);
  const f = el('div', { class: 'fader', tabindex: 0, role: 'slider', 'aria-valuemin': 0, 'aria-valuemax': 1, title: 'Drag up/down · mouse wheel moves 0.5 dB · right-click for 0 dB, −10, off…' }, [scale, track]);
  let value = 0;
  scope.watch(path, (v) => {
    value = typeof v === 'number' ? v : 0;
    f.style.setProperty('--v', value);
    f.setAttribute('aria-valuetext', `${X32.fmtDb(X32.faderToDb(value))} dB`);
  });
  const commit = (v) => {
    if (known(path)) setParam(path, clamp01(v));
  };

  // Grabbing a fader only moves it: it never selects the strip or changes the layout.
  f.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    f.focus();
    if (!known(path)) return e.preventDefault();
    const startY = e.clientY;
    const startV = value;
    const h = Math.max(40, track.clientHeight - cap.offsetHeight);
    beginDrag(e, f, [path], (ev) => commit(startV + ((startY - ev.clientY) / h) * (ev.shiftKey ? 0.15 : 1)));
  });
  f.addEventListener('contextmenu', (e) => {
    if (known(path)) showMenu(e, 'Set level', levelMenu(path, 'off'));
  });
  f.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (known(path)) commit(stepFaderDb(value, -Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 0.5)));
  }, { passive: false });
  f.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.001 : 0.01;
    if (e.key === 'ArrowUp') commit(value + step);
    else if (e.key === 'ArrowDown') commit(value - step);
    else return;
    e.preventDefault();
  });
  return f;
}

// Compact horizontal pan bar that fills from center.
function PanBar(scope, path) {
  const fill = el('div', { class: 'pan-fill' });
  const bar = el('div', { class: 'pan', title: 'Pan · drag or mouse wheel · right-click to center' }, [fill, el('div', { class: 'pan-center' })]);
  let value = 0.5;
  scope.watch(path, (v) => {
    value = typeof v === 'number' ? v : 0.5;
    const left = Math.min(value, 0.5);
    fill.style.left = `${left * 100}%`;
    fill.style.width = `${Math.abs(value - 0.5) * 100}%`;
    bar.title = `Pan ${X32.PARAMS.pan.display(value)}`;
  });
  bar.addEventListener('pointerdown', (e) => {
    if (!known(path)) return;
    const startX = e.clientX;
    const startV = value;
    const w = Math.max(20, bar.clientWidth);
    beginDrag(e, bar, [path], (ev) => setParam(path, clamp01(startV + (ev.clientX - startX) / (w * 1.5))));
  });
  bar.addEventListener('contextmenu', (e) => {
    if (!known(path)) return;
    showMenu(e, 'Pan', [
      { label: 'Center', action: () => setParam(path, 0.5) },
      { label: 'Left', action: () => setParam(path, 0) },
      { label: 'Right', action: () => setParam(path, 1) },
    ]);
  });
  bar.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (known(path)) setParam(path, clamp01(value - Math.sign(e.deltaY) * 0.02));
  }, { passive: false });
  return bar;
}

// Rotary knob for a normalized 0..1 parameter.
// `steps` makes the knob select one of N integer values (stored as 0..N-1).
function Knob(scope, path, role, { label, def = 0.5, size = 46, steps = 0 } = {}) {
  const d = X32.PARAMS[role];
  const arc = el('div', { class: 'knob-arc' });
  const knob = el('div', { class: 'knob', tabindex: 0, style: `--size:${size}px` }, [arc, el('div', { class: 'knob-cap' }, [el('div', { class: 'knob-pointer' })])]);
  const out = el('div', { class: 'knob-val' });
  const toKnob = (raw) => (steps ? raw / (steps - 1) : raw);
  const set = (_p, k) => {
    if (!known(path)) return;
    const raw = steps ? Math.round(k * (steps - 1)) : k;
    if (!steps || raw !== state.get(path)) setParam(path, raw);
  };
  let value = 0;
  scope.watch(path, (v) => {
    value = typeof v === 'number' ? toKnob(v) : 0;
    knob.style.setProperty('--v', value);
    out.textContent = typeof v === 'number' ? d.display(value) : '—';
  });
  const setParamK = set;
  knob.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    knob.focus();
    if (!known(path)) return e.preventDefault();
    const startY = e.clientY;
    const startV = value;
    beginDrag(e, knob, [path], (ev) => setParamK(path, clamp01(startV + (startY - ev.clientY) / (ev.shiftKey ? 800 : 180))));
  });
  const fine = steps ? 1 / (steps - 1) : 0.002;
  const coarse = steps ? 1 / (steps - 1) : 0.01;
  knob.addEventListener('contextmenu', (e) => {
    if (known(path)) showMenu(e, label || d.label, [{ label: `Reset (${d.display(def)})`, action: () => setParamK(path, def) }]);
  });
  // The wheel turns a knob only after it was clicked, so scrolling the panel
  // past a row of knobs never changes them.
  knob.addEventListener('wheel', (e) => {
    if (document.activeElement !== knob) return;
    e.preventDefault();
    setParamK(path, clamp01(value - Math.sign(e.deltaY) * (e.shiftKey ? fine : coarse)));
  }, { passive: false });
  knob.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? fine : coarse;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setParamK(path, clamp01(value + step));
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setParamK(path, clamp01(value - step));
    else return;
    e.preventDefault();
  });
  return el('div', { class: 'knob-wrap', title: 'Drag up/down · click it, then use the mouse wheel · right-click to reset' }, [el('div', { class: 'knob-label', text: label || d.label }), knob, out]);
}

// Horizontal slider row (used for sends and FX parameters).
function Slider(scope, path, role, { label, def = 0.5 } = {}) {
  const d = X32.PARAMS[role];
  const input = el('input', { type: 'range', min: 0, max: 1, step: 0.001 });
  const out = el('output');
  input.addEventListener('input', () => {
    if (known(path)) setParam(path, Number(input.value));
    else input.value = 0.5;
  });
  input.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging.add(path);
    const end = () => {
      dragging.delete(path);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
    };
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  });
  input.title = 'Drag · click it, then use the mouse wheel · right-click for presets';
  input.addEventListener('contextmenu', (e) => {
    if (!known(path)) return;
    showMenu(e, label || d.label, role === 'fader' ? levelMenu(path, 'off') : [{ label: `Reset (${d.display(def)})`, action: () => setParam(path, def) }]);
  });
  input.addEventListener('wheel', (e) => {
    if (document.activeElement !== input) return; // let the panel scroll
    e.preventDefault();
    if (!known(path)) return;
    const v = state.get(path);
    setParam(path, role === 'fader' ? stepFaderDb(v, -Math.sign(e.deltaY) * 0.5) : clamp01(v - Math.sign(e.deltaY) * 0.01));
  }, { passive: false });
  scope.watch(path, (v) => {
    if (typeof v !== 'number') {
      out.textContent = '—';
      return;
    }
    if (!dragging.has(path)) input.value = v;
    out.textContent = d.display(v);
  });
  return el('label', { class: 'slider' }, [el('span', { class: 'slider-label', text: label ?? d.label }), input, out]);
}

function Toggle(scope, path, label, { invert = false, cls = '', title } = {}) {
  const b = el('button', { class: `toggle ${cls}`, text: label, title });
  let v = 0;
  scope.watch(path, (val) => {
    v = val | 0;
    b.classList.toggle('on', invert ? v === 0 : v === 1);
  });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (known(path)) setParam(path, v ? 0 : 1);
  });
  return b;
}

// One bit of an integer bitmask parameter (DCA / mute group assignment).
function BitToggle(scope, path, bit, label) {
  const b = el('button', { class: 'toggle bit', text: label });
  let v = 0;
  scope.watch(path, (val) => {
    v = val | 0;
    b.classList.toggle('on', (v & (1 << bit)) !== 0);
  });
  b.addEventListener('click', () => known(path) && setParam(path, v ^ (1 << bit)));
  return b;
}

function Select(scope, path, options, label) {
  const s = el('select', {}, options.map((o, i) => el('option', { value: i, text: o })));
  s.addEventListener('change', () => {
    if (known(path)) setParam(path, Number(s.value));
    else if (typeof state.get(path) === 'number') s.value = state.get(path);
  });
  scope.watch(path, (v) => {
    s.disabled = typeof v !== 'number';
    if (typeof v === 'number') s.value = v;
  });
  return el('label', { class: 'select' }, [label ? el('span', { class: 'slider-label', text: label }) : null, s]);
}

function NameLabel(scope, s) {
  const span = el('span', { class: 'strip-name', title: 'Double-click to rename' });
  scope.watch(s.name, () => {
    span.textContent = nameOf(s);
  });
  span.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    span.startRename();
  });
  span.startRename = () => {
    if (!span.isConnected) return;
    const input = el('input', { class: 'rename', value: state.get(s.name) || '', maxlength: 12 });
    let finished = false;
    const done = (save) => {
      if (finished) return;
      finished = true;
      const next = input.value.slice(0, 12);
      if (save && known(s.name) && next !== (state.get(s.name) || '')) setParam(s.name, next);
      if (input.isConnected) input.replaceWith(span);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') done(true);
      if (ev.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    scope.add(() => {
      finished = true; // strip re-rendered: drop the half-typed name
    });
    span.replaceWith(input);
    input.focus();
    input.select();
  };
  return span;
}

function stripMenu(e, s, nameEl) {
  const items = [];
  if (s.kind !== 'dca') {
    if (s.caps.eqBands) items.push({ label: 'Open EQ', action: () => select(s.id, 'eq') });
    if (s.caps.preamp || s.caps.source) items.push({ label: 'Open input / gain', action: () => select(s.id, 'input') });
    if (s.caps.dyn) items.push({ label: 'Open compressor', action: () => select(s.id, 'dyn') });
    items.push('sep');
  }
  items.push({ label: 'Rename…', action: () => nameEl.startRename() });
  X32.COLOR_NAMES.forEach((n, i) => items.push({ label: `Color: ${n}`, swatch: X32.COLORS[i], checked: (state.get(s.color) | 0) % 8 === i, action: () => setParam(s.color, i) }));
  if (s.kind !== 'dca') {
    items.push('sep', { label: 'Copy settings', action: () => copyStrip(s) });
    if (canPasteTo(s)) {
      items.push({ label: `Paste settings from ${clipboard.from}`, action: () => pasteStrip(s) });
    }
  }
  showMenu(e, nameOf(s), items);
}

// ---------------------------------------------------------------------------
// EQ drawing helpers
// ---------------------------------------------------------------------------
const eqPaths = (s) => {
  const out = [`${s.prefix}/eq/on`];
  for (let b = 1; b <= s.caps.eqBands; b++) for (const k of ['type', 'f', 'g', 'q']) out.push(`${s.prefix}/eq/${b}/${k}`);
  if (s.kind === 'ch') out.push(`${s.prefix}/preamp/hpon`, `${s.prefix}/preamp/hpf`);
  return out;
};

function eqBandsReal(s) {
  const p = s.prefix;
  const out = [];
  for (let b = 1; b <= s.caps.eqBands; b++) {
    out.push({
      b,
      type: state.get(`${p}/eq/${b}/type`) ?? 2,
      f: X32.PARAMS.eqF.map.toUnit(state.get(`${p}/eq/${b}/f`) ?? 0.5),
      g: X32.PARAMS.eqG.map.toUnit(state.get(`${p}/eq/${b}/g`) ?? 0.5),
      q: X32.PARAMS.eqQ.map.toUnit(state.get(`${p}/eq/${b}/q`) ?? 0.5),
    });
  }
  return out;
}

function eqActiveFilters(s) {
  const eqOn = (state.get(`${s.prefix}/eq/on`) ?? 1) === 1;
  const active = eqOn ? eqBandsReal(s) : [];
  if (s.kind === 'ch' && state.get(`${s.prefix}/preamp/hpon`) === 1) {
    active.push({ type: 0, f: X32.PARAMS.hpf.map.toUnit(state.get(`${s.prefix}/preamp/hpf`) ?? 0), g: 0, q: 0.7 });
  }
  return { eqOn, active };
}

const xOfF = (f, w) => (Math.log(f / 20) / Math.log(1000)) * w;
const fOfX = (x, w) => 20 * Math.pow(1000, x / w);

function prepCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}

function drawCurve(ctx, w, h, s, range, { stroke, fill, lineWidth }) {
  const { eqOn, active } = eqActiveFilters(s);
  const N = Math.max(48, Math.round(w / 2));
  const freqs = Array.from({ length: N }, (_, i) => fOfX((i / (N - 1)) * w, w));
  const resp = EQMath.response(active, freqs);
  const yOf = (db) => h / 2 - (Math.max(-range * 1.6, Math.min(range * 1.6, db)) / range) * (h / 2);
  ctx.beginPath();
  resp.forEach((db, i) => {
    const x = (i / (N - 1)) * w;
    if (i === 0) ctx.moveTo(x, yOf(db));
    else ctx.lineTo(x, yOf(db));
  });
  ctx.strokeStyle = eqOn ? stroke : 'rgba(255,255,255,0.25)';
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.lineTo(w, h / 2);
  ctx.lineTo(0, h / 2);
  ctx.closePath();
  ctx.fillStyle = eqOn ? fill : 'rgba(255,255,255,0.03)';
  ctx.fill();
}

function EqThumb(scope, s, onClick) {
  const canvas = el('canvas', { class: 'strip-thumb', title: 'EQ · click to edit' });
  let dirty = true;
  scope.watchAll(eqPaths(s), () => {
    dirty = true;
  });
  onFrame(scope, () => {
    if (!dirty) return;
    const g = prepCanvas(canvas);
    if (!g) return;
    dirty = false;
    g.ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    g.ctx.beginPath();
    g.ctx.moveTo(0, g.h / 2);
    g.ctx.lineTo(g.w, g.h / 2);
    g.ctx.stroke();
    drawCurve(g.ctx, g.w, g.h, s, 15, { stroke: '#4fd1c5', fill: 'rgba(79,209,197,0.18)', lineWidth: 1.25 });
  });
  const ro = new ResizeObserver(() => {
    dirty = true; // e.g. after changing the screen size
  });
  ro.observe(canvas);
  scope.add(() => ro.disconnect());
  canvas.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return canvas;
}

// ---------------------------------------------------------------------------
// Channel strip
// ---------------------------------------------------------------------------
let selectedId = null;
const selectListeners = new Set();
function select(id, tab) {
  if (tab) detailTab = tab;
  selectedId = id;
  for (const fn of selectListeners) fn(id);
}

function groupMuted(s) {
  if (!s.grpMute) return false;
  const mask = state.get(s.grpMute) | 0;
  for (let g = 1; g <= X32.MUTE_GROUPS; g++) if (mask & (1 << (g - 1)) && state.get(X32.muteGroupPath(g)) === 1) return true;
  return false;
}

function DynBadges(scope, s) {
  const items = [];
  if (s.caps.preamp) items.push(Toggle(scope, `${s.prefix}/preamp/invert`, 'Ø', { cls: 'badge', title: 'Polarity invert' }));
  if (s.kind === 'ch') items.push(Toggle(scope, `${s.prefix}/preamp/hpon`, 'LC', { cls: 'badge', title: 'Low cut' }));
  if (s.caps.gate) items.push(Toggle(scope, `${s.prefix}/gate/on`, 'G', { cls: 'badge', title: 'Gate' }));
  if (s.caps.dyn) items.push(Toggle(scope, `${s.prefix}/dyn/on`, 'C', { cls: 'badge', title: 'Compressor' }));
  const row = el('div', { class: 'strip-badges' }, items);
  if (s.kind === 'ch') {
    const gr = el('div', { class: 'gr-mini' }, [el('div', { class: 'gr-mini-bar' })]);
    const bar = gr.firstChild;
    const idx = 64 + s.n - 1;
    onFrame(scope, () => {
      const v = meterValues[1][idx];
      const db = typeof v === 'number' && v > 0 ? Math.min(0, 20 * Math.log10(v)) : 0;
      bar.style.width = `${Math.min(100, (-db / 20) * 100)}%`;
    });
    return el('div', {}, [row, gr]);
  }
  return row;
}

/**
 * mode: {fader, on, sendTo?} lets the same strip drive a send level (monitor mixes).
 */
function Strip(scope, s, mode = {}) {
  const faderPath = mode.fader || s.fader;
  const onPath = mode.on || s.on;
  const isDca = s.kind === 'dca';
  const selectable = !isDca;
  const nameEl = NameLabel(scope, s);
  const head = el('div', { class: 'strip-head', title: 'Click to select · right-click for rename, color, copy/paste' }, [el('span', { class: 'strip-num', text: s.shortLabel }), nameEl]);
  head.addEventListener('contextmenu', (e) => stripMenu(e, s, nameEl));
  scope.watch(s.color, (c) => {
    const ci = c | 0;
    head.style.setProperty('--strip-color', X32.colorOf(ci));
    head.classList.toggle('inverted', ci >= 8);
  });

  const meter =
    s.kind === 'main'
      ? el('div', { class: 'meter-pair' }, [Meter(scope, 2, 22), Meter(scope, 2, 23)])
      : s.meter
        ? Meter(scope, s.meter[0], s.meter[1])
        : el('div', { class: 'meter meter-none' });

  const dbOut = el('div', { class: 'strip-db' });
  scope.watch(faderPath, (v) => {
    dbOut.textContent = typeof v === 'number' ? X32.fmtDb(X32.faderToDb(v)) : '—';
  });

  const thumb = s.caps.eqBands ? EqThumb(scope, s, () => select(s.id, 'eq')) : el('div', { class: 'strip-thumb empty', text: isDca ? 'DCA' : '' });
  const badges = s.caps.dca ? el('div', { class: 'strip-badges' }) : DynBadges(scope, s);
  const pan = s.pan && !mode.sendTo ? PanBar(scope, s.pan) : el('div', { class: 'pan pan-none' });

  // In a monitor mix the button is the send's on/off: lit green "ON" when the
  // channel is in the mix (an unlit "OFF" read as if the send were off).
  const mute = mode.sendTo
    ? Toggle(scope, onPath, 'ON', { cls: 'send-on', title: 'Is this channel in the mix? Click to take it out / put it back' })
    : Toggle(scope, onPath, 'MUTE', { invert: true, cls: 'mute' });
  if (!mode.sendTo && s.grpMute) {
    const paths = [s.grpMute, ...Array.from({ length: X32.MUTE_GROUPS }, (_, g) => X32.muteGroupPath(g + 1))];
    scope.watchAll(paths, () => mute.classList.toggle('grp', groupMuted(s)));
  }
  const solo = Toggle(scope, s.solo, 'S', { cls: 'solo', title: 'Solo' });
  const selBtn = selectable ? el('button', { class: 'toggle sel', text: 'SEL', onclick: () => select(selectedId === s.id ? null : s.id) }) : null;

  const root = el('div', { class: `strip strip-${s.kind}${mode.sendTo ? ' strip-send' : ''}`, 'data-strip': s.id }, [
    head,
    mode.sendTo ? el('div', { class: `strip-tag${mode.tag ? '' : ' none'}`, text: mode.tag || '—', title: mode.tag ? `In mix DCA ${mode.tag}` : '' }) : null,
    thumb,
    badges,
    pan,
    el('div', { class: 'strip-body' }, [meter, Fader(scope, faderPath)]),
    dbOut,
    mute,
    el('div', { class: 'btn-row' }, [solo, selBtn]),
  ]);
  if (selectable) {
    const upd = (id) => {
      root.classList.toggle('selected', id === s.id);
      selBtn.classList.toggle('on', id === s.id);
    };
    selectListeners.add(upd);
    scope.add(() => selectListeners.delete(upd));
    upd(selectedId);
    head.addEventListener('click', () => select(s.id));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Mixer view: layers, custom layer, mute groups, solo
// ---------------------------------------------------------------------------
const loadJson = (k, d) => {
  try {
    return JSON.parse(store.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
let customLayer = loadJson('customLayer', ['ch1', 'ch2', 'ch9', 'bus1', 'dca1']);

const LAYERS = [
  { id: 'in1', label: 'Ch 1–16', strips: () => X32.strips('ch').slice(0, 16) },
  { id: 'in2', label: 'Ch 17–32', strips: () => X32.strips('ch').slice(16) },
  { id: 'all32', label: 'All 32', strips: () => X32.strips('ch') },
  { id: 'aux', label: 'Aux / FX', strips: () => [...X32.strips('auxin'), ...X32.strips('fxrtn')] },
  { id: 'bus', label: 'Buses', strips: () => X32.strips('bus') },
  { id: 'mtx', label: 'Matrix', strips: () => X32.strips('mtx') },
  { id: 'dca', label: 'DCA', strips: () => X32.strips('dca') },
  { id: 'custom', label: '★ Custom', strips: () => customLayer.map((id) => X32.STRIP_BY_ID[id]).filter(Boolean) },
];

let mixerScope = makeScope();
let barScope = makeScope();
let currentLayer = store.getItem('layer') || 'in1';

function renderLayerBar() {
  barScope.dispose();
  barScope = makeScope();
  const layers = LAYERS.map((l) =>
    el('button', {
      class: l.id === currentLayer ? 'active' : '',
      text: l.label,
      onclick: () => {
        currentLayer = l.id;
        store.setItem('layer', l.id);
        renderLayerBar();
        renderMixer();
      },
    }),
  );
  if (currentLayer === 'custom') layers.push(el('button', { class: 'ghost', text: 'Edit…', onclick: openCustomEditor }));

  const mgs = [];
  for (let g = 1; g <= X32.MUTE_GROUPS; g++) mgs.push(Toggle(barScope, X32.muteGroupPath(g), String(g), { cls: 'mg', title: `Mute group ${g}` }));
  const clear = el('button', { class: 'toggle clear-solo', text: 'CLEAR SOLO', onclick: () => command('/-action/clearsolo', [int(1)]) });
  barScope.watch('/-stat/solo', (v) => clear.classList.toggle('on', v === 1));

  $('layerbar').replaceChildren(
    el('div', { class: 'layer-group' }, layers),
    el('div', { class: 'layer-group right' }, [el('span', { class: 'bar-label', text: 'MUTE GRP' }), ...mgs, clear]),
  );
}

function renderMixer() {
  mixerScope.dispose();
  mixerScope = makeScope();
  const layer = LAYERS.find((l) => l.id === currentLayer) || LAYERS[0];
  const strips = layer.strips();
  $('view-mixer').classList.toggle('fit32', layer.id === 'all32');
  const pinned = [X32.STRIP_BY_ID.mono1, X32.STRIP_BY_ID.main1];
  load([...strips, ...pinned].flatMap((s) => X32.stripViewPaths(s)));
  $('mixerStrips').replaceChildren(
    ...(strips.length ? strips.map((s) => Strip(mixerScope, s)) : [el('div', { class: 'empty-note', text: 'Your custom layer is empty. Click “Edit…” to pick strips.' })]),
  );
  $('mixerPinned').replaceChildren(...pinned.map((s) => Strip(mixerScope, s)));
}

function openCustomEditor() {
  const chosen = new Set(customLayer);
  const groups = ['ch', 'auxin', 'fxrtn', 'bus', 'mtx', 'dca'].map((kind) =>
    el('div', { class: 'pick-group' }, [
      el('div', { class: 'pick-title', text: { ch: 'Channels', auxin: 'Aux in', fxrtn: 'FX returns', bus: 'Buses', mtx: 'Matrix', dca: 'DCA' }[kind] }),
      el(
        'div',
        { class: 'pick-grid' },
        X32.strips(kind).map((s) => {
          const b = el('button', { class: `toggle pick${chosen.has(s.id) ? ' on' : ''}`, text: nameOf(s) });
          b.addEventListener('click', () => {
            if (chosen.has(s.id)) chosen.delete(s.id);
            else chosen.add(s.id);
            b.classList.toggle('on', chosen.has(s.id));
          });
          return b;
        }),
      ),
    ]),
  );
  const close = () => dlg.remove();
  const dlg = el('div', { class: 'modal-back', onclick: (e) => e.target === dlg && close() }, [
    el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [el('strong', { text: 'Custom layer' }), el('span', { class: 'hint', text: 'Strips appear in console order.' })]),
      el('div', { class: 'modal-body' }, groups),
      el('div', { class: 'modal-foot' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          class: 'primary',
          text: 'Save layer',
          onclick: () => {
            customLayer = X32.ALL_STRIPS.filter((s) => chosen.has(s.id)).map((s) => s.id);
            store.setItem('customLayer', JSON.stringify(customLayer));
            close();
            renderMixer();
          },
        }),
      ]),
    ]),
  ]);
  document.body.append(dlg);
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------
let detailScope = makeScope();
let detailTab = store.getItem('detailTab') || 'eq';
let clipboard = null; // {kind, from, values: Map(suffix -> value)}

selectListeners.add((id) => renderDetail(id));

// Wait (briefly) until the console has reported all of these values.
async function loadAll(paths, ms = 2500) {
  await load(paths);
  const start = Date.now();
  while (!paths.every((p) => known(p)) && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 100));
  return paths.every((p) => known(p));
}

// Copy reads every setting from the console first (the panel may never have
// been opened), so the clipboard is always complete or nothing.
async function copyStrip(s) {
  const sufs = X32.copyableSuffixes(s);
  if (!(await loadAll(sufs.map((suf) => s.prefix + suf)))) return toast(`Couldn't read all of ${nameOf(s)}'s settings; try again`);
  clipboard = { kind: s.kind, from: nameOf(s), values: new Map(sufs.map((suf) => [suf, state.get(s.prefix + suf)])) };
  toast(`Copied ${nameOf(s)}'s EQ, gate, compressor and input settings`);
  if (selectedId) renderDetail(selectedId); // refresh the Paste button
}

const canPasteTo = (s) => clipboard && clipboard.kind === s.kind && clipboard.from !== undefined;

function pasteStrip(s) {
  if (!canPasteTo(s)) return;
  const sufs = X32.copyableSuffixes(s).filter((suf) => clipboard.values.has(suf));
  confirmDialog(
    `Paste onto ${nameOf(s)}?`,
    `${nameOf(s)} gets ${clipboard.from}'s EQ, gate, compressor, trim, polarity and low cut. Its level, mute, pan, monitor sends, name and input stay as they are.`,
    'Paste',
    async () => {
      if (!(await loadAll(sufs.map((suf) => s.prefix + suf)))) return toast('Not connected, or the console did not answer; nothing pasted');
      for (const suf of sufs) setParam(s.prefix + suf, clipboard.values.get(suf));
      toast(`Pasted ${clipboard.from} onto ${nameOf(s)}`);
    },
  );
}

function renderDetail(id) {
  detailScope.dispose();
  detailScope = makeScope();
  const panel = $('detail');
  const s = X32.STRIP_BY_ID[id];
  if (!s) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  load(X32.detailPaths(s));

  const c = s.caps;
  const tabs = [
    (c.preamp || c.source) && { id: 'input', label: 'Input' },
    c.eqBands && { id: 'eq', label: 'EQ' },
    c.gate && { id: 'gate', label: 'Gate' },
    c.dyn && { id: 'dyn', label: 'Compressor' },
    c.sends && { id: 'sends', label: s.kind === 'bus' || s.kind === 'main' || s.kind === 'mono' ? 'Matrix sends' : 'Bus sends' },
    s.grpDca && { id: 'groups', label: 'Groups' },
  ].filter(Boolean);
  if (!tabs.some((t) => t.id === detailTab)) detailTab = tabs[0]?.id;

  const title = el('div', { class: 'detail-title' });
  const swatch = el('span', { class: 'swatch' });
  const titleName = el('span');
  title.append(swatch, el('span', { class: 'detail-num', text: s.shortLabel }), titleName);
  detailScope.watch(s.name, () => {
    titleName.textContent = nameOf(s);
  });
  detailScope.watch(s.color, (ci) => swatch.style.setProperty('background', X32.colorOf(ci | 0)));

  const body = el('div', { class: 'detail-body' });
  const tabBar = el(
    'div',
    { class: 'detail-tabs' },
    tabs.map((t) =>
      el('button', {
        class: t.id === detailTab ? 'active' : '',
        text: t.label,
        onclick: () => {
          detailTab = t.id;
          store.setItem('detailTab', t.id);
          renderDetail(id);
        },
      }),
    ),
  );
  const canPaste = canPasteTo(s);
  const colorSel = el(
    'select',
    { class: 'color-sel', title: 'Scribble strip color' },
    X32.COLOR_NAMES.flatMap((n, i) => [el('option', { value: i, text: n }), el('option', { value: i + 8, text: `${n} (inv)` })]),
  );
  colorSel.addEventListener('change', () => setParam(s.color, Number(colorSel.value)));
  detailScope.watch(s.color, (v) => {
    if (typeof v === 'number') colorSel.value = v;
  });
  const actions = el('div', { class: 'detail-actions' }, [
    colorSel,
    el('button', { class: 'ghost', text: 'Copy', title: 'Copy this strip’s settings', onclick: () => copyStrip(s) }),
    el('button', { class: 'ghost', text: 'Paste', disabled: !canPaste, title: clipboard ? `Paste settings from ${clipboard.from}` : 'Copy a strip first', onclick: () => pasteStrip(s) }),
    el('button', { class: 'ghost close', text: '✕', title: 'Close', onclick: () => select(null) }),
  ]);
  panel.replaceChildren(el('div', { class: 'detail-head' }, [title, tabBar, actions]), body);

  const p = s.prefix;
  const section = (heading, children, extra = '') => el('div', { class: `section ${extra}` }, [el('div', { class: 'section-title' }, heading), el('div', { class: 'section-body' }, children)]);

  switch (detailTab) {
    case 'input': {
      const parts = [];
      if (X32.haIndexPath(s)) parts.push(HeadampSection(detailScope, s));
      const pre = [];
      if (c.preamp) pre.push(Knob(detailScope, `${p}/preamp/trim`, 'trim', { label: 'Trim' }));
      if (s.kind === 'ch') pre.push(Knob(detailScope, `${p}/preamp/hpf`, 'hpf', { def: 0.31 }));
      if (s.pan) pre.push(Knob(detailScope, s.pan, 'pan'));
      const toggles = [];
      if (c.preamp) toggles.push(Toggle(detailScope, `${p}/preamp/invert`, 'Ø Polarity'));
      if (s.kind === 'ch') toggles.push(Toggle(detailScope, `${p}/preamp/hpon`, 'Low cut'));
      parts.push(section(['Preamp'], [el('div', { class: 'toggle-col' }, toggles), ...pre]));
      body.append(el('div', { class: 'section-row' }, parts));
      break;
    }
    case 'eq':
      body.append(EqEditor(detailScope, s));
      break;
    case 'gate':
      body.append(
        el('div', { class: 'section-row' }, [
          section([Toggle(detailScope, `${p}/gate/on`, 'GATE'), Select(detailScope, `${p}/gate/mode`, X32.ENUMS.gateMode)], [
            Knob(detailScope, `${p}/gate/thr`, 'gateThr', { def: 0 }),
            Knob(detailScope, `${p}/gate/range`, 'gateRange'),
            Knob(detailScope, `${p}/gate/attack`, 'attack'),
            Knob(detailScope, `${p}/gate/hold`, 'hold'),
            Knob(detailScope, `${p}/gate/release`, 'release'),
          ]),
          s.kind === 'ch' ? GainReduction(detailScope, 32 + s.n - 1, 'Gate') : null,
        ]),
      );
      break;
    case 'dyn':
      body.append(
        el('div', { class: 'section-row' }, [
          section(
            [Toggle(detailScope, `${p}/dyn/on`, 'COMP'), Select(detailScope, `${p}/dyn/mode`, X32.ENUMS.dynMode), Select(detailScope, `${p}/dyn/det`, X32.ENUMS.dynDet), Select(detailScope, `${p}/dyn/env`, X32.ENUMS.dynEnv), Toggle(detailScope, `${p}/dyn/auto`, 'AUTO')],
            [
              Knob(detailScope, `${p}/dyn/thr`, 'dynThr', { def: 1 }),
              RatioKnob(detailScope, `${p}/dyn/ratio`),
              Knob(detailScope, `${p}/dyn/knee`, 'knee'),
              Knob(detailScope, `${p}/dyn/mgain`, 'mgain', { def: 0 }),
              Knob(detailScope, `${p}/dyn/attack`, 'attack'),
              Knob(detailScope, `${p}/dyn/hold`, 'hold'),
              Knob(detailScope, `${p}/dyn/release`, 'release'),
              Knob(detailScope, `${p}/dyn/mix`, 'mix', { def: 1 }),
            ],
          ),
          s.kind === 'ch' ? GainReduction(detailScope, 64 + s.n - 1, 'Comp') : null,
        ]),
      );
      break;
    case 'sends': {
      const targets = s.kind === 'bus' || s.kind === 'main' || s.kind === 'mono' ? X32.strips('mtx') : X32.strips('bus');
      body.append(
        el(
          'div',
          { class: 'send-grid' },
          targets.map((t) => {
            const name = el('span', { class: 'send-name' });
            detailScope.watch(t.name, () => {
              name.textContent = nameOf(t);
            });
            return el('div', { class: 'send-row' }, [name, Toggle(detailScope, X32.sendOn(s, t.n), 'ON'), Slider(detailScope, X32.sendLevel(s, t.n), 'fader', { label: '', def: 0.75 })]);
          }),
        ),
      );
      break;
    }
    case 'groups': {
      const dcas = X32.strips('dca').map((d) => {
        const b = BitToggle(detailScope, s.grpDca, d.n - 1, '');
        detailScope.watch(d.name, () => {
          b.textContent = nameOf(d);
        });
        return b;
      });
      const mgs = Array.from({ length: X32.MUTE_GROUPS }, (_, g) => BitToggle(detailScope, s.grpMute, g, `Mute ${g + 1}`));
      body.append(el('div', { class: 'section-row' }, [section(['DCA assignment'], [el('div', { class: 'bit-grid' }, dcas)]), section(['Mute groups'], [el('div', { class: 'bit-grid' }, mgs)])]));
      break;
    }
    default:
      break;
  }
}

// Gain and +48V follow the console's own channel→preamp table (/-ha/NN/index),
// so they always reach the physical preamp that feeds this channel, including
// stage boxes on AES50. The controls are rebuilt only when that preamp changes.
function HeadampSection(scope, s) {
  const controls = el('div', { class: 'section-body' });
  const title = s.source ? el('div', { class: 'section-title' }, [el('span', { text: 'Source' }), Select(scope, s.source, X32.SOURCE_OPTIONS)]) : el('div', { class: 'section-title', text: 'Preamp' });
  const box = el('div', { class: 'section' }, [title, controls]);
  const haPath = X32.haIndexPath(s);
  let inner = makeScope();
  let shown;
  scope.add(() => inner.dispose());
  scope.watch(haPath, (idx) => {
    const next = typeof idx === 'number' ? idx : undefined;
    if (next === shown && controls.childElementCount) return;
    shown = next;
    inner.dispose();
    inner = makeScope();
    if (typeof idx !== 'number') {
      controls.replaceChildren(el('span', { class: 'hint', text: 'Loading…' }));
      return;
    }
    if (idx < 0) {
      controls.replaceChildren(el('span', { class: 'hint', text: 'No preamp feeds this channel (line, USB, FX or bus source).' }));
      return;
    }
    const phantomPath = X32.headampPath(idx, 'phantom');
    load([X32.headampPath(idx, 'gain'), phantomPath]);
    const phantom = el('button', { class: 'toggle phantom', text: '+48V', title: 'Phantom power for this preamp' });
    inner.watch(phantomPath, (v) => phantom.classList.toggle('on', v === 1));
    phantom.addEventListener('click', () => {
      if (!known(phantomPath)) return;
      if (state.get(phantomPath) === 1) return setParam(phantomPath, 0);
      confirmDialog(
        `Turn on +48V phantom power?`,
        `This powers ${X32.headampName(idx)}, which feeds ${nameOf(s)}. Only use it for condenser mics or DI boxes that need it.`,
        'Turn on +48V',
        () => setParam(phantomPath, 1),
      );
    });
    controls.replaceChildren(
      el('div', { class: 'toggle-col' }, [phantom, el('span', { class: 'hint', text: X32.headampName(idx) })]),
      Knob(inner, X32.headampPath(idx, 'gain'), 'headamp', { label: 'Gain', def: 0.1667, size: 56 }),
    );
  });
  return box;
}

function confirmDialog(title, text, okLabel, onOk) {
  const close = () => dlg.remove();
  const dlg = el('div', { class: 'modal-back', onclick: (e) => e.target === dlg && close() }, [
    el('div', { class: 'modal narrow' }, [
      el('div', { class: 'modal-head' }, [el('strong', { text: title })]),
      el('div', { class: 'modal-body' }, [el('div', { text })]),
      el('div', { class: 'modal-foot' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', { class: 'primary', text: okLabel, onclick: () => { close(); onOk(); } }),
      ]),
    ]),
  ]);
  document.body.append(dlg);
}

function RatioKnob(scope, path) {
  const n = X32.ENUMS.ratio.length;
  X32.PARAMS.ratioKnob ||= { label: 'Ratio', display: (v) => X32.ENUMS.ratio[Math.round(v * (n - 1))] + ':1' };
  return Knob(scope, path, 'ratioKnob', { def: 5 / (n - 1), steps: n });
}

// /meters/1 gain reduction (1.0 = no reduction).
function GainReduction(scope, index, label) {
  const bar = el('div', { class: 'gr-bar' });
  const out = el('span', { class: 'gr-val' });
  onFrame(scope, () => {
    const v = meterValues[1][index];
    const db = typeof v === 'number' && v > 0 ? Math.min(0, 20 * Math.log10(v)) : 0;
    bar.style.height = `${Math.min(100, (-db / 30) * 100)}%`;
    out.textContent = db.toFixed(1);
  });
  return el('div', { class: 'section gr' }, [el('div', { class: 'section-title', text: `${label} GR` }), el('div', { class: 'gr-track' }, [bar]), out]);
}

// ---------------------------------------------------------------------------
// EQ editor: response curve with draggable band handles + per-band knobs.
// ---------------------------------------------------------------------------
const BAND_COLORS = ['#ff8a65', '#ffd54f', '#81c784', '#4fc3f7', '#ba68c8', '#f06292'];

function EqEditor(scope, s) {
  const p = s.prefix;
  const nb = s.caps.eqBands;
  const canvas = el('canvas', { class: 'eq-canvas' });
  const fMap = X32.PARAMS.eqF.map;
  const gMap = X32.PARAMS.eqG.map;
  const band = (b, k) => `${p}/eq/${b}/${k}`;
  const yOfG = (g, h) => h / 2 - (g / 18) * (h / 2);
  const gOfY = (y, h) => ((h / 2 - y) / (h / 2)) * 18;
  let dirty = true;
  let hover = null;
  scope.watchAll(eqPaths(s), () => {
    dirty = true;
  });
  const ro = new ResizeObserver(() => {
    dirty = true;
  });
  ro.observe(canvas);
  scope.add(() => ro.disconnect());

  onFrame(scope, () => {
    if (!dirty) return;
    const g = prepCanvas(canvas);
    if (!g) return;
    dirty = false;
    const { ctx, w, h } = g;
    ctx.font = '10px system-ui';
    ctx.lineWidth = 1;
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = xOfF(f, w);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText(X32.fmtHz(f), Math.min(x + 3, w - 24), h - 4);
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = yOfG(db, h);
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 4, y - 3);
    }
    // Per-band contributions, faint
    const bands = eqBandsReal(s);
    const eqOn = (state.get(`${p}/eq/on`) ?? 1) === 1;
    if (eqOn) {
      const N = 120;
      const freqs = Array.from({ length: N }, (_, i) => fOfX((i / (N - 1)) * w, w));
      for (const bd of bands) {
        const r = EQMath.response([bd], freqs);
        ctx.beginPath();
        r.forEach((db, i) => {
          const x = (i / (N - 1)) * w;
          const y = yOfG(Math.max(-30, Math.min(30, db)), h);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = BAND_COLORS[bd.b - 1] + '55';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    drawCurve(ctx, w, h, s, 18, { stroke: '#4fd1c5', fill: 'rgba(79,209,197,0.12)', lineWidth: 2 });
    for (const bd of bands) {
      const x = Math.max(10, Math.min(w - 10, xOfF(bd.f, w))); // keep 20 Hz / 20 kHz points grabbable
      const y = EQMath.hasGain(bd.type) ? yOfG(bd.g, h) : h / 2;
      ctx.beginPath();
      ctx.arc(x, y, hover === bd.b ? 11 : 9, 0, Math.PI * 2);
      ctx.fillStyle = BAND_COLORS[bd.b - 1];
      ctx.globalAlpha = eqOn ? 1 : 0.4;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#111';
      ctx.font = 'bold 11px system-ui';
      ctx.fillText(String(bd.b), x - 3.5, y + 4);
    }
  });

  const hit = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    for (const bd of eqBandsReal(s)) {
      const bx = Math.max(10, Math.min(r.width - 10, xOfF(bd.f, r.width)));
      const by = EQMath.hasGain(bd.type) ? yOfG(bd.g, r.height) : r.height / 2;
      const d = Math.hypot(bx - x, by - y);
      if (d < 16 && (!best || d < best.d)) best = { ...bd, d };
    }
    return best;
  };
  canvas.addEventListener('pointermove', (e) => {
    const bd = hit(e);
    const nh = bd ? bd.b : null;
    if (nh !== hover) {
      hover = nh;
      dirty = true;
      canvas.style.cursor = bd ? 'grab' : 'crosshair';
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    const bd = hit(e);
    if (!bd) return;
    const fp = band(bd.b, 'f');
    const gp = band(bd.b, 'g');
    if (!known(fp) || !known(gp) || !known(band(bd.b, 'type'))) return;
    // Keep the point where it was grabbed: move by how far the mouse moves,
    // not to the mouse position (grabbing a point's edge must not jump it).
    const r0 = canvas.getBoundingClientRect();
    const startX = xOfF(bd.f, r0.width);
    const startY = EQMath.hasGain(bd.type) ? yOfG(bd.g, r0.height) : r0.height / 2;
    beginDrag(e, canvas, [fp, gp], (ev) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, startX + ev.clientX - e.clientX));
      const y = Math.max(0, Math.min(r.height, startY + ev.clientY - e.clientY));
      setParam(fp, fMap.fromUnit(fOfX(x, r.width)));
      if (EQMath.hasGain(bd.type)) setParam(gp, gMap.fromUnit(Math.max(-15, Math.min(15, gOfY(y, r.height)))));
    });
  });
  canvas.addEventListener('wheel', (e) => {
    const bd = hit(e);
    if (!bd) return;
    e.preventDefault();
    const qp = band(bd.b, 'q');
    if (known(qp)) setParam(qp, clamp01(state.get(qp) + Math.sign(e.deltaY) * 0.02));
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => {
    const bd = hit(e);
    if (!bd || !known(band(bd.b, 'g'))) return;
    showMenu(e, `Band ${bd.b}`, [
      { label: 'Flat (0 dB gain)', action: () => setParam(band(bd.b, 'g'), 0.5) },
      { label: 'Normal width (Q 2.0)', action: () => known(band(bd.b, 'q')) && setParam(band(bd.b, 'q'), 0.46) },
      'sep',
      ...X32.ENUMS.eqType.map((t, i) => ({ label: t, checked: state.get(band(bd.b, 'type')) === i, action: () => known(band(bd.b, 'type')) && setParam(band(bd.b, 'type'), i) })),
    ]);
  });

  const bandCols = [];
  for (let b = 1; b <= nb; b++) {
    bandCols.push(
      el('div', { class: 'eq-band', style: `--band:${BAND_COLORS[b - 1]}` }, [
        el('div', { class: 'eq-band-title' }, [el('span', { text: String(b) }), Select(scope, band(b, 'type'), X32.ENUMS.eqType)]),
        el('div', { class: 'eq-knobs' }, [
          Knob(scope, band(b, 'g'), 'eqG', { size: 40 }),
          Knob(scope, band(b, 'f'), 'eqF', { size: 40 }),
          Knob(scope, band(b, 'q'), 'eqQ', { size: 40, def: 0.46 }),
        ]),
      ]),
    );
  }
  const side = [Toggle(scope, `${p}/eq/on`, 'EQ')];
  if (s.kind === 'ch') side.push(Toggle(scope, `${p}/preamp/hpon`, 'LOW CUT'), Knob(scope, `${p}/preamp/hpf`, 'hpf', { size: 40, def: 0.31 }));
  return el('div', { class: 'eq' }, [
    el('div', { class: 'hint', text: 'Drag a numbered point to change frequency and gain · scroll on it to change width · right-click it for more' }),
    el('div', { class: 'eq-main' }, [el('div', { class: 'eq-side' }, side), canvas]),
    el('div', { class: 'eq-bands' }, bandCols),
  ]);
}

// ---------------------------------------------------------------------------
// Monitor mixes (sends on faders)
// ---------------------------------------------------------------------------
let sendScope = makeScope();
let busScope = makeScope();
let currentBus = Number(store.getItem('bus')) || 1;
const SEND_SOURCES = () => [...X32.strips('ch'), ...X32.strips('auxin'), ...X32.strips('fxrtn')];

// ---------------------------------------------------------------------------
// Mix groups: per-bus DCAs and mute groups that exist only in this app.
// They act by changing the channels' send levels / send on to that bus, and
// only when the user touches a group control.
//
// Mix DCA: each member has a "base" send level (dB); member level = base + group
// offset. A channel can be in several mix DCAs; their offsets add up (in dB), as
// DCAs do on the console. If a member's send changes for any other reason (its
// own fader here, the console, another app), its base is re-learned, so the group
// never fights manual moves and members keep their balance through the bottom of
// the throw.
//
// Mute: a send is turned off while any muted group (DCA or mute group) contains
// it. Its previous on/off is saved and restored when no muting group remains.
// ---------------------------------------------------------------------------
const MIX_DCA_MAX = 8;
const MIX_MUTE_MAX = 6;
let mixData = loadJson('mixGroups', {});
function busGroups(bus) {
  mixData[bus] ||= { dcas: [], mutes: [], savedOn: {}, base: {} };
  return mixData[bus];
}
const saveMix = () => store.setItem('mixGroups', JSON.stringify(mixData));
const srcStrip = (id) => X32.STRIP_BY_ID[id];
const toStoredDb = (db) => (db === -Infinity ? null : db);
const fromStoredDb = (v) => (v === null || v === undefined ? -Infinity : v);
const groupLevel = (base, offset) => X32.dbToFader(Math.min(10, base + offset));
const newId = () => Math.random().toString(36).slice(2, 9);

function mutedMembers(g) {
  const out = new Set();
  for (const grp of [...g.dcas, ...g.mutes]) if (grp.muted) grp.members.forEach((m) => out.add(m));
  return out;
}

// Bring sends in line with group mutes. Idempotent, so it also runs every second
// to finish anything that couldn't be done yet (send not loaded, console away):
// - a muted member not yet saved: remember its on/off, then turn it off (once;
//   if someone turns it back on by hand while muted, that is respected);
// - a saved member no longer muted by any group: put its on/off back, and only
//   then forget it.
function reconcileMutes(bus) {
  const g = busGroups(bus);
  const muted = mutedMembers(g);
  let changed = false;
  for (const id of muted) {
    if (id in g.savedOn) continue;
    const p = X32.sendOn(srcStrip(id), bus);
    if (!known(p)) continue;
    g.savedOn[id] = state.get(p);
    if (state.get(p) !== 0) setParam(p, 0);
    changed = true;
  }
  for (const id of Object.keys(g.savedOn)) {
    if (muted.has(id)) continue;
    const p = X32.sendOn(srcStrip(id), bus);
    if (!known(p)) continue;
    if (state.get(p) !== g.savedOn[id]) setParam(p, g.savedOn[id]);
    delete g.savedOn[id];
    changed = true;
  }
  if (changed) saveMix();
}
setInterval(() => {
  if (connState !== 'connected') return;
  for (const bus of Object.keys(mixData)) {
    const g = mixData[bus];
    const ids = new Set([...mutedMembers(g), ...Object.keys(g.savedOn || {})]);
    if (!ids.size) continue;
    const missing = [...ids].map((id) => X32.sendOn(srcStrip(id), Number(bus))).filter((p) => !state.has(p));
    if (missing.length) load(missing);
    reconcileMutes(Number(bus));
  }
}, 1000);

// Combined offset (dB) of every mix DCA holding this channel.
const dcaOffset = (g, id) => g.dcas.reduce((sum, d) => (d.members.includes(id) ? sum + X32.faderToDb(d.pos) : sum), 0);
const dcaMembers = (g) => new Set(g.dcas.flatMap((d) => d.members));

function learnBase(bus, id) {
  const g = busGroups(bus);
  const p = X32.sendLevel(srcStrip(id), bus);
  const offset = dcaOffset(g, id);
  if (!known(p) || offset === -Infinity) return;
  g.base[id] = toStoredDb(X32.faderToDb(state.get(p)) - offset);
}

// User moved a mix DCA fader.
function moveMixDca(bus, d, pos) {
  const g = busGroups(bus);
  for (const id of d.members) if (!(id in g.base)) learnBase(bus, id);
  d.pos = pos;
  for (const id of d.members) {
    const p = X32.sendLevel(srcStrip(id), bus);
    if (!known(p) || !(id in g.base) || dragging.has(p)) continue;
    const v = groupLevel(fromStoredDb(g.base[id]), dcaOffset(g, id));
    if (Math.abs(v - state.get(p)) > 1e-6) setParam(p, v);
  }
  saveMix();
}

// Re-learn a member's base when its send changes from anywhere but its groups.
function trackMixDcaMembers(scope, bus) {
  const g = busGroups(bus);
  for (const id of dcaMembers(g)) {
    const p = X32.sendLevel(srcStrip(id), bus);
    scope.watch(p, (v) => {
      if (typeof v !== 'number') return;
      const offset = dcaOffset(g, id);
      if (id in g.base && Math.abs(groupLevel(fromStoredDb(g.base[id]), offset) - v) < SEND_TOL) return;
      if (dragging.has(p)) return; // re-learn after the drag, not during it
      if (offset === -Infinity) return; // a group fully down: keep the remembered balance
      g.base[id] = toStoredDb(X32.faderToDb(v) - offset);
      saveMix();
    });
  }
}

function MixDcaStrip(scope, bus, d) {
  const path = `local:mixdca/${bus}/${d.id}`;
  apply(path, d.pos);
  localHandlers.set(path, (v) => moveMixDca(bus, d, v));
  scope.add(() => localHandlers.delete(path));
  const g = busGroups(bus);
  const dbOut = el('div', { class: 'strip-db' });
  scope.watch(path, (v) => {
    dbOut.textContent = typeof v === 'number' ? X32.fmtDb(X32.faderToDb(v)) : '—';
  });
  const mute = el('button', { class: `toggle mute${d.muted ? ' on' : ''}`, text: 'MUTE' });
  mute.addEventListener('click', () => {
    if (connState !== 'connected') return toast('Not connected to the console');
    d.muted = !d.muted;
    mute.classList.toggle('on', d.muted);
    reconcileMutes(bus);
  });
  const names = d.members.map((id) => nameOf(srcStrip(id)));
  return el('div', { class: 'strip strip-mixdca', title: names.join(', ') || 'No channels yet' }, [
    el('div', { class: 'strip-head' }, [el('span', { class: 'strip-num', text: 'MIX DCA' }), el('span', { class: 'strip-name', text: d.name })]),
    el('div', { class: 'strip-tag none', text: '—' }),
    el('div', { class: 'strip-thumb empty members', text: `${d.members.length} ch` }),
    el('div', { class: 'strip-badges' }),
    el('div', { class: 'pan pan-none' }),
    el('div', { class: 'strip-body' }, [el('div', { class: 'meter meter-none' }), Fader(scope, path)]),
    dbOut,
    mute,
    el('div', { class: 'btn-row' }, [el('button', { class: 'toggle', style: 'visibility:hidden', tabindex: -1, text: 'S' })]),
  ]);
}

function MixMuteButtons(scope, bus) {
  const g = busGroups(bus);
  return g.mutes.map((m) => {
    const b = el('button', { class: `toggle mg mix-mg${m.muted ? ' on' : ''}`, text: m.name, title: m.members.map((id) => nameOf(srcStrip(id))).join(', ') || 'No channels yet' });
    b.addEventListener('click', () => {
      if (connState !== 'connected') return toast('Not connected to the console');
      m.muted = !m.muted;
      b.classList.toggle('on', m.muted);
      reconcileMutes(bus);
    });
    return b;
  });
}

function openMixGroupEditor(bus) {
  const busStrip = X32.STRIP_BY_ID[`bus${bus}`];
  const g = busGroups(bus);
  const draft = {
    dcas: g.dcas.map((d) => ({ ...d, members: [...d.members] })),
    mutes: g.mutes.map((m) => ({ ...m, members: [...m.members] })),
  };
  let sel = draft.dcas[0] ? { kind: 'dcas', id: draft.dcas[0].id } : draft.mutes[0] ? { kind: 'mutes', id: draft.mutes[0].id } : null;
  const body = el('div', { class: 'mg-editor' });

  function render() {
    const list = (kind, label, max) => {
      const items = draft[kind].map((grp) =>
        el('button', {
          class: `mg-item${sel && sel.id === grp.id ? ' active' : ''}`,
          text: `${grp.name} · ${grp.members.length}`,
          onclick: () => {
            sel = { kind, id: grp.id };
            render();
          },
        }),
      );
      const add = el('button', {
        class: 'ghost',
        text: `+ Add ${kind === 'dcas' ? 'mix DCA' : 'mute group'}`,
        disabled: draft[kind].length >= max,
        onclick: () => {
          const n = draft[kind].length + 1;
          const grp = kind === 'dcas' ? { id: newId(), name: `DCA ${n}`, members: [], pos: 0.75, muted: false } : { id: newId(), name: `Mute ${n}`, members: [], muted: false };
          draft[kind].push(grp);
          sel = { kind, id: grp.id };
          render();
        },
      });
      return el('div', { class: 'mg-list' }, [el('div', { class: 'pick-title', text: label }), ...items, add]);
    };

    const grp = sel && draft[sel.kind].find((x) => x.id === sel.id);
    let right;
    if (!grp) {
      right = el('div', { class: 'hint', text: 'Add a mix DCA (group fader + mute) or a mute group for this bus.' });
    } else {
      const nameInput = el('input', { value: grp.name, maxlength: 12 });
      nameInput.addEventListener('input', () => {
        grp.name = nameInput.value || '—';
      });
      nameInput.addEventListener('change', render);
      const picks = SEND_SOURCES().map((s) => {
        const others = draft[sel.kind].filter((x) => x !== grp && x.members.includes(s.id));
        const b = el('button', {
          class: `toggle pick${grp.members.includes(s.id) ? ' on' : ''}`,
          text: nameOf(s),
          title: others.length ? `Also in ${others.map((x) => x.name).join(', ')}` : '',
        });
        b.addEventListener('click', () => {
          if (grp.members.includes(s.id)) grp.members = grp.members.filter((m) => m !== s.id);
          else grp.members.push(s.id);
          render();
        });
        return b;
      });
      right = el('div', { class: 'mg-detail' }, [
        el('div', { class: 'mg-detail-head' }, [
          el('span', { class: 'slider-label', text: 'Name' }),
          nameInput,
          el('button', {
            class: 'ghost danger-text',
            text: 'Delete group',
            onclick: () => {
              draft[sel.kind] = draft[sel.kind].filter((x) => x !== grp);
              sel = null;
              render();
            },
          }),
        ]),
        el('div', { class: 'mg-select-row' }, [
          el('span', { class: 'hint', text: sel.kind === 'dcas' ? 'A channel can be in several mix DCAs; their fader moves add up.' : 'A channel can be in several mute groups; it stays muted while any of them is on.' }),
          el('button', {
            class: 'ghost',
            text: 'Select all',
            onclick: () => {
              grp.members = SEND_SOURCES().map((s) => s.id);
              render();
            },
          }),
          el('button', {
            class: 'ghost',
            text: 'Deselect all',
            onclick: () => {
              grp.members = [];
              render();
            },
          }),
        ]),
        el('div', { class: 'pick-grid' }, picks),
      ]);
    }
    body.replaceChildren(el('div', { class: 'mg-side' }, [list('dcas', 'Mix DCAs', MIX_DCA_MAX), list('mutes', 'Mute groups', MIX_MUTE_MAX)]), right);
  }

  const close = () => dlg.remove();
  const save = () => {
    const groupsOf = () => new Map([...dcaMembers(g)].map((id) => [id, g.dcas.filter((d) => d.members.includes(id)).map((d) => d.id).sort().join()]));
    const before = groupsOf();
    g.dcas = draft.dcas;
    g.mutes = draft.mutes;
    const after = groupsOf();
    for (const [id, groups] of after) {
      if (before.get(id) === groups) continue;
      delete g.base[id];
      learnBase(bus, id); // joining or leaving a group never moves the send
    }
    for (const id of Object.keys(g.base)) if (!after.has(id)) delete g.base[id];
    reconcileMutes(bus);
    close();
    renderBusBar();
    renderSends();
  };
  const dlg = el('div', { class: 'modal-back', onclick: (e) => e.target === dlg && close() }, [
    el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [el('strong', { text: `Mix groups · ${nameOf(busStrip)}` }), el('span', { class: 'hint', text: 'Only affect this bus mix. Stored in this app, not on the console.' })]),
      el('div', { class: 'modal-body' }, [body]),
      el('div', { class: 'modal-foot' }, [el('button', { class: 'ghost', text: 'Cancel', onclick: close }), el('button', { class: 'primary', text: 'Save', onclick: save })]),
    ]),
  ]);
  render();
  document.body.append(dlg);
}

const fitSends = () => store.getItem('fitSends') === 'true';

function renderBusBar() {
  busScope.dispose();
  busScope = makeScope();
  $('busbar').replaceChildren(
    el(
      'div',
      { class: 'layer-group' },
      X32.strips('bus').map((b) => {
        const btn = el('button', {
          class: b.n === currentBus ? 'active' : '',
          onclick: () => {
            currentBus = b.n;
            store.setItem('bus', String(b.n));
            renderBusBar();
            renderSends();
          },
        });
        busScope.watch(b.name, () => {
          btn.textContent = nameOf(b);
        });
        return btn;
      }),
    ),
    el('div', { class: 'layer-group right' }, [
      el('button', {
        class: fitSends() ? 'active' : '',
        text: 'Fit 32',
        title: 'Narrow strips so 32 channels fit on screen',
        onclick: () => {
          store.setItem('fitSends', String(!fitSends()));
          renderBusBar();
          renderSends();
        },
      }),
      el('span', { class: 'bar-label', text: 'MIX MUTE' }),
      ...MixMuteButtons(busScope, currentBus),
      el('button', { class: 'ghost', text: 'Mix groups…', onclick: () => openMixGroupEditor(currentBus) }),
    ]),
  );
}

function renderSends() {
  sendScope.dispose();
  sendScope = makeScope();
  const bus = X32.STRIP_BY_ID[`bus${currentBus}`];
  const sources = SEND_SOURCES();
  load([...sources.flatMap((s) => [X32.sendLevel(s, currentBus), X32.sendOn(s, currentBus), ...X32.stripViewPaths(s)]), ...X32.stripViewPaths(bus)]);
  const g = busGroups(currentBus);
  const dcaOf = new Map();
  for (const d of g.dcas) for (const id of d.members) dcaOf.set(id, dcaOf.has(id) ? `${dcaOf.get(id)} + ${d.name}` : d.name);
  $('view-sends').classList.toggle('fit32', fitSends());
  $('sendStrips').replaceChildren(
    ...sources.map((s) => Strip(sendScope, s, { fader: X32.sendLevel(s, currentBus), on: X32.sendOn(s, currentBus), sendTo: currentBus, tag: dcaOf.get(s.id) })),
  );
  trackMixDcaMembers(sendScope, currentBus);
  $('sendPinned').replaceChildren(...g.dcas.map((d) => MixDcaStrip(sendScope, currentBus, d)), Strip(sendScope, bus));
}

// ---------------------------------------------------------------------------
// FX rack
// ---------------------------------------------------------------------------
let fxScope = makeScope();
function renderFx() {
  fxScope.dispose();
  fxScope = makeScope();
  const paths = [];
  for (let n = 1; n <= X32.FX_SLOTS; n++) {
    paths.push(X32.fxTypePath(n));
    for (let i = 1; i <= X32.FX_PARAMS; i++) paths.push(X32.fxParPath(n, i));
  }
  load(paths);
  const cards = [];
  for (let n = 1; n <= X32.FX_SLOTS; n++) {
    const params = [];
    for (let i = 1; i <= X32.FX_PARAMS; i++) params.push(Knob(fxScope, X32.fxParPath(n, i), 'fxPar', { label: `P${i}`, size: 34 }));
    const rtn = n <= 4 ? X32.STRIP_BY_ID[`fxrtn${n * 2 - 1}`] : null;
    const rtnInfo = el('span', { class: 'hint' });
    if (rtn) fxScope.watch(rtn.fader, (v) => {
      rtnInfo.textContent = `Return ${rtn.n}/${rtn.n + 1}: ${typeof v === 'number' ? X32.fmtDb(X32.faderToDb(v)) + ' dB' : '—'}`;
    });
    cards.push(
      el('div', { class: 'fx-card' }, [
        el('div', { class: 'fx-head' }, [el('span', { class: 'fx-num', text: `FX ${n}` }), Select(fxScope, X32.fxTypePath(n), X32.FX_TYPES), rtnInfo]),
        el('div', { class: 'fx-params' }, params),
      ]),
    );
  }
  $('fxGrid').replaceChildren(...cards);
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
let sceneScope = makeScope();
let pickedScene = null;

function renderScenes() {
  sceneScope.dispose();
  sceneScope = makeScope();
  const cards = [];
  for (let i = 0; i < X32.SCENE_COUNT; i++) {
    const name = el('span', { class: 'scene-name' });
    const card = el('button', { class: 'scene' }, [el('span', { class: 'scene-num', text: String(i).padStart(2, '0') }), name]);
    sceneScope.watch(X32.sceneNamePath(i), (v) => {
      name.textContent = v || 'empty';
      card.classList.toggle('empty', !v);
      if (i === pickedScene) renderSceneTools();
    });
    card.addEventListener('click', () => {
      pickedScene = i;
      cards.forEach((c, j) => c.classList.toggle('picked', j === i));
      renderSceneTools();
    });
    card.addEventListener('dblclick', () => {
      if (state.get(X32.sceneNamePath(i))) recallScene(i);
    });
    cards.push(card);
  }
  sceneScope.watch(X32.CURRENT_SCENE_PATH, (cur) => {
    cards.forEach((c, j) => c.classList.toggle('current', j === cur));
    renderSceneTools();
  });
  $('sceneGrid').replaceChildren(...cards);
  renderSceneTools();
}

function recallScene(i) {
  const label = `${String(i).padStart(2, '0')} “${state.get(X32.sceneNamePath(i)) || ''}”`;
  confirmTools(`Recall scene ${label}? This changes the console live.`, () => {
    if (connState !== 'connected') return toast('Not connected to the console');
    command('/-action/goscene', [int(i)]);
  });
}

function confirmTools(msg, action) {
  $('sceneTools').replaceChildren(
    el('span', { class: 'confirm', text: msg }),
    el('button', { class: 'danger', text: 'Yes', onclick: () => { action(); renderSceneTools(); } }),
    el('button', { class: 'ghost', text: 'Cancel', onclick: renderSceneTools }),
  );
}

function renderSceneTools() {
  const box = $('sceneTools');
  const cur = state.get(X32.CURRENT_SCENE_PATH);
  const info = el('div', { class: 'scene-info', text: `Current: ${typeof cur === 'number' ? String(cur).padStart(2, '0') + ' ' + (state.get(X32.sceneNamePath(cur)) || '') : '—'}` });
  if (pickedScene === null) {
    box.replaceChildren(info, el('span', { class: 'hint', text: 'Click a slot to recall or save. Double-click to recall.' }));
    return;
  }
  const i = pickedScene;
  // Until the console has reported this slot we can't tell if it holds a scene,
  // so recall/save stay disabled rather than guessing "empty".
  const ready = known(X32.sceneNamePath(i));
  const existing = state.get(X32.sceneNamePath(i)) || '';
  const label = `${String(i).padStart(2, '0')}${existing ? ' “' + existing + '”' : ''}`;
  const nameInput = el('input', { value: existing, placeholder: 'Scene name', maxlength: 31 });
  box.replaceChildren(
    info,
    el('span', { class: 'picked-label', text: `Slot ${label}` }),
    el('button', { class: 'primary', text: 'Recall', disabled: !ready || !existing, onclick: () => recallScene(i) }),
    nameInput,
    el('button', {
      text: 'Save here',
      disabled: !ready,
      onclick: () => {
        const nm = nameInput.value.trim() || `Scene ${i}`;
        // Always ask: a slot without a name can still hold a saved scene.
        confirmTools(existing ? `Overwrite scene ${label} with the current mix?` : `Save the current mix as scene ${String(i).padStart(2, '0')} “${nm}”? If this slot holds an unnamed scene, it will be replaced.`, () => {
          if (connState !== 'connected') return toast('Not connected to the console');
          command('/save', [str('scene'), int(i), str(nm), str('')]);
          apply(X32.sceneNamePath(i), nm);
          setTimeout(() => load([X32.sceneNamePath(i)]), 300);
        });
      },
    }),
    ready ? null : el('span', { class: 'hint', text: connState === 'connected' ? 'Reading this slot from the console…' : 'Connect to the console to recall or save.' }),
  );
}

// ---------------------------------------------------------------------------
// Connection bar
// ---------------------------------------------------------------------------
const hostInput = $('hostInput');
hostInput.value = store.getItem('host') || '';
let connState = 'disconnected';
let connHost = null;

// Forget everything cached from a console: values, pending sends, drags and the
// copy/paste clipboard (so settings can't be pasted into a different console).
function resetLocalState() {
  state.clear();
  outbox.clear();
  dragging.clear();
  clipboard = null;
  for (const set of watchers.values()) for (const fn of set) fn(undefined);
}

function showStatus(s) {
  connState = s.state;
  connHost = s.host || null;
  document.body.classList.toggle('offline', s.state !== 'connected');
  const banner = $('offlineBanner');
  banner.hidden = s.state === 'connected';
  banner.className = `offline-banner ${s.state}`;
  banner.textContent = {
    disconnected: 'Not connected. Controls are locked until you connect to the console.',
    connecting: `Connecting to ${s.host}… Controls are locked until the console answers.`,
    lost: `Connection to the console lost. Reconnecting… Controls are locked so nothing gets lost.`,
  }[s.state] || '';
  $('statusDot').className = `dot ${s.state}`;
  const info = s.info && s.info.model ? ` · ${s.info.model} ${s.info.firmware || ''}` : '';
  const text = {
    disconnected: 'Offline',
    connecting: `Connecting to ${s.host}…`,
    connected: `${s.host}${info}`,
    lost: `Lost ${s.host || ''} (retrying)`,
  }[s.state];
  $('statusText').textContent = text;
  $('statusText').title = s.error || '';
  $('connectBtn').textContent = s.state === 'disconnected' ? 'Connect' : 'Disconnect';
  $('connectBtn').classList.toggle('primary', s.state === 'disconnected');
  if (s.state === 'connected') {
    if (s.resync) resetLocalState(); // console was away: reload everything fresh
    if (sermon.on && sermon.bus) load(sermonPaths());
    if (currentView === 'sends') renderBusBar();
    rerenderCurrent();
  }
}
window.x32.onStatus(showStatus);
window.x32.status().then(showStatus);

$('connectBtn').addEventListener('click', async () => {
  if (connState !== 'disconnected') {
    await window.x32.disconnect();
    return;
  }
  const host = hostInput.value.trim();
  if (!host) {
    hostInput.focus();
    return;
  }
  store.setItem('host', host);
  resetLocalState();
  await window.x32.connect(host);
});
hostInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('connectBtn').click();
});

$('scanBtn').addEventListener('click', async () => {
  const list = $('scanList');
  list.hidden = false;
  list.replaceChildren(el('div', { class: 'scan-item muted', text: 'Scanning…' }));
  let found = [];
  try {
    found = await window.x32.discover();
  } catch {
    found = [];
  }
  // The same console can answer on several addresses (e.g. LAN and loopback);
  // list it once, preferring a real network address.
  const byName = new Map();
  for (const d of found) {
    const key = `${d.name}|${d.model}`;
    const prev = byName.get(key);
    if (!prev || (prev.ip.startsWith('127.') && !d.ip.startsWith('127.'))) byName.set(key, d);
  }
  found = [...byName.values()];
  if (!found.length) {
    list.replaceChildren(el('div', { class: 'scan-item muted', text: 'No consoles found. Enter the IP manually.' }));
  } else {
    list.replaceChildren(
      ...found.map((d) =>
        el('button', {
          class: 'scan-item',
          text: `${d.name || 'X32'} · ${d.model || ''} · ${d.ip}`,
          onclick: () => {
            hostInput.value = d.ip;
            list.hidden = true;
          },
        }),
      ),
    );
  }
});
// One persistent outside-click handler for the scan list.
document.addEventListener('pointerdown', (e) => {
  const list = $('scanList');
  if (!list.hidden && !list.contains(e.target) && e.target !== $('scanBtn')) list.hidden = true;
});

// ---------------------------------------------------------------------------
// Alerts: clipping, signal loss and unusually low level, from live meters.
// Read-only: alerts never change anything on the console.
// ---------------------------------------------------------------------------
const CLIP_LIN = 0.98; // ≈ -0.2 dBFS
const ACTIVE_DB = -50; // channel is carrying signal
const SILENT_DB = -65; // effectively nothing
const SAMPLE_MS = 500;
const HISTORY = 240; // 2 minutes of samples
const ALERT_DEFAULTS = { clip: true, clipAll: false, loss: true, low: true, sound: false, lossSec: 10 };
let alertCfg = { ...ALERT_DEFAULTS, ...loadJson('alertCfg', {}) };
const saveAlertCfg = () => store.setItem('alertCfg', JSON.stringify(alertCfg));

const ALERT_STRIPS = X32.ALL_STRIPS.filter((s) => s.meter);
const LEVEL_KINDS = new Set(['ch', 'auxin']); // signal-loss / low-level apply to inputs
const tracks = new Map(ALERT_STRIPS.map((s) => [s.id, { hist: [], peak: 0, clips: [], silentSince: null, wasActive: 0 }]));
const alerts = new Map(); // key -> {key, type, id, msg, detail, at}
const alertLog = [];
const snoozes = new Map(); // key -> until (ms)
let alertPanelOpen = false;

const stripLevel = (s, values) => (s.kind === 'main' ? Math.max(values[22] || 0, values[23] || 0) : values[s.meter[1]] || 0);

window.x32.onMeters(({ bank, values }) => {
  const now = Date.now();
  for (const s of ALERT_STRIPS) {
    if (s.meter[0] !== bank) continue;
    const t = tracks.get(s.id);
    const lin = stripLevel(s, values);
    if (lin > t.peak) t.peak = lin;
    if (lin >= CLIP_LIN) t.clips.push(now);
  }
});

// Is the channel supposed to be producing sound right now?
function shouldHaveSignal(s) {
  if (state.get(s.on) !== 1 || groupMuted(s)) return false;
  const f = state.get(s.fader);
  return typeof f === 'number' && X32.faderToDb(f) > -50;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : -Infinity;
}

function raise(type, s, msg, detail) {
  const key = `${type}:${s.id}`;
  if ((snoozes.get(key) || 0) > Date.now()) return;
  const existing = alerts.get(key);
  if (existing) {
    existing.detail = detail;
    return;
  }
  const a = { key, type, id: s.id, msg, detail, at: Date.now() };
  alerts.set(key, a);
  alertLog.unshift({ ...a });
  alertLog.length = Math.min(alertLog.length, 40);
  showAlertToast(a);
  if (alertCfg.sound) beep(type);
  alertsChanged();
}

function resolve(type, s) {
  if (alerts.delete(`${type}:${s.id}`)) alertsChanged();
}

function evaluateAlerts() {
  if (connState !== 'connected') {
    if (alerts.size) {
      alerts.clear();
      alertsChanged();
    }
    for (const t of tracks.values()) {
      t.hist = [];
      t.silentSince = null;
    }
    return;
  }
  const now = Date.now();
  for (const s of ALERT_STRIPS) {
    const t = tracks.get(s.id);
    const db = linToDb(t.peak);
    t.peak = 0;
    t.hist.push(db);
    if (t.hist.length > HISTORY) t.hist.shift();
    t.clips = t.clips.filter((c) => now - c < 10000);

    // Clipping
    // Clip alerts watch the live stream bus and the main mix; every channel only if asked.
    const isStream = sermon.bus && s.id === `bus${sermon.bus}`;
    const clipWatched = alertCfg.clipAll || isStream || s.kind === 'main';
    if (alertCfg.clip && clipWatched && t.clips.length) {
      const secs = new Set(t.clips.map((c) => Math.floor(c / 1000))).size;
      raise('clip', s, isStream ? `Live stream (${nameOf(s)}) is clipping` : `${nameOf(s)} is clipping`, `Clipped in ${secs} of the last 10 s · lower ${LEVEL_KINDS.has(s.kind) ? 'the input gain' : 'its level'}`);
    } else resolve('clip', s);

    if (!LEVEL_KINDS.has(s.kind)) continue;
    const live = shouldHaveSignal(s);

    // Signal loss: was clearly active for the last minute, now silent while it should be heard.
    const silent = db < SILENT_DB;
    if (silent && t.silentSince === null) {
      t.silentSince = now;
      const prior = t.hist.slice(-121, -1); // the minute before the silence
      t.wasActive = prior.length >= 40 ? prior.filter((d) => d > ACTIVE_DB).length / prior.length : 0;
    } else if (!silent) t.silentSince = null;
    if (alertCfg.loss && live && t.silentSince !== null && t.wasActive >= 0.5 && now - t.silentSince >= alertCfg.lossSec * 1000) {
      raise('loss', s, `${nameOf(s)}: signal lost`, `Silent for ${Math.round((now - t.silentSince) / 1000)} s after being active · check mic, cable or battery`);
    } else if (!silent || !alertCfg.loss || !live) resolve('loss', s);

    // Low level: last 15 s far below this channel's own typical level.
    const recent = t.hist.slice(-30);
    const earlier = t.hist.slice(0, -30).filter((d) => d > ACTIVE_DB);
    if (alertCfg.low && live && recent.length === 30 && earlier.length >= 40 && !silent) {
      const typical = median(earlier);
      const now15 = median(recent);
      const lowKey = `low:${s.id}`;
      if (now15 > SILENT_DB && now15 < typical - 18) {
        raise('low', s, `${nameOf(s)} is unusually low`, `${now15.toFixed(0)} dBFS vs usual ${typical.toFixed(0)} dBFS`);
      } else if (alerts.has(lowKey) && now15 >= typical - 12) resolve('low', s);
    } else if (!alertCfg.low || !live || silent) resolve('low', s);
  }
  paintAlertStrips();
}
setInterval(evaluateAlerts, SAMPLE_MS);

let audioCtx = null;
function beep(type) {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = type === 'clip' ? 880 : 520;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.26);
  } catch {
    /* audio unavailable */
  }
}

const ALERT_LABEL = { clip: 'CLIP', loss: 'SIGNAL LOST', low: 'LOW' };

function showAlertToast(a) {
  const t = el('div', { class: `alert-toast ${a.type}` }, [
    el('div', { class: 'alert-toast-type', text: ALERT_LABEL[a.type] }),
    el('div', { class: 'alert-toast-msg', text: a.msg }),
    el('div', { class: 'alert-toast-detail', text: a.detail }),
  ]);
  t.addEventListener('click', () => {
    revealStrip(a.id, a.type);
    t.remove();
  });
  $('toastStack').prepend(t);
  while ($('toastStack').children.length > 4) $('toastStack').lastChild.remove();
  setTimeout(() => t.classList.add('out'), 6000);
  setTimeout(() => t.remove(), 6400);
}

function revealStrip(id, type) {
  const s = X32.STRIP_BY_ID[id];
  if (!s) return;
  if (currentView !== 'mixer') showView('mixer');
  const has = (l) => l.strips().some((x) => x.id === id);
  const layer = LAYERS.find((l) => l.id !== 'custom' && has(l));
  const shown = LAYERS.some((l) => l.id === currentLayer && has(l));
  if (layer && !shown && s.kind !== 'main') {
    currentLayer = layer.id;
    store.setItem('layer', layer.id);
    renderLayerBar();
    renderMixer();
  }
  if (s.kind !== 'dca') select(id, type === 'clip' && s.caps.preamp ? 'input' : undefined);
  document.querySelector(`#mixerStrips [data-strip="${id}"]`)?.scrollIntoView({ inline: 'center', behavior: 'smooth' });
}

function alertsChanged() {
  const badge = $('alertBadge');
  badge.hidden = alerts.size === 0;
  badge.textContent = alerts.size;
  badge.className = `alert-badge${[...alerts.values()].some((a) => a.type === 'clip') ? ' clip' : ''}`;
  paintAlertStrips();
  if (alertPanelOpen) renderAlertPanel();
}

// Strips are re-rendered on layer changes, so highlights are re-applied every tick.
function paintAlertStrips() {
  const byStrip = new Map();
  for (const a of alerts.values()) byStrip.set(a.id, [...(byStrip.get(a.id) || []), a.type]);
  for (const node of document.querySelectorAll('[data-strip]')) {
    const types = byStrip.get(node.dataset.strip) || [];
    node.classList.toggle('alert-clip', types.includes('clip'));
    node.classList.toggle('alert-loss', types.includes('loss'));
    node.classList.toggle('alert-low', types.includes('low') && !types.includes('loss'));
  }
}

function renderAlertPanel() {
  const panel = $('alertPanel');
  const toggle = (key, label, hint) => {
    const b = el('button', { class: `switch${alertCfg[key] ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!alertCfg[key]) }, [el('span', { class: 'knobdot' })]);
    b.addEventListener('click', () => {
      alertCfg[key] = !alertCfg[key];
      saveAlertCfg();
      evaluateAlerts();
      renderAlertPanel();
    });
    return el('div', { class: 'switch-row' }, [el('div', {}, [el('div', { class: 'switch-label', text: label }), el('div', { class: 'hint', text: hint })]), b]);
  };
  const secs = el('select', {}, [5, 10, 20, 30, 60].map((n) => el('option', { value: n, text: `${n} s` })));
  secs.value = alertCfg.lossSec;
  secs.addEventListener('change', () => {
    alertCfg.lossSec = Number(secs.value);
    saveAlertCfg();
  });
  const active = [...alerts.values()].sort((a, b) => b.at - a.at);
  const row = (a, live) =>
    el('div', { class: `alert-row ${a.type}` }, [
      el('span', { class: 'alert-tag', text: ALERT_LABEL[a.type] }),
      el('div', { class: 'alert-text' }, [el('div', { text: a.msg }), el('div', { class: 'hint', text: live ? a.detail : new Date(a.at).toLocaleTimeString() })]),
      live ? el('button', { class: 'ghost', text: 'Show', onclick: () => revealStrip(a.id, a.type) }) : null,
      live
        ? el('button', {
            class: 'ghost',
            text: 'Snooze 10m',
            title: 'Ignore this alert on this strip for 10 minutes',
            onclick: () => {
              snoozes.set(a.key, Date.now() + 600000);
              alerts.delete(a.key);
              alertsChanged();
            },
          })
        : null,
    ]);
  panel.replaceChildren(
    el('div', { class: 'alert-section' }, [
      toggle('clip', 'Clip alerts', 'Live stream bus or main mix hits 0 dBFS'),
      toggle('clipAll', 'Also every channel and bus', 'Off: only the live stream and main mix are watched'),
      toggle('loss', 'Signal-loss alerts', 'An active input goes silent while unmuted and up'),
      el('div', { class: 'switch-row sub' }, [el('span', { class: 'hint', text: 'Alert after silence of' }), secs]),
      toggle('low', 'Low-level alerts', 'An input runs far below its own usual level'),
      toggle('sound', 'Alert sound', 'Short beep when an alert appears'),
    ]),
    el('div', { class: 'alert-section' }, [
      el('div', { class: 'pick-title', text: `Active (${active.length})` }),
      ...(active.length ? active.map((a) => row(a, true)) : [el('div', { class: 'hint', text: connState === 'connected' ? 'All clear.' : 'Connect to a console to watch levels.' })]),
    ]),
    alertLog.length
      ? el('div', { class: 'alert-section' }, [el('div', { class: 'pick-title', text: 'Recent' }), ...alertLog.slice(0, 8).map((a) => row(a, false))])
      : null,
  );
}

$('alertBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  alertPanelOpen = !alertPanelOpen;
  $('alertPanel').hidden = !alertPanelOpen;
  if (alertPanelOpen) renderAlertPanel();
});
$('alertPanel').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  if (!alertPanelOpen) return;
  alertPanelOpen = false;
  $('alertPanel').hidden = true;
});

// ---------------------------------------------------------------------------
// Sermon mode: automatic speech leveling on the live stream bus only.
//
// For each mapped speech channel, its send to the stream bus is
//   send = base + applied
// base     = the operator's own send level (re-learned when the send is moved by hand)
// learned  = this person's speech correction, updated only while they speak
// applied  = what is on the console now. It follows `learned` while people talk,
//            returns to 0 (the operator's normal mix) during songs, and comes
//            back to `learned` quickly after a song so the first words are right.
// When several mapped people talk at once, each is aimed lower (10·log10 n dB)
// so together they stay near the target. Nothing else is changed or muted.
// ---------------------------------------------------------------------------
const SERMON_GATE_DB = -45; // below this the channel is not carrying speech
const SERMON_BLEED_DB = 25; // far below target: treat as bleed, not speech
const SERMON_SPEEDS = { slow: 1, normal: 2, fast: 4 }; // dB per second (leveling)
const SERMON_RAMP_DB_S = 6; // dB per second when moving into / out of a song
const RELEASE_DB_S = 3; // dB per second when gliding back to the operator's levels
const FADER_MAX_DB = 10; // an X32 fader/send can't go above +10 dB
const MUSIC_RELEASE_MS = 4000; // keep holding this long after the music stops
const SEND_TOL = 0.007; // one X32 send step (161 steps) plus margin, in fader units
const SERMON_ROLES = ['Pastor', 'Translator', 'Bible reader', 'Worship leader', 'Host / announcements', 'Prayer', 'Other'];
const SERMON_DEFAULTS = {
  on: false, host: null, bus: null, channels: [], roles: {}, music: [], bandDb: -25, mode: 'auto',
  target: -20, maxBoost: 8, maxCut: 6, speed: 'normal', paused: [],
  base: {}, corr: {}, learned: {}, pendingRestore: false, limiter: null,
};
let sermon = { ...SERMON_DEFAULTS, ...loadJson('sermon', {}) };
for (const k of ['base', 'corr', 'learned']) sermon[k] ||= {};
// After a restart, never resume silently: ask first (see the Sermon screen).
let sermonResumeAsk = sermon.on;
let musicUntil = 0;
let musicWho = [];
let sermonStatus = { song: false, who: [], speakers: 0 };

// Song detection: add up the whole band group (the band channels mapped in
// Setup, over the last 1.5 s) and call it a song when the total is above the
// line the operator sets. A soft pad or one instrument under the sermon stays
// below it; the full band playing together goes above it.
function bandGroup() {
  const playing = [];
  let power = 0;
  for (const id of sermon.music) {
    if (sermon.channels.includes(id)) continue;
    const s = srcStrip(id);
    const t = tracks.get(id);
    if (!s || !t || state.get(s.on) !== 1 || groupMuted(s)) continue;
    const w = t.hist.slice(-3);
    if (w.length < 3) continue;
    const d = median(w);
    if (!(d > -90)) continue;
    power += Math.pow(10, d / 10);
    if (d > SERMON_GATE_DB) playing.push(id);
  }
  const level = power > 0 ? 10 * Math.log10(power) : -Infinity;
  return { level, playing, total: sermon.music.filter((id) => !sermon.channels.includes(id)).length, song: level > sermon.bandDb };
}
let bandNow = { level: -Infinity, playing: [], total: 0, song: false };
const sermonLive = new Map(); // id -> {level, status}
const saveSermon = () => store.setItem('sermon', JSON.stringify(sermon));
const sermonSend = (id) => X32.sendLevel(srcStrip(id), sermon.bus);
const sermonOnPath = (id) => X32.sendOn(srcStrip(id), sermon.bus);
const sermonPaths = () => sermon.channels.flatMap((id) => [sermonSend(id), sermonOnPath(id)]);
const sameConsole = () => !sermon.host || sermon.host === connHost;
const sermonExpected = (id) => X32.dbToFader(Math.min(10, fromStoredDb(sermon.base[id]) + (sermon.corr[id] || 0)));
const towards = (cur, goal, step) => cur + Math.max(-step, Math.min(step, goal - cur));

// Speech channels also in a mix DCA on the stream bus are left alone, so the two
// features never fight over the same send.
function sermonConflict(id) {
  return sermon.bus ? busGroups(sermon.bus).dcas.find((d) => d.members.includes(id)) : null;
}

function roleLabels() {
  const counts = {};
  for (const id of sermon.channels) {
    const r = sermon.roles[id];
    if (r) counts[r] = (counts[r] || 0) + 1;
  }
  const seen = {};
  return Object.fromEntries(
    sermon.channels.map((id) => {
      const r = sermon.roles[id];
      if (!r) return [id, nameOf(srcStrip(id))];
      seen[r] = (seen[r] || 0) + 1;
      return [id, counts[r] > 1 ? `${r} ${seen[r]}` : r];
    }),
  );
}

// Put the operator's own levels back. Only forgets a channel once its send is
// really restored; otherwise the restore stays pending until the console is back.
// Glide every remembered send back to the operator's level (no sudden jump).
// Runs from sermonTick while sermon.pendingRestore is set; survives a
// disconnect or restart and finishes when the console is reachable again.
function sermonReleaseStep(ids = Object.keys(sermon.base)) {
  const step = RELEASE_DB_S * (SAMPLE_MS / 1000);
  for (const id of ids) {
    const p = sermonSend(id);
    if (!known(p)) continue;
    const corr = sermon.corr[id] || 0;
    const moved = Math.abs(sermonExpected(id) - state.get(p)) > SEND_TOL;
    if (moved || !corr || dragging.has(p)) {
      // Done, or someone moved it by hand: their level wins.
      delete sermon.base[id];
      delete sermon.corr[id];
      delete sermon.learned[id];
      continue;
    }
    sermon.corr[id] = towards(corr, 0, step);
    setParam(p, sermonExpected(id));
  }
  if (!sermon.on) sermon.pendingRestore = Object.keys(sermon.base).length > 0;
  saveSermon();
}

// Immediate restore, only for when the stream bus itself is changed in Setup.
function sermonRestore(ids) {
  let pending = false;
  for (const id of ids) {
    if (!(id in sermon.base) || !sermon.corr[id]) {
      delete sermon.base[id];
      delete sermon.corr[id];
      delete sermon.learned[id];
      continue;
    }
    const p = sermonSend(id);
    if (!known(p) || !sameConsole()) {
      pending = true;
      continue;
    }
    const v = X32.dbToFader(Math.min(10, fromStoredDb(sermon.base[id])));
    if (Math.abs(v - state.get(p)) > 1e-6) setParam(p, v);
    delete sermon.base[id];
    delete sermon.corr[id];
    delete sermon.learned[id];
  }
  sermon.pendingRestore = pending;
  saveSermon();
  return !pending;
}

function sermonTick() {
  if (!sermon.bus || connState !== 'connected' || !sameConsole()) return refreshSermonView();
  if (outroActive() && outro.bus === sermon.bus) return refreshSermonView(); // End of service owns the stream sends
  if (!sermon.on) {
    if (sermon.pendingRestore) sermonReleaseStep();
    return refreshSermonView();
  }
  if (sermonResumeAsk) return refreshSermonView(); // waiting for the operator's answer
  // People removed in Setup while leveling is on glide back to their levels.
  const gone = Object.keys(sermon.base).filter((id) => !sermon.channels.includes(id));
  if (gone.length) sermonReleaseStep(gone);
  const now = Date.now();
  const rate = (SERMON_SPEEDS[sermon.speed] || 2) * (SAMPLE_MS / 1000);
  const ramp = SERMON_RAMP_DB_S * (SAMPLE_MS / 1000);

  // Song detection from the band group's combined level.
  bandNow = bandGroup();
  if (bandNow.song) {
    musicUntil = now + MUSIC_RELEASE_MS;
    musicWho = bandNow.playing;
  }
  const song = sermon.mode === 'song' || (sermon.mode === 'auto' && now < musicUntil);

  // Who is speaking right now?
  const info = sermon.channels.map((id) => {
    const s = srcStrip(id);
    const t = tracks.get(id);
    const window = t ? t.hist.slice(-6) : [];
    const speech = window.filter((d) => d > SERMON_GATE_DB && d > sermon.target - SERMON_BLEED_DB);
    const level = speech.length ? speech.reduce((a, b) => a + b, 0) / speech.length : null;
    const live = state.get(s.on) === 1 && !groupMuted(s) && state.get(sermonOnPath(id)) === 1;
    return { id, s, level, speaking: speech.length >= 3, live };
  });
  const speakers = info.filter((i) => i.live && i.speaking && !sermon.paused.includes(i.id)).length;
  const overlapDb = speakers > 1 ? 10 * Math.log10(speakers) : 0;
  sermonStatus = { song, who: sermon.mode === 'auto' ? musicWho : [], speakers };

  let changed = false;
  for (const { id, s, level, speaking, live } of info) {
    const p = sermonSend(id);
    const st = { level, status: 'holding' };
    sermonLive.set(id, st);
    const dca = sermonConflict(id);
    if (dca) {
      st.status = 'conflict';
      st.note = dca.name;
      continue;
    }
    if (!known(p)) {
      st.status = 'waiting';
      continue;
    }
    if (dragging.has(p)) {
      st.status = 'manual';
      continue;
    }
    // Learn the operator's level on first sight, or when the send moved by more
    // than one console step without us. A manual move becomes the new baseline.
    if (!(id in sermon.base) || Math.abs(sermonExpected(id) - state.get(p)) > SEND_TOL) {
      sermon.base[id] = toStoredDb(X32.faderToDb(state.get(p)));
      sermon.corr[id] = 0;
      sermon.learned[id] = 0;
      changed = true;
    }
    if (sermon.paused.includes(id)) {
      st.status = 'paused';
      continue;
    }
    if (!live) {
      st.status = 'off';
      continue;
    }
    if (fromStoredDb(sermon.base[id]) === -Infinity) {
      st.status = 'send at -∞';
      continue;
    }
    // Only as much boost as the send fader really has left (it stops at +10 dB).
    const room = Math.max(0, FADER_MAX_DB - fromStoredDb(sermon.base[id]));
    const boostCap = Math.min(sermon.maxBoost, room);
    st.room = room;
    let learned = sermon.learned[id] || 0;
    if (!song && speaking) {
      const desired = Math.max(-sermon.maxCut, Math.min(boostCap, sermon.target - overlapDb - level));
      learned = towards(learned, desired, rate);
      st.status = 'leveling';
    }
    learned = Math.max(-sermon.maxCut, Math.min(boostCap, learned));
    if (learned !== sermon.learned[id]) {
      sermon.learned[id] = learned;
      changed = true;
    }
    if (song) st.status = 'song';
    const goal = song ? 0 : learned;
    const cur = sermon.corr[id] || 0;
    const next = towards(cur, goal, Math.max(ramp, rate));
    if (Math.abs(next - cur) < 0.05 && Math.abs(goal - cur) >= 0.05) continue;
    if (next === cur) continue;
    sermon.corr[id] = next;
    changed = true;
    const v = sermonExpected(id);
    if (Math.abs(v - state.get(p)) > 1e-6) setParam(p, v);
  }
  if (changed) saveSermon();
  refreshSermonView();
}
setInterval(sermonTick, SAMPLE_MS);

async function setSermonOn(on) {
  if (on && (!sermon.bus || !sermon.channels.length)) {
    openSermonSetup(true);
    return;
  }
  if (on && connState !== 'connected') {
    toast('Connect to the console first');
    return;
  }
  if (on && outroActive()) {
    toast('The stream is on playback (End of service). Click Back to live first.');
    return;
  }
  sermonResumeAsk = false;
  if (on) {
    await load(sermonPaths());
    if (sermon.pendingRestore && sermon.host === connHost) {
      // Turned back on while still gliding back: carry on from where the sends are.
      Object.assign(sermon, { on: true, pendingRestore: false });
    } else {
      Object.assign(sermon, { on: true, host: connHost, base: {}, corr: {}, learned: {}, pendingRestore: false });
    }
    saveSermon();
  } else {
    sermon.on = false;
    sermon.pendingRestore = Object.keys(sermon.base).length > 0;
    sermonLive.clear();
    saveSermon();
    if (sermon.pendingRestore) toast(connState === 'connected' ? 'Sermon mode off · gliding back to your levels' : 'Sermon mode off · your levels will glide back when the console is reachable');
  }
  renderSermonPill();
  if (currentView === 'sermon') renderSermonView();
}

function setSermonMode(mode) {
  sermon.mode = mode;
  saveSermon();
  renderSermonView();
}

function renderSermonPill() {
  const pill = $('sermonPill');
  pill.classList.toggle('on', sermon.on);
  pill.classList.toggle('ask', sermonResumeAsk);
  pill.textContent = sermonResumeAsk ? 'Sermon mode: resume?' : sermon.on ? 'SERMON MODE ON' : 'Sermon mode';
}

// ---- Optional stream-bus limiter (the X32's own bus compressor) ------------
function limiterPlan(bus) {
  const p = `/bus/${X32.pad2(bus)}/dyn`;
  return [
    [`${p}/on`, 1, 'On'],
    [`${p}/mode`, 0, 'Mode: compressor'],
    [`${p}/det`, 0, 'Detector: peak'],
    [`${p}/ratio`, 9, 'Ratio: 10:1'],
    [`${p}/thr`, X32.PARAMS.dynThr.map.fromUnit(-10), 'Threshold: −10 dB'],
    [`${p}/knee`, X32.PARAMS.knee.map.fromUnit(1), 'Knee: 1'],
    [`${p}/attack`, X32.PARAMS.attack.map.fromUnit(2), 'Attack: 2 ms'],
    [`${p}/release`, X32.PARAMS.release.map.fromUnit(150), 'Release: 150 ms'],
    [`${p}/mgain`, 0, 'Make-up gain: 0 dB'],
    [`${p}/mix`, 1, 'Mix: 100%'],
    [`${p}/auto`, 0, 'Auto time: off'],
  ];
}

async function openLimiterDialog() {
  const bus = sermon.bus;
  const plan = limiterPlan(bus);
  await load(plan.map(([p]) => p));
  const close = () => dlg.remove();
  const apply = () => {
    if (!plan.every(([p]) => known(p))) return toast('Waiting for the console; try again in a moment');
    sermon.limiter = { bus, host: connHost, prev: Object.fromEntries(plan.map(([p]) => [p, state.get(p)])) };
    for (const [p, v] of plan) setParam(p, v);
    saveSermon();
    close();
    renderSermonView();
    toast('Stream bus limiter applied');
  };
  const busName = nameOf(X32.STRIP_BY_ID[`bus${bus}`]);
  const dlg = el('div', { class: 'modal-back', onclick: (e) => e.target === dlg && close() }, [
    el('div', { class: 'modal narrow' }, [
      el('div', { class: 'modal-head' }, [el('strong', { text: `Protect ${busName} from peaks` })]),
      el('div', { class: 'modal-body' }, [
        el('div', { text: `This sets ${busName}'s own compressor on the X32 as a limiter, so peaks (two people speaking at once, a sudden shout) can't overload the live stream. It changes only this bus's compressor:` }),
        el('ul', { class: 'plan-list' }, plan.map(([, , label]) => el('li', { text: label }))),
        el('div', { class: 'hint', text: 'Your current compressor settings are saved, and Undo puts them back.' }),
      ]),
      el('div', { class: 'modal-foot' }, [el('button', { class: 'ghost', text: 'Cancel', onclick: close }), el('button', { class: 'primary', text: 'Apply limiter', onclick: apply })]),
    ]),
  ]);
  document.body.append(dlg);
}

async function undoLimiter() {
  const lim = sermon.limiter;
  if (!lim) return;
  if (connState !== 'connected' || lim.host !== connHost) return toast('Connect to the same console first');
  await load(Object.keys(lim.prev));
  if (!Object.keys(lim.prev).every((p) => known(p))) return toast('Waiting for the console; try again in a moment');
  for (const [p, v] of Object.entries(lim.prev)) setParam(p, v);
  sermon.limiter = null;
  saveSermon();
  renderSermonView();
  toast('Stream bus compressor restored');
}

// ---- Setup dialog -----------------------------------------------------------
function openSermonSetup(enableAfter = false) {
  const draft = { bus: sermon.bus || 1, channels: [...sermon.channels], roles: { ...sermon.roles }, music: [...sermon.music] };
  const body = el('div', { class: 'sermon-setup' });
  const sources = () => [...X32.strips('ch'), ...X32.strips('auxin')];
  function render() {
    const busSel = el('select', {}, X32.strips('bus').map((b) => el('option', { value: b.n, text: `${b.defaultName} · ${nameOf(b)}` })));
    busSel.value = draft.bus;
    busSel.addEventListener('change', () => {
      draft.bus = Number(busSel.value);
    });
    const speechPicks = sources().map((s) => {
      const b = el('button', { class: `toggle pick${draft.channels.includes(s.id) ? ' on' : ''}`, text: nameOf(s) });
      b.addEventListener('click', () => {
        draft.channels = draft.channels.includes(s.id) ? draft.channels.filter((x) => x !== s.id) : [...draft.channels, s.id];
        draft.music = draft.music.filter((x) => !draft.channels.includes(x));
        render();
      });
      return b;
    });
    const roles = draft.channels.map((id) => {
      const opts = [...SERMON_ROLES];
      if (draft.roles[id] && !opts.includes(draft.roles[id])) opts.push(draft.roles[id]);
      const sel = el('select', {}, [el('option', { value: '', text: '— Choose role —' }), ...opts.map((r) => el('option', { value: r, text: r }))]);
      sel.value = draft.roles[id] || '';
      sel.addEventListener('change', () => {
        draft.roles[id] = sel.value;
      });
      return el('div', { class: 'role-row' }, [el('span', { class: 'role-ch', text: nameOf(srcStrip(id)) }), sel]);
    });
    const musicPicks = sources().map((s) => {
      const isSpeech = draft.channels.includes(s.id);
      const b = el('button', { class: `toggle pick music${draft.music.includes(s.id) ? ' on' : ''}`, text: nameOf(s), disabled: isSpeech, title: isSpeech ? 'This is a speech channel' : '' });
      b.addEventListener('click', () => {
        draft.music = draft.music.includes(s.id) ? draft.music.filter((x) => x !== s.id) : [...draft.music, s.id];
        render();
      });
      return b;
    });
    body.replaceChildren(
      el('div', { class: 'setup-row' }, [el('span', { class: 'switch-label', text: 'Live stream bus' }), busSel]),
      el('div', { class: 'pick-title', text: '1 · Speech channels' }),
      el('div', { class: 'hint', text: 'Pastor, translator, Bible readers. Only these channels’ sends to the stream bus are leveled.' }),
      el('div', { class: 'pick-grid' }, speechPicks),
      roles.length ? el('div', { class: 'pick-title', text: 'Who is on each mic' }) : null,
      roles.length ? el('div', { class: 'role-grid' }, roles) : null,
      el('div', { class: 'pick-title', text: '2 · Worship / band channels' }),
      el('div', { class: 'mg-select-row' }, [
        el('span', { class: 'hint', text: 'Map all your instruments and singers here. When the band group together is loud enough (you set the line on the Live stream screen), it’s a song: leveling pauses and speech mics go back to your normal stream mix, so the pastor singing along isn’t turned down or up.' }),
        el('button', { class: 'ghost', text: 'Select all others', onclick: () => { draft.music = sources().map((s) => s.id).filter((id) => !draft.channels.includes(id)); render(); } }),
        el('button', { class: 'ghost', text: 'Deselect all', onclick: () => { draft.music = []; render(); } }),
      ]),
      el('div', { class: 'pick-grid' }, musicPicks),
    );
  }
  const close = () => dlg.remove();
  const save = async () => {
    const leaving = sermon.channels.filter((id) => !draft.channels.includes(id) || draft.bus !== sermon.bus);
    if (draft.bus !== sermon.bus) sermonRestore(leaving); // old bus: put back at once before switching
    else if (leaving.length) sermon.pendingRestore = true; // removed people glide back below
    sermon.bus = draft.bus;
    sermon.channels = X32.ALL_STRIPS.filter((s) => draft.channels.includes(s.id)).map((s) => s.id);
    sermon.roles = Object.fromEntries(sermon.channels.map((id) => [id, draft.roles[id] || '']));
    sermon.music = X32.ALL_STRIPS.filter((s) => draft.music.includes(s.id)).map((s) => s.id);
    sermon.paused = sermon.paused.filter((id) => sermon.channels.includes(id));
    saveSermon();
    close();
    if (enableAfter && sermon.channels.length) await setSermonOn(true);
    else if (sermon.on) await load(sermonPaths());
    renderSermonPill();
    if (currentView === 'sermon') renderSermonView();
  };
  const dlg = el('div', { class: 'modal-back', onclick: (e) => e.target === dlg && close() }, [
    el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [el('strong', { text: 'Sermon mode setup' })]),
      el('div', { class: 'modal-body' }, [body]),
      el('div', { class: 'modal-foot' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', { class: 'primary', text: enableAfter ? 'Save and turn on' : 'Save', onclick: save }),
      ]),
    ]),
  ]);
  render();
  document.body.append(dlg);
}

// ---- Sermon screen ---------------------------------------------------------
const sermonCards = new Map();
let sermonStatusEl = null;

function renderSermonView() {
  const view = $('sermonView');
  sermonCards.clear();
  const bus = sermon.bus ? X32.STRIP_BY_ID[`bus${sermon.bus}`] : null;
  const sw = el('button', { class: `switch big${sermon.on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(sermon.on), title: 'Turn Sermon mode on or off' }, [el('span', { class: 'knobdot' })]);
  sw.addEventListener('click', () => setSermonOn(!sermon.on));

  const range = (label, key, min, max, step, fmt) => {
    const input = el('input', { type: 'range', min, max, step, value: sermon[key] });
    const out = el('output', { text: fmt(sermon[key]) });
    input.addEventListener('input', () => {
      sermon[key] = Number(input.value);
      out.textContent = fmt(sermon[key]);
      saveSermon();
    });
    return el('label', { class: 'slider' }, [el('span', { class: 'slider-label', text: label }), input, out]);
  };
  const speed = el('select', {}, Object.keys(SERMON_SPEEDS).map((k) => el('option', { value: k, text: `${k[0].toUpperCase()}${k.slice(1)} (${SERMON_SPEEDS[k]} dB/s)` })));
  speed.value = sermon.speed;
  speed.addEventListener('change', () => {
    sermon.speed = speed.value;
    saveSermon();
  });
  const learn = el('button', {
    class: 'ghost',
    text: 'Set target from current speech',
    title: 'Use the average level of the mapped people who are speaking right now',
    onclick: () => {
      const levels = [...sermonLive.values()].map((l) => l.level).filter((l) => typeof l === 'number');
      if (!levels.length) return toast('Nobody is speaking right now');
      sermon.target = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
      saveSermon();
      renderSermonView();
    },
  });

  const modes = [
    ['auto', 'Auto', 'Detect songs from the worship/band channels'],
    ['speech', 'Speaking', 'Always level (ignore the band channels)'],
    ['song', 'Song', 'Pause leveling; speech mics use your normal stream mix'],
  ];
  const modeSeg = el(
    'div',
    { class: 'segmented' },
    modes.map(([m, label, title]) => el('button', { class: sermon.mode === m ? 'active' : '', text: label, title, onclick: () => setSermonMode(m) })),
  );
  sermonStatusEl = el('div', { class: 'sermon-status' });

  const labels = roleLabels();
  const cards = sermon.channels.map((id) => {
    const s = srcStrip(id);
    const levelBar = el('div', { class: 'sv-level-bar' });
    const targetMark = el('div', { class: 'sv-target' });
    const levelTxt = el('span', { class: 'sv-num' });
    const corrBar = el('div', { class: 'sv-corr-bar' });
    const corrTxt = el('span', { class: 'sv-num' });
    const status = el('span', { class: 'sv-status' });
    const pause = el('button', { class: `toggle${sermon.paused.includes(id) ? ' on' : ''}`, text: 'Pause', title: 'Stop leveling this person only' });
    pause.addEventListener('click', () => {
      sermon.paused = sermon.paused.includes(id) ? sermon.paused.filter((x) => x !== id) : [...sermon.paused, id];
      pause.classList.toggle('on', sermon.paused.includes(id));
      saveSermon();
    });
    const note = el('div', { class: 'sv-note' });
    sermonCards.set(id, { levelBar, targetMark, levelTxt, corrBar, corrTxt, status, note });
    return el('div', { class: 'sv-card' }, [
      el('div', { class: 'sv-head' }, [
        el('div', {}, [el('div', { class: 'sv-role', text: labels[id] }), el('div', { class: 'hint', text: `${s.defaultName} · ${nameOf(s)}` })]),
        status,
        pause,
      ]),
      el('div', { class: 'sv-row' }, [el('span', { class: 'slider-label', text: 'Speech' }), el('div', { class: 'sv-level' }, [levelBar, targetMark]), levelTxt]),
      el('div', { class: 'sv-row' }, [el('span', { class: 'slider-label', text: 'Stream adj.' }), el('div', { class: 'sv-corr' }, [el('div', { class: 'sv-corr-zero' }), corrBar]), corrTxt]),
      note,
    ]);
  });

  const lim = sermon.limiter && sermon.limiter.bus === sermon.bus ? sermon.limiter : null;
  const resume = sermonResumeAsk
    ? el('div', { class: 'resume-banner' }, [
        el('div', { text: 'Sermon mode was on when the app closed. Resume leveling, or turn it off and put your stream levels back?' }),
        el('button', { class: 'primary', text: 'Resume', onclick: () => { sermonResumeAsk = false; renderSermonPill(); renderSermonView(); } }),
        el('button', { class: 'ghost', text: 'Turn off & restore', onclick: () => setSermonOn(false) }),
      ])
    : null;

  view.replaceChildren(
    ...[
      resume,
      OutroCard(),
      StreamCard(),
      el('div', { class: 'sermon-head' }, [
        sw,
        el('div', {}, [
          el('div', { class: 'sermon-title', text: sermon.on ? 'Speech leveling (Sermon mode) is on' : 'Speech leveling (Sermon mode) is off' }),
          el('div', { class: 'hint', text: bus ? `Leveling speech on ${nameOf(bus)} only. Main mix, wedges, faders and other channels are untouched; nothing is muted.` : 'Choose the live stream bus and speech channels to start.' }),
        ]),
        el('button', { class: 'ghost', text: 'Setup…', onclick: () => openSermonSetup(false) }),
      ]),
      el('div', { class: 'sermon-modebar' }, [el('span', { class: 'switch-label', text: 'Right now:' }), modeSeg, sermonStatusEl]),
      sermon.channels.length ? el('div', { class: 'sv-grid' }, cards) : el('div', { class: 'empty-note', text: 'No speech channels mapped yet. Click Setup…' }),
      el('div', { class: 'section sermon-settings' }, [
        el('div', { class: 'section-title', text: 'Leveling' }),
        range('Target', 'target', -35, -6, 1, (v) => `${v} dBFS`),
        learn,
        range('Max boost', 'maxBoost', 0, 12, 1, (v) => `+${v} dB`),
        range('Max cut', 'maxCut', 0, 12, 1, (v) => `-${v} dB`),
        el('label', { class: 'select' }, [el('span', { class: 'slider-label', text: 'Speed' }), speed]),
        BandGroupMeter(),
      ]),
    ].filter(Boolean),
  );
  refreshSermonView();
}

const levelPos = (db) => Math.max(0, Math.min(1, (db + 60) / 60));

// Band group meter: the band's combined level against the song line.
let bandEls = null;
function BandGroupMeter() {
  if (!sermon.music.length) {
    bandEls = null;
    return el('div', { class: 'band-meter-box' }, [
      el('div', { class: 'switch-label', text: 'Song detection' }),
      el('div', { class: 'hint', text: 'Map your band / instrument channels in Setup (step 2) so the app can tell songs from speaking.' }),
    ]);
  }
  const bar = el('div', { class: 'band-bar' });
  const line = el('div', { class: 'band-line' });
  const readout = el('div', { class: 'hint' });
  const slider = el('input', { type: 'range', min: -50, max: 0, step: 1, value: sermon.bandDb, class: 'band-slider' });
  const out = el('output', { text: `${sermon.bandDb} dBFS` });
  slider.addEventListener('input', () => {
    sermon.bandDb = Number(slider.value);
    out.textContent = `${sermon.bandDb} dBFS`;
    saveSermon();
    refreshBandMeter();
  });
  bandEls = { bar, line, readout };
  return el('div', { class: 'band-meter-box' }, [
    el('div', { class: 'switch-label', text: 'Song detection · band group' }),
    el('div', { class: 'hint', text: 'A song is when your band group (all mapped instruments together) is above the line. Watch this during worship and during the sermon, then set the line between the two.' }),
    el('div', { class: 'band-meter' }, [bar, line]),
    el('label', { class: 'slider' }, [el('span', { class: 'slider-label', text: 'Song line' }), slider, out]),
    readout,
  ]);
}
function refreshBandMeter() {
  if (!bandEls) return;
  const live = connState === 'connected';
  const lvl = live ? bandNow.level : -Infinity;
  bandEls.bar.style.width = `${levelPos(lvl) * 100}%`;
  bandEls.bar.classList.toggle('song', live && bandNow.song);
  bandEls.line.style.left = `${levelPos(sermon.bandDb) * 100}%`;
  bandEls.readout.textContent = !live
    ? 'Not connected'
    : `Band group now: ${lvl > -90 ? lvl.toFixed(0) + ' dBFS' : 'silent'} · ${bandNow.playing.length} of ${bandNow.total} instruments playing · ${bandNow.song ? 'SONG' : 'not a song'}`;
}
const SERMON_STATUS_TEXT = {
  leveling: 'Leveling', holding: 'Holding', song: 'Song · normal mix', paused: 'Paused', manual: 'You’re moving it',
  waiting: 'Waiting', 'send at -∞': 'Send at -∞', conflict: 'In a mix DCA',
};
function refreshSermonView() {
  if (currentView !== 'sermon') return;
  refreshStreamCard();
  refreshOutroCard();
  refreshBandMeter();
  if (sermonStatusEl) {
    let text;
    if (!sermon.on) text = sermon.pendingRestore ? (connState === 'connected' ? 'Off · gliding back to your levels…' : 'Off · your levels will glide back when the console is reachable') : 'Off';
    else if (sermonResumeAsk) text = 'Waiting for your answer above';
    else if (connState !== 'connected') text = 'Not connected';
    else if (!sameConsole()) text = 'Connected to a different console; not leveling';
    else if (sermonStatus.song) text = sermon.mode === 'song' ? 'Song (manual): speech mics on your normal mix' : `Song detected (band group above the line, ${bandNow.playing.length} of ${bandNow.total} playing): speech mics on your normal mix`;
    else if (sermonStatus.speakers > 1) text = `${sermonStatus.speakers} people talking: each aimed ${(10 * Math.log10(sermonStatus.speakers)).toFixed(0)} dB lower so together they stay even`;
    else text = 'Speaking: leveling';
    sermonStatusEl.textContent = text;
    sermonStatusEl.classList.toggle('song', !!(sermon.on && sermonStatus.song));
  }
  for (const [id, c] of sermonCards) {
    const live = sermonLive.get(id) || { level: null, status: 'holding' };
    const t = tracks.get(id);
    const nowDb = t && t.hist.length ? t.hist[t.hist.length - 1] : -Infinity;
    c.levelBar.style.width = `${levelPos(nowDb) * 100}%`;
    c.targetMark.style.left = `${levelPos(sermon.target) * 100}%`;
    c.levelTxt.textContent = live.level === null ? '—' : `${live.level.toFixed(0)} dBFS`;
    const corr = sermon.corr[id] || 0;
    const span = Math.max(sermon.maxBoost, sermon.maxCut, 1);
    c.corrBar.style.left = `${50 + Math.min(0, corr / span) * 50}%`;
    c.corrBar.style.width = `${(Math.min(Math.abs(corr), span) / span) * 50}%`;
    c.corrBar.classList.toggle('cut', corr < 0);
    c.corrTxt.textContent = `${corr >= 0 ? '+' : ''}${corr.toFixed(1)} dB`;
    let st = sermon.on && !sermonResumeAsk ? live.status : 'off';
    if (st === 'off' && sermon.on && !sermonResumeAsk) st = 'off';
    const label = st === 'off' ? (sermon.on && !sermonResumeAsk ? 'Muted / send off' : 'Off') : SERMON_STATUS_TEXT[st] || st;
    c.status.textContent = st === 'conflict' ? `In mix DCA ${live.note}` : label;
    c.status.title = st === 'conflict' ? 'This channel is in a mix DCA on the stream bus, so Sermon mode leaves it alone. Remove it from the mix DCA to level it.' : '';
    c.status.className = `sv-status ${st.replace(/\W/g, '')}`;
    const room = live.room;
    const tight = sermon.on && typeof room === 'number' && room < sermon.maxBoost;
    c.note.hidden = !tight;
    if (tight) {
      c.note.textContent = room <= 0.05
        ? `No room to boost: this stream send is already at the fader's top (+${FADER_MAX_DB} dB). Lower this send and raise the stream bus fader instead.`
        : `Only +${room.toFixed(1)} dB of boost room left: this stream send is at ${X32.fmtDb(FADER_MAX_DB - room)} dB (top is +${FADER_MAX_DB}). Lower this send a little and raise the stream bus fader to give it room.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Live stream monitor and clip guard (stream bus = the bus chosen in Setup).
//
// Monitor: the stream bus output's peak, its loudness over the last 3 s, and how
// loud speech is compared with songs over the last few minutes (read-only).
// Clip guard (optional): when the stream bus gets close to clipping it lowers
// the stream bus fader by 1 dB (at most 6 dB), and eases it back 0.5 dB at a
// time once the stream has been calm for a while. It never goes above the
// operator's own fader level; a manual move becomes the new level. Turning it
// off puts the fader back. The bus limiter (below) catches short peaks without
// making the stream quieter; the guard is the backstop.
// ---------------------------------------------------------------------------
const GUARD_CEILING_DB = -1; // peaks at or above this are "about to clip"
const GUARD_STEP_DB = 1;
const GUARD_MAX_DB = 6;
const GUARD_COOLDOWN_MS = 1500;
const GUARD_CALM_DB = 6; // calm = peaks at least this far under the ceiling
const GUARD_CALM_MS = 20000;
const GUARD_RECOVER_DB = 0.5;
const STREAM_CLIP_DB = -0.2;
const BALANCE_WINDOW = 600; // 5 minutes of 500 ms samples
let guard = { on: false, host: null, base: null, offset: 0, pendingRestore: false, ...loadJson('streamGuard', {}) };
const saveGuard = () => store.setItem('streamGuard', JSON.stringify(guard));
const streamStrip = () => (sermon.bus ? X32.STRIP_BY_ID[`bus${sermon.bus}`] : null);
const stream = { speech: [], song: [], clips: [], lastCut: 0, calmSince: 0, peak: -Infinity, loud: -Infinity, kind: null };
const powerMean = (dbs) => (dbs.length ? 10 * Math.log10(dbs.reduce((a, d) => a + Math.pow(10, d / 10), 0) / dbs.length) : -Infinity);
const guardExpected = () => X32.dbToFader(Math.min(10, fromStoredDb(guard.base) + guard.offset));

// What is happening right now, independent of whether speech leveling is on.
function streamActivity() {
  const recent = (id) => {
    const t = tracks.get(id);
    return t ? t.hist.slice(-3) : [];
  };
  const live = (id) => {
    const s = srcStrip(id);
    return s && state.get(s.on) === 1 && !groupMuted(s);
  };
  bandNow = bandGroup();
  const song = sermon.mode === 'song' || (sermon.mode !== 'speech' && bandNow.song);
  const speech = sermon.channels.some((id) => live(id) && recent(id).filter((d) => d > SERMON_GATE_DB).length >= 2);
  return song ? 'song' : speech ? 'speech' : null;
}

// Glide the stream bus fader back to the operator's level (no sudden jump).
function guardReleaseStep() {
  const s = streamStrip();
  const done = () => {
    Object.assign(guard, { base: null, offset: 0, pendingRestore: false });
    saveGuard();
  };
  if (!s || guard.base === null || !guard.offset) return done();
  if (!known(s.fader) || guard.host !== connHost) return;
  if (dragging.has(s.fader) || Math.abs(guardExpected() - state.get(s.fader)) > SEND_TOL) return done(); // moved by hand: that wins
  guard.offset = towards(guard.offset, 0, RELEASE_DB_S * (SAMPLE_MS / 1000));
  setParam(s.fader, guardExpected());
  if (!guard.offset) return done();
  saveGuard();
}

function setGuardOn(on) {
  if (on && connState !== 'connected') return toast('Connect to the console first');
  if (on && !streamStrip()) return openSermonSetup(false);
  if (on) {
    if (guard.pendingRestore && guard.host === connHost) Object.assign(guard, { on: true, pendingRestore: false }); // keep its place
    else Object.assign(guard, { on: true, host: connHost, base: null, offset: 0, pendingRestore: false });
    load([streamStrip().fader]);
    saveGuard();
  } else {
    guard.on = false;
    guard.pendingRestore = guard.base !== null && guard.offset !== 0;
    saveGuard();
    if (guard.pendingRestore) toast('Clip guard off · the stream fader glides back to your level');
  }
  if (currentView === 'sermon') renderSermonView();
}

function streamTick() {
  const s = streamStrip();
  if (!s || connState !== 'connected') return;
  const now = Date.now();
  const t = tracks.get(s.id);
  const h = t ? t.hist : [];
  stream.peak = h.length ? h[h.length - 1] : -Infinity;
  stream.loud = powerMean(h.slice(-6).filter((d) => d > -90));
  if (stream.peak >= STREAM_CLIP_DB) stream.clips.push(now);
  stream.clips = stream.clips.filter((c) => now - c < 600000);
  stream.kind = streamActivity();
  if (stream.kind && stream.peak > -60) {
    const list = stream[stream.kind];
    list.push(stream.peak);
    if (list.length > BALANCE_WINDOW) list.shift();
  }

  if (!guard.on) {
    if (guard.pendingRestore) guardReleaseStep();
    return;
  }
  if (guard.host !== connHost || !known(s.fader) || dragging.has(s.fader)) return;
  const actual = state.get(s.fader);
  if (guard.base === null || Math.abs(guardExpected() - actual) > SEND_TOL) {
    guard.base = toStoredDb(X32.faderToDb(actual)); // the operator's own level
    guard.offset = 0;
    saveGuard();
  }
  if (fromStoredDb(guard.base) === -Infinity) return;
  let next = guard.offset;
  if (stream.peak >= GUARD_CEILING_DB) {
    stream.calmSince = 0;
    if (now - stream.lastCut >= GUARD_COOLDOWN_MS && guard.offset > -GUARD_MAX_DB) {
      next = Math.max(-GUARD_MAX_DB, guard.offset - GUARD_STEP_DB);
      stream.lastCut = now;
    }
  } else if (stream.peak < GUARD_CEILING_DB - GUARD_CALM_DB) {
    if (!stream.calmSince) stream.calmSince = now;
    if (guard.offset < 0 && now - stream.calmSince >= GUARD_CALM_MS) {
      next = Math.min(0, guard.offset + GUARD_RECOVER_DB);
      stream.calmSince = now - GUARD_CALM_MS + 2000; // keep easing back every 2 s while calm
    }
  } else {
    stream.calmSince = 0;
  }
  if (next !== guard.offset) {
    guard.offset = next;
    setParam(s.fader, guardExpected());
    saveGuard();
  }
}
setInterval(streamTick, SAMPLE_MS);

let streamEls = null;
function StreamCard() {
  const s = streamStrip();
  if (!s) {
    streamEls = null;
    return el('div', { class: 'stream-card' }, [
      el('div', { class: 'sermon-title', text: 'Live stream' }),
      el('div', { class: 'hint', text: 'Choose which bus feeds your live stream to watch its level and protect it from clipping.' }),
      el('button', { class: 'primary', text: 'Choose stream bus…', onclick: () => openSermonSetup(false) }),
    ]);
  }
  const bar = el('div', { class: 'stream-bar' });
  const loudMark = el('div', { class: 'stream-loud' });
  const ceiling = el('div', { class: 'stream-ceiling', style: `left:${streamPos(GUARD_CEILING_DB) * 100}%`, title: 'Clip guard ceiling (−1 dBFS)' });
  const nums = {
    peak: el('div', { class: 'stream-num' }),
    loud: el('div', { class: 'stream-num' }),
    clips: el('div', { class: 'stream-num' }),
  };
  const balance = el('div', { class: 'stream-balance' });
  const guardStatus = el('span', { class: 'hint' });
  const sw = el('button', { class: `switch${guard.on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(guard.on), title: 'Clip guard on/off' }, [el('span', { class: 'knobdot' })]);
  sw.addEventListener('click', () => setGuardOn(!guard.on));
  const lim = sermon.limiter && sermon.limiter.bus === sermon.bus ? sermon.limiter : null;
  streamEls = { bar, loudMark, nums, balance, guardStatus };
  const stat = (label, n) => el('div', { class: 'stream-stat' }, [el('div', { class: 'slider-label', text: label }), n]);
  return el('div', { class: 'stream-card' }, [
    el('div', { class: 'stream-head' }, [
      el('div', {}, [el('div', { class: 'sermon-title', text: `Live stream · ${nameOf(s)}` }), el('div', { class: 'hint', text: `${s.defaultName} output` })]),
      el('button', { class: 'ghost', text: 'Change bus…', onclick: () => openSermonSetup(false) }),
    ]),
    el('div', { class: 'stream-meter' }, [bar, loudMark, ceiling]),
    el('div', { class: 'stream-scale' }, [-60, -40, -30, -20, -12, -6, -3, 0].map((d) => el('span', { style: `left:${streamPos(d) * 100}%`, text: String(d) }))),
    el('div', { class: 'stream-stats' }, [stat('Peak now', nums.peak), stat('Level (3 s)', nums.loud), stat('Clips (10 min)', nums.clips)]),
    balance,
    el('div', { class: 'stream-protect' }, [
      el('div', { class: 'switch-row' }, [
        el('div', {}, [el('div', { class: 'switch-label', text: 'Clip guard' }), el('div', { class: 'hint', text: 'If the stream gets close to clipping, lower the stream bus fader 1 dB at a time (max 6 dB) and ease it back when calm.' })]),
        sw,
      ]),
      guardStatus,
      el('div', { class: 'switch-row' }, [
        el('div', {}, [
          el('div', { class: 'switch-label', text: `Limiter on ${nameOf(s)}: ${lim ? 'set' : 'not set'}` }),
          el('div', { class: 'hint', text: 'Uses the X32’s own bus compressor to catch sudden peaks without making the stream quieter. Recommended.' }),
        ]),
        lim ? el('button', { class: 'ghost', text: 'Undo limiter', onclick: undoLimiter }) : el('button', { class: 'ghost', text: 'Set up limiter…', onclick: openLimiterDialog }),
      ]),
    ]),
  ]);
}

const streamPos = (db) => {
  if (!(db > -60)) return 0;
  if (db >= 0) return 1;
  return db > -20 ? 0.45 + ((db + 20) / 20) * 0.55 : ((db + 60) / 40) * 0.45;
};
const fmtDbfs = (d) => (d > -90 ? `${d.toFixed(1)} dBFS` : '—');

function refreshStreamCard() {
  if (!streamEls) return;
  const { bar, loudMark, nums, balance, guardStatus } = streamEls;
  const live = connState === 'connected';
  bar.style.width = `${(live ? streamPos(stream.peak) : 0) * 100}%`;
  bar.classList.toggle('hot', live && stream.peak >= GUARD_CEILING_DB);
  loudMark.style.left = `${streamPos(stream.loud) * 100}%`;
  loudMark.style.opacity = live && stream.loud > -60 ? 1 : 0;
  nums.peak.textContent = live ? fmtDbfs(stream.peak) : '—';
  nums.peak.classList.toggle('hot', live && stream.peak >= GUARD_CEILING_DB);
  nums.loud.textContent = live ? fmtDbfs(stream.loud) : '—';
  nums.clips.textContent = String(stream.clips.length);
  nums.clips.classList.toggle('hot', stream.clips.length > 0);

  const sp = powerMean(stream.speech);
  const so = powerMean(stream.song);
  let text;
  let cls = '';
  if (!sermon.channels.length) text = 'Map the speech mics (and band channels) in Setup to compare speech with songs.';
  else if (stream.speech.length < 20 || stream.song.length < 20) text = `Speech vs songs: still listening (${Math.round(stream.speech.length / 2)} s of speech, ${Math.round(stream.song.length / 2)} s of songs so far).`;
  else {
    const diff = sp - so;
    if (diff < -6) {
      text = `Speech is ${(-diff).toFixed(0)} dB quieter than the songs on the stream, so people may struggle to hear. Turn on Sermon mode, or raise its Target.`;
      cls = 'warn';
    } else if (diff > 6) {
      text = `Songs are ${diff.toFixed(0)} dB quieter than speech on the stream. Consider raising the band in the stream mix.`;
      cls = 'warn';
    } else text = `Speech and songs are balanced on the stream (within ${Math.max(1, Math.abs(diff)).toFixed(0)} dB). Speech ${sp.toFixed(0)} dBFS, songs ${so.toFixed(0)} dBFS (last 5 min).`;
  }
  balance.textContent = text;
  balance.className = `stream-balance ${cls}`;

  if (!guard.on) guardStatus.textContent = guard.pendingRestore ? (connState === 'connected' ? `Off · stream fader gliding back to your level (${guard.offset.toFixed(1)} dB to go)` : 'Off · the stream fader will glide back when the console is reachable') : 'Off';
  else if (guard.host !== connHost) guardStatus.textContent = 'On, but connected to a different console: not acting';
  else if (guard.offset < 0) guardStatus.textContent = `On · stream fader lowered ${(-guard.offset).toFixed(1)} dB to avoid clipping${guard.offset <= -GUARD_MAX_DB ? ' (maximum; consider setting the limiter or lowering levels)' : ''}`;
  else guardStatus.textContent = 'On · stream fader at your level';
}

// ---------------------------------------------------------------------------
// End of service (stream bus only): fade every input's send to the stream bus
// down while the playback channel(s) fade up, so the post-service slides roll
// with music on the stream. The room is untouched: main mix, wedges, channel
// faders and mutes never move. "Back to live" fades every send back to the
// level it had before. A send someone moves by hand (or a scene recall changes)
// is left where they put it. The fade survives a disconnect or restart.
// ---------------------------------------------------------------------------
const OUTRO_TICK_MS = 50;
const OUTRO_KINDS = ['ch', 'auxin', 'fxrtn'];
const OUTRO_DEFAULTS = { playback: [], playbackDb: 0, fadeSec: 10, phase: 'idle', host: null, bus: null, progress: 0, sends: {}, playOn: {} };
let outro = { ...OUTRO_DEFAULTS, ...loadJson('outro', {}) };
const saveOutro = () => store.setItem('outro', JSON.stringify(outro));
const outroActive = () => outro.phase !== 'idle';
const outroLevel = (id) => X32.sendLevel(srcStrip(id), outro.bus);
const outroOnPath = (id) => X32.sendOn(srcStrip(id), outro.bus);
const outroLast = new Map(); // path -> value this run last wrote (not persisted)
let outroSavedAt = 0;
// When the fade finishes, the inputs are held off by this mix mute group on the
// stream bus and their sends go back to their normal levels underneath it, so
// next service the operator only has to unmute the group.
const OUTRO_GROUP_ID = 'end-of-service';
const outroGroup = () => (outro.bus ? busGroups(outro.bus).mutes.find((m) => m.id === OUTRO_GROUP_ID) : null);
const outroInputIds = () => Object.entries(outro.sends).filter(([, e]) => !e.play && !e.skip).map(([id]) => id);

// Mute the faded inputs with the group, then put each send back to its level
// once it is really off. Idempotent: runs every tick until everything is done.
function outroMuteStep() {
  const g = busGroups(outro.bus);
  let grp = outroGroup();
  if (!outro.grouped) {
    if (!grp && g.mutes.length >= MIX_MUTE_MAX) {
      // No free mute group: leave the inputs faded down instead.
      Object.assign(outro, { phase: 'ended', noGroup: true });
      saveOutro();
      toast(`All ${MIX_MUTE_MAX} mute groups on this bus are in use, so the inputs stay faded down. Back to live brings them up.`);
      return;
    }
    if (!grp) {
      grp = { id: OUTRO_GROUP_ID, name: 'End of service', members: [], muted: false };
      g.mutes.push(grp);
    }
    grp.members = outroInputIds();
    grp.muted = true;
    outro.grouped = true;
    saveMix();
    saveOutro();
    if (currentView === 'sends') rerenderCurrent();
  }
  reconcileMutes(outro.bus);
  let pending = 0;
  for (const id of grp.members) {
    const e = outro.sends[id];
    if (!e || e.restored) continue;
    const lv = outroLevel(id);
    const on = outroOnPath(id);
    if (!known(lv) || !known(on) || state.get(on) !== 0) {
      pending++;
      continue;
    }
    if (Math.abs(state.get(lv) - e.saved) > 1e-6) setParam(lv, e.saved); // silent: the send is off
    e.restored = true;
  }
  if (!pending) {
    outro.phase = 'ended';
    renderOutroPill();
    if (currentView === 'sermon') renderSermonView();
  }
  saveOutro();
}

function outroPaths(bus) {
  return OUTRO_KINDS.flatMap((k) => X32.strips(k)).flatMap((s) => [X32.sendLevel(s, bus), X32.sendOn(s, bus)]);
}

async function startOutro() {
  const bus = sermon.bus;
  if (connState !== 'connected') return toast('Connect to the console first');
  if (!bus) return openSermonSetup(false);
  if (!outro.playback.length) return openOutroSetup(true);
  if (outroActive()) return;
  await load(outroPaths(bus));
  // Speech leveling hands its channels over: their "before" level is the
  // operator's own level (without the leveling correction), and it stays off.
  const operatorLevel = {};
  if ((sermon.on || sermon.pendingRestore) && sermon.bus === bus) {
    for (const [id, base] of Object.entries(sermon.base)) operatorLevel[id] = X32.dbToFader(Math.min(10, fromStoredDb(base)));
    Object.assign(sermon, { on: false, pendingRestore: false, base: {}, corr: {}, learned: {} });
    sermonResumeAsk = false;
    sermonLive.clear();
    saveSermon();
    renderSermonPill();
  }
  const sends = {};
  for (const s of OUTRO_KINDS.flatMap((k) => X32.strips(k))) {
    const p = X32.sendLevel(s, bus);
    if (!known(p)) continue;
    if (outro.playback.includes(s.id)) {
      sends[s.id] = { saved: state.get(p), from: state.get(p), to: X32.dbToFader(Math.min(FADER_MAX_DB, outro.playbackDb)), play: true };
      continue;
    }
    const saved = s.id in operatorLevel ? operatorLevel[s.id] : state.get(p);
    if (!(state.get(p) > 0) && !(saved > 0)) continue; // already silent on the stream
    sends[s.id] = { saved, from: state.get(p), to: 0 };
  }
  const playOn = {};
  for (const id of outro.playback) {
    const p = X32.sendOn(srcStrip(id), bus);
    if (known(p) && state.get(p) !== 1) {
      playOn[id] = state.get(p);
      setParam(p, 1); // the playback send must be on to be heard
    }
  }
  outroLast.clear();
  Object.assign(outro, { phase: 'ending', host: connHost, bus, progress: 0, sends, playOn, grouped: false, noGroup: false });
  saveOutro();
  renderOutroPill();
  if (currentView === 'sermon') renderSermonView();
}

let outroReturning = false;
async function backToLive() {
  if (!outroActive() || outro.phase === 'returning' || outroReturning) return;
  if (connState !== 'connected' || outro.host !== connHost) return toast('Connect to the same console first');
  outroReturning = true;
  try {
    await load(Object.keys(outro.sends).map(outroLevel));
  } finally {
    outroReturning = false;
  }
  const wasEnded = outro.phase === 'ended' || outro.phase === 'muting';
  const grp = outro.grouped ? outroGroup() : null;
  if (grp && grp.muted) {
    grp.muted = false; // inputs come back at their own levels
    saveMix();
    reconcileMutes(outro.bus);
    if (currentView === 'sends') rerenderCurrent();
  }
  for (const [id, e] of Object.entries(outro.sends)) {
    if (e.skip) continue;
    if (outro.grouped && !e.play && e.restored) {
      e.done = true; // already back at its level under the group
      continue;
    }
    const p = outroLevel(id);
    if (!known(p)) continue;
    const cur = state.get(p);
    // Changed since the fade finished (by hand, a scene, another app): keep it.
    if (wasEnded && Math.abs(cur - e.to) > SEND_TOL) {
      e.skip = true;
      continue;
    }
    Object.assign(e, { from: cur, to: e.saved });
  }
  outroLast.clear();
  Object.assign(outro, { phase: 'returning', progress: 0 });
  saveOutro();
  renderOutroPill();
  if (currentView === 'sermon') renderSermonView();
}

function finishOutro() {
  // Playback sends we switched on go back off, unless someone changed them.
  for (const [id, was] of Object.entries(outro.playOn)) {
    const e = outro.sends[id];
    const p = outroOnPath(id);
    if (e && !e.skip && known(p) && state.get(p) === 1) setParam(p, was);
  }
  Object.assign(outro, { phase: 'idle', host: null, bus: null, progress: 0, sends: {}, playOn: {}, grouped: false, noGroup: false });
  outroLast.clear();
  saveOutro();
  renderOutroPill();
  toast('Back to live · stream sends restored');
  if (currentView === 'sermon') renderSermonView();
}

function outroTick() {
  if (!outroActive() || connState !== 'connected' || outro.host !== connHost) return;
  if (outro.phase === 'muting') return outroMuteStep();
  if (outro.phase === 'ended') {
    // The operator unmuted the group themselves (e.g. at the start of the next
    // service): that is "back to live", so the playback goes back down too.
    const grp = outro.grouped ? outroGroup() : null;
    if (outro.grouped && (!grp || !grp.muted)) backToLive();
    return;
  }
  outro.progress = Math.min(1, outro.progress + OUTRO_TICK_MS / 1000 / Math.max(1, outro.fadeSec));
  for (const [id, e] of Object.entries(outro.sends)) {
    if (e.skip || e.done) continue;
    const p = outroLevel(id);
    if (!known(p)) continue;
    const last = outroLast.get(p);
    if (dragging.has(p) || (last !== undefined && Math.abs(state.get(p) - last) > SEND_TOL)) {
      e.skip = true; // moved by hand: their level wins
      continue;
    }
    const v = e.from + (e.to - e.from) * outro.progress;
    if (Math.abs(v - state.get(p)) > 1e-6) setParam(p, v);
    outroLast.set(p, v);
  }
  if (outro.progress >= 1) {
    if (outro.phase === 'returning') return finishOutro();
    outro.phase = 'muting';
    return outroMuteStep();
  }
  const now = Date.now();
  if (now - outroSavedAt > 1000) {
    outroSavedAt = now;
    saveOutro();
  }
  refreshOutroCard();
}
setInterval(outroTick, OUTRO_TICK_MS);

function openOutroSetup(startAfter = false) {
  const draft = { bus: sermon.bus, playback: [...outro.playback], playbackDb: outro.playbackDb, fadeSec: outro.fadeSec };
  const body = el('div', { class: 'sermon-setup' });
  const sources = () => [...X32.strips('ch'), ...X32.strips('auxin')];
  function render() {
    const picks = sources().map((s) =>
      el('button', {
        class: `toggle pick${draft.playback.includes(s.id) ? ' on' : ''}`,
        text: nameOf(s),
        onclick: () => {
          draft.playback = draft.playback.includes(s.id) ? draft.playback.filter((x) => x !== s.id) : [...draft.playback, s.id];
          render();
        },
      }),
    );
    const range = (label, key, min, max, step, fmt) => {
      const input = el('input', { type: 'range', min, max, step, value: draft[key] });
      const out = el('output', { text: fmt(draft[key]) });
      input.addEventListener('input', () => {
        draft[key] = Number(input.value);
        out.textContent = fmt(draft[key]);
      });
      return el('label', { class: 'slider' }, [el('span', { class: 'slider-label', text: label }), input, out]);
    };
    // First-time setup without Sermon mode: the stream bus is chosen here too.
    let busRow = null;
    if (!sermon.bus) {
      const busSel = el('select', {}, [el('option', { value: '', text: '— Choose bus —' }), ...X32.strips('bus').map((b) => el('option', { value: b.n, text: `${b.defaultName} · ${nameOf(b)}` }))]);
      busSel.value = draft.bus || '';
      busSel.addEventListener('change', () => {
        draft.bus = Number(busSel.value) || null;
      });
      busRow = el('div', { class: 'setup-row' }, [el('span', { class: 'switch-label', text: 'Live stream bus' }), busSel]);
    }
    body.replaceChildren(
      ...[busRow].filter(Boolean),
      el('div', { class: 'pick-title', text: 'Playback channel(s)' }),
      el('div', { class: 'hint', text: 'The computer / media player that plays the music behind the closing slides (pick both sides if it is stereo).' }),
      el('div', { class: 'pick-grid' }, picks),
      el('div', { class: 'pick-title', text: 'Fade' }),
      range('Playback level', 'playbackDb', -20, FADER_MAX_DB, 1, (v) => `${v > 0 ? '+' : ''}${v} dB`),
      range('Fade time', 'fadeSec', 3, 30, 1, (v) => `${v} s`),
    );
  }
  const close = () => dlg.remove();
  const save = () => {
    outro.playback = X32.ALL_STRIPS.filter((s) => draft.playback.includes(s.id)).map((s) => s.id);
    outro.playbackDb = draft.playbackDb;
    outro.fadeSec = draft.fadeSec;
    saveOutro();
    if (!sermon.bus && draft.bus) {
      sermon.bus = draft.bus;
      saveSermon();
      load(sermonPaths());
    }
    close();
    if (currentView === 'sermon') renderSermonView();
    if (startAfter && sermon.bus && outro.playback.length) confirmOutro();
  };
  const dlg = el('div', { class: 'modal-back', onclick: (e) => e.target === dlg && close() }, [
    el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [el('strong', { text: 'End of service setup' })]),
      el('div', { class: 'modal-body' }, [body]),
      el('div', { class: 'modal-foot' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', { class: 'primary', text: startAfter ? 'Save and continue' : 'Save', onclick: save }),
      ]),
    ]),
  ]);
  render();
  document.body.append(dlg);
}

function confirmOutro() {
  const s = streamStrip();
  if (!s || !outro.playback.length) return openOutroSetup(true);
  const names = outro.playback.map((id) => nameOf(srcStrip(id))).join(' + ');
  const db = `${outro.playbackDb > 0 ? '+' : ''}${outro.playbackDb} dB`;
  const lev = sermon.on ? ' Sermon mode turns off.' : '';
  confirmDialog(
    'Fade the stream to playback?',
    `Over ${outro.fadeSec} s, every input on ${nameOf(s)} fades down and ${names} fades up to ${db}. Then the inputs are held off by the “End of service” mute group on ${nameOf(s)} and their stream levels go back to normal underneath it. Only the live stream changes: the room, wedges and faders stay as they are.${lev} Next service, unmute that group (or click Back to live).`,
    'Fade to playback',
    startOutro,
  );
}

function renderOutroPill() {
  const pill = $('outroPill');
  pill.hidden = !outroActive();
  pill.textContent = outro.phase === 'ended' || outro.phase === 'muting' ? 'STREAM: PLAYBACK ONLY' : outro.phase === 'returning' ? 'Stream: back to live…' : 'Stream: fading to playback…';
}

let outroEls = null;
// Always shown: it needs only a stream bus and a playback channel, not Sermon
// mode or the clip guard.
function OutroCard() {
  const s = streamStrip();
  const names = outro.playback.map((id) => nameOf(srcStrip(id))).join(' + ');
  const bar = el('div', { class: 'outro-bar' });
  const status = el('div', { class: 'hint' });
  const busy = outro.phase === 'ending' || outro.phase === 'returning';
  const main = !outroActive()
    ? el('button', { class: 'primary big-btn', text: 'Fade stream to playback', onclick: confirmOutro })
    : el('button', { class: 'primary big-btn', text: outro.phase === 'returning' ? 'Returning…' : 'Back to live', disabled: outro.phase === 'returning', onclick: backToLive });
  outroEls = { bar, status };
  return el('div', { class: `stream-card outro-card${outroActive() ? ' active' : ''}` }, [
    el('div', { class: 'stream-head' }, [
      el('div', {}, [
        el('div', { class: 'sermon-title', text: 'End of service' }),
        el('div', { class: 'hint', text: s && outro.playback.length ? `Fades every input on ${nameOf(s)} down and brings up ${names} for the closing slides. The room is not affected.` : 'For the closing slides: fades the inputs down on the live stream and brings up the playback. Click Setup… to choose the stream bus and the playback channel.' }),
      ]),
      el('button', { class: 'ghost', text: 'Setup…', disabled: outroActive(), onclick: () => openOutroSetup(false) }),
    ]),
    busy ? el('div', { class: 'outro-meter' }, [bar]) : null,
    el('div', { class: 'outro-row' }, [main, status]),
  ]);
}

function refreshOutroCard() {
  if (!outroEls || currentView !== 'sermon') return;
  const { bar, status } = outroEls;
  const pct = Math.round(outro.progress * 100);
  bar.style.width = `${pct}%`;
  const entries = Object.entries(outro.sends);
  const inputs = entries.filter(([, e]) => !e.play && !e.skip).length;
  const kept = entries.filter(([, e]) => e.skip).length;
  const keptTxt = kept ? ` · ${kept} moved by hand, left where you put ${kept === 1 ? 'it' : 'them'}` : '';
  const offline = connState !== 'connected' || outro.host !== connHost;
  const playOff = outro.playback.some((id) => known(outroOnPath(id)) && state.get(outroOnPath(id)) !== 1);
  let text;
  if (outro.phase === 'idle') text = outro.playback.length ? `Playback ${outro.playbackDb > 0 ? '+' : ''}${outro.playbackDb} dB · fade ${outro.fadeSec} s` : '';
  else if (offline) text = 'Paused: not connected to this console. It carries on when the console is back.';
  else if (outro.phase === 'ending') text = `Fading ${inputs} input${inputs === 1 ? '' : 's'} down, playback up… ${pct}%${keptTxt}`;
  else if (outro.phase === 'returning') text = `Back to live… ${pct}%${keptTxt}`;
  else if (outro.phase === 'muting') text = 'Muting the inputs with the End of service group and putting their levels back…';
  else if (outro.noGroup) text = `The stream is on playback only. ${inputs} input${inputs === 1 ? '' : 's'} faded down${keptTxt}. Click Back to live to bring them up.`;
  else text = `The stream is on playback only. ${inputs} input${inputs === 1 ? '' : 's'} muted by the “End of service” mute group (Monitor mixes), at their normal levels${keptTxt}. Next service: unmute that group or click Back to live; the playback goes back down too.`;
  if (outroActive() && playOff) text += ' Warning: a playback send is switched off (a mix mute group?), so the stream may be silent.';
  status.textContent = text;
}

$('sermonPill').addEventListener('click', () => showView('sermon'));
$('outroPill').addEventListener('click', () => showView('sermon'));
renderSermonPill();
renderOutroPill();

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const VIEWS = ['mixer', 'sends', 'sermon', 'fx', 'scenes'];
let currentView = 'mixer';

function rerenderCurrent() {
  if (currentView === 'mixer') {
    renderMixer();
    if (selectedId) renderDetail(selectedId);
  } else if (currentView === 'sends') {
    renderSends();
    if (selectedId) renderDetail(selectedId); // the panel is open here too
  } else if (currentView === 'fx') renderFx();
  else if (currentView === 'scenes') renderScenes();
  else if (currentView === 'sermon') renderSermonView();
}

function showView(name) {
  if (!VIEWS.includes(name)) name = 'mixer';
  currentView = name;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.view === name);
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  // One channel panel, shown under whichever console view is open.
  if (name === 'mixer' || name === 'sends') $(`view-${name}`).append($('detail'));
  store.setItem('view', name);
  if (name === 'mixer') {
    renderLayerBar();
    renderMixer();
  } else mixerScope.dispose();
  if (name === 'sends') {
    renderBusBar();
    renderSends();
  } else sendScope.dispose();
  if (name === 'fx') renderFx();
  else fxScope.dispose();
  if (name === 'sermon') {
    if (sermon.bus) load(sermonPaths());
    renderSermonView();
  }
  if (name === 'scenes') renderScenes();
  else sceneScope.dispose();
}
$('tabs').addEventListener('click', (e) => {
  if (e.target.dataset.view) showView(e.target.dataset.view);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openMenu) return closeMenu(); // first Escape closes the menu only
  if (e.target.matches('input, select')) return;
  select(null);
});

// A normal mouse wheel scrolls the strip rows sideways (no Shift needed), except
// over a fader or knob, which handle the wheel themselves.
for (const id of ['mixerStrips', 'sendStrips']) {
  const row = $(id);
  row.addEventListener('wheel', (e) => {
    if (e.defaultPrevented || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    row.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
}

// Mouse users can also grab a strip row anywhere that isn't a control and drag it
// left or right. Touch already scrolls natively.
const PAN_BLOCK = 'button, input, select, label, .fader, .pan, .knob, [role="slider"]';
const PAN_SLOP = 5; // px of movement before a press becomes a drag, so clicks still work
for (const id of ['mixerStrips', 'sendStrips']) {
  const row = $(id);
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest(PAN_BLOCK)) return;
    if (e.target === row && (e.offsetX >= row.clientWidth || e.offsetY >= row.clientHeight)) return; // scrollbar
    const startX = e.clientX;
    const startLeft = row.scrollLeft;
    let panning = false;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!(ev.buttons & 1)) return end(ev); // released outside the window
      const dx = ev.clientX - startX;
      if (!panning) {
        if (Math.abs(dx) < PAN_SLOP) return;
        panning = true;
        row.classList.add('panning');
      }
      row.scrollLeft = startLeft - dx;
    };
    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      if (!panning) return;
      row.classList.remove('panning');
      // A drag that began on a strip name or EQ picture must not also open it.
      const swallow = (c) => c.stopPropagation();
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  });
}

// ---------------------------------------------------------------------------
// Settings: screen size and auto-reconnect
// ---------------------------------------------------------------------------
const ZOOMS = [
  ['Small', 0.9],
  ['Normal', 1],
  ['Large', 1.15],
  ['Extra large', 1.3],
];
const applyZoom = () => window.x32.setZoom(Number(store.getItem('zoom')) || 1);
applyZoom();
const autoConnect = () => store.getItem('autoConnect') !== 'false';

$('settingsBtn').addEventListener('click', (e) => {
  const zoom = Number(store.getItem('zoom')) || 1;
  showMenu(e, 'Settings', [
    ...ZOOMS.map(([label, f]) => ({
      label: `Screen size: ${label}`,
      checked: zoom === f,
      action: () => {
        store.setItem('zoom', String(f));
        applyZoom();
      },
    })),
    'sep',
    {
      label: 'Reconnect to last console on start',
      checked: autoConnect(),
      action: () => store.setItem('autoConnect', String(!autoConnect())),
    },
  ]);
});
document.body.classList.add(`platform-${window.x32.platform}`);

(async function init() {
  for (const [p, v] of await window.x32.snapshot()) apply(p, v);
  showView(store.getItem('view') || 'mixer');
  const st = await window.x32.status();
  const host = store.getItem('host');
  if (autoConnect() && host && st.state === 'disconnected') window.x32.connect(host);
})();
