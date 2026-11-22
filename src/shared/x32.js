// X32 parameter model shared by the main process, the renderer and the emulator.
// Paths, ranges and meter layouts follow the publicly documented X32 OSC protocol
// (firmware 2.x+/4.x). Values on the wire are normalized floats 0..1 unless noted.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.X32 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad2 = (n) => String(n).padStart(2, '0');

  // ---- Strip kinds -------------------------------------------------------
  // meter: [bank, firstIndex] into /meters/<bank> arrays (one value per strip;
  // main is stereo and handled specially).
  // solo: first index (0-based) into /-stat/solosw/01..80.
  // groups: strip can be assigned to DCAs / mute groups via /grp/dca and /grp/mute bitmasks.
  const KINDS = {
    ch: { label: 'Ch', count: 32, prefix: (n) => `/ch/${pad2(n)}`, eqBands: 4, gate: true, dyn: true, preamp: true, source: true, pan: true, sends: 16, meter: [0, 0], solo: 0, groups: true },
    auxin: { label: 'Aux', count: 8, prefix: (n) => `/auxin/${pad2(n)}`, eqBands: 4, preamp: true, pan: true, sends: 16, meter: [0, 32], solo: 32, groups: true },
    fxrtn: { label: 'FX', count: 8, prefix: (n) => `/fxrtn/${pad2(n)}`, eqBands: 4, pan: true, sends: 16, meter: [0, 40], solo: 40, groups: true },
    bus: { label: 'Bus', count: 16, prefix: (n) => `/bus/${pad2(n)}`, eqBands: 6, dyn: true, pan: true, sends: 6, meter: [0, 48], solo: 48, groups: true },
    mtx: { label: 'Mtx', count: 6, prefix: (n) => `/mtx/${pad2(n)}`, eqBands: 6, dyn: true, meter: [0, 64], solo: 64 },
    main: { label: 'Main', count: 1, prefix: () => '/main/st', eqBands: 6, dyn: true, pan: true, sends: 6, meter: [2, 22], solo: 70 },
    mono: { label: 'M/C', count: 1, prefix: () => '/main/m', eqBands: 6, dyn: true, sends: 6, meter: [2, 24], solo: 71 },
    dca: { label: 'DCA', count: 8, prefix: (n) => `/dca/${n}`, dca: true, solo: 72 },
  };

  function strip(kind, n) {
    const k = KINDS[kind];
    const p = k.prefix(n);
    return {
      id: `${kind}${n}`,
      kind,
      n,
      prefix: p,
      defaultName: kind === 'main' ? 'Main LR' : kind === 'mono' ? 'Mono' : `${k.label} ${pad2(n)}`,
      shortLabel: kind === 'main' ? 'LR' : kind === 'mono' ? 'M/C' : `${k.label} ${n}`,
      caps: k,
      fader: k.dca ? `${p}/fader` : `${p}/mix/fader`,
      on: k.dca ? `${p}/on` : `${p}/mix/on`,
      pan: k.pan ? `${p}/mix/pan` : null,
      name: `${p}/config/name`,
      color: `${p}/config/color`,
      solo: `/-stat/solosw/${pad2(k.solo + n)}`,
      grpDca: k.groups ? `${p}/grp/dca` : null,
      grpMute: k.groups ? `${p}/grp/mute` : null,
      source: k.source ? `${p}/config/source` : null,
      meter: k.meter ? [k.meter[0], k.meter[1] + n - 1] : null,
    };
  }

  function strips(kind) {
    const out = [];
    for (let n = 1; n <= KINDS[kind].count; n++) out.push(strip(kind, n));
    return out;
  }

  const ALL_STRIPS = Object.keys(KINDS).flatMap(strips);
  const STRIP_BY_ID = Object.fromEntries(ALL_STRIPS.map((s) => [s.id, s]));

  // Send paths from a source strip to bus/matrix number `to`.
  function sendLevel(s, to) {
    return `${s.prefix}/mix/${pad2(to)}/level`;
  }
  function sendOn(s, to) {
    return `${s.prefix}/mix/${pad2(to)}/on`;
  }

  // ---- Value types -------------------------------------------------------
  const INT_LEAVES = new Set(['on', 'type', 'mode', 'ratio', 'color', 'hpon', 'invert', 'det', 'env', 'auto', 'current', 'phantom', 'source', 'dca', 'mute', 'index']);
  function typeOf(path) {
    if (path.startsWith('/-stat/solosw/') || path.startsWith('/config/mute/') || path === '/-stat/solo') return 'i';
    const leaf = path.slice(path.lastIndexOf('/') + 1);
    if (leaf === 'name') return 's';
    if (INT_LEAVES.has(leaf)) return 'i';
    return 'f';
  }

  // ---- Sources & headamps -------------------------------------------------
  // Channel input source (/ch/NN/config/source, int 0..64):
  // 0 OFF, 1-32 In 1-32, 33-38 Aux 1-6, 39-40 USB L/R, 41-48 FX 1L..4R, 49-64 Bus 1-16.
  // "In N" is a routing slot, not a physical socket (stage boxes re-route them),
  // so the source alone does not say which preamp to control.
  function sourceName(src) {
    if (src <= 0) return 'OFF';
    if (src <= 32) return `In ${src}`;
    if (src <= 38) return `Aux ${src - 32}`;
    if (src === 39) return 'USB L';
    if (src === 40) return 'USB R';
    if (src <= 48) return `FX ${Math.ceil((src - 40) / 2)}${src % 2 ? 'L' : 'R'}`;
    if (src <= 64) return `Bus ${src - 48}`;
    return `Src ${src}`;
  }
  const SOURCE_OPTIONS = Array.from({ length: 65 }, (_, i) => sourceName(i));
  // The console reports which physical preamp feeds each channel / aux input:
  // /-ha/00..31 = Ch 1-32, /-ha/32..39 = Aux in 1-8; value 0..127 or -1 (none).
  const haIndexPath = (s) => (s.kind === 'ch' ? `/-ha/${pad2(s.n - 1)}/index` : s.kind === 'auxin' ? `/-ha/${pad2(31 + s.n)}/index` : null);
  const headampPath = (idx, leaf) => `/headamp/${String(idx).padStart(3, '0')}/${leaf}`;
  // Physical preamp names: 0-31 local, 32-79 AES50 A, 80-127 AES50 B.
  function headampName(idx) {
    if (idx < 32) return `Local in ${idx + 1}`;
    if (idx < 80) return `AES50 A ${idx - 31}`;
    return `AES50 B ${idx - 79}`;
  }

  // ---- Groups, solo, FX --------------------------------------------------
  const MUTE_GROUPS = 6;
  const DCA_COUNT = 8;
  const muteGroupPath = (g) => `/config/mute/${g}`;
  const FX_SLOTS = 8;
  const FX_PARAMS = 16;
  const fxTypePath = (n) => `/fx/${n}/type`;
  const fxParPath = (n, i) => `/fx/${n}/par/${pad2(i)}`;
  const FX_TYPES = ['HALL', 'AMBI', 'RPLT', 'ROOM', 'CHAM', 'PLAT', 'VREV', 'VRM', 'GATE', 'RVRS', 'DLY', '3TAP', '4TAP', 'CRS', 'FLNG', 'PHAS', 'DIMC', 'FILT', 'ROTA', 'PAN', 'SUB', 'D/RV', 'CR/R', 'FL/R', 'D/CR', 'D/FL', 'MODD', 'GEQ2', 'GEQ', 'TEQ2', 'TEQ', 'DES2', 'DES', 'P1A', 'P1A2', 'PQ5', 'PQ5S', 'WAVD', 'LIM', 'CMB', 'CMB2', 'FAC', 'FAC1M', 'FAC2', 'LEC', 'LEC2', 'ULC', 'ULC2', 'ENH2', 'ENH', 'EXC2', 'EXC', 'IMG', 'EDI', 'SON', 'AMP2', 'AMP', 'DRV2', 'DRV', 'PIT2', 'PIT'];

  // ---- Parameter lists ---------------------------------------------------
  /** Loaded for every strip at connect. */
  function overviewPaths(s) {
    const out = [s.name, s.color, s.fader, s.on, s.solo];
    if (s.pan) out.push(s.pan);
    return out;
  }

  /** Loaded when a strip is on screen: what the strip's thumbnails and badges show. */
  function stripViewPaths(s) {
    const c = s.caps;
    const p = s.prefix;
    const out = [];
    if (c.eqBands) {
      out.push(`${p}/eq/on`);
      for (let b = 1; b <= c.eqBands; b++) for (const k of ['type', 'f', 'g', 'q']) out.push(`${p}/eq/${b}/${k}`);
    }
    if (c.gate) out.push(`${p}/gate/on`);
    if (c.dyn) out.push(`${p}/dyn/on`);
    if (s.kind === 'ch') out.push(`${p}/preamp/hpon`, `${p}/preamp/hpf`);
    if (c.preamp) out.push(`${p}/preamp/invert`);
    if (s.source) out.push(s.source);
    if (s.grpDca) out.push(s.grpDca, s.grpMute);
    return out;
  }

  function globalPaths() {
    const out = ['/-stat/solo', CURRENT_SCENE_PATH];
    for (let g = 1; g <= MUTE_GROUPS; g++) out.push(muteGroupPath(g));
    for (let n = 1; n <= FX_SLOTS; n++) out.push(fxTypePath(n));
    for (let i = 0; i < SCENE_COUNT; i++) out.push(sceneNamePath(i));
    return out;
  }

  function detailPaths(s) {
    const c = s.caps;
    const p = s.prefix;
    const out = [...stripViewPaths(s)];
    if (c.preamp) out.push(`${p}/preamp/trim`);
    if (haIndexPath(s)) out.push(haIndexPath(s));
    if (c.gate) for (const k of GATE_KEYS) if (k !== 'on') out.push(`${p}/gate/${k}`);
    if (c.dyn) for (const k of DYN_KEYS) if (k !== 'on') out.push(`${p}/dyn/${k}`);
    if (c.sends) for (let b = 1; b <= c.sends; b++) out.push(sendLevel(s, b), sendOn(s, b));
    return out;
  }

  // Settings copied by channel copy/paste: the sound processing only (trim,
  // polarity, low cut, EQ, gate, compressor), as suffixes relative to the strip
  // prefix. Level, mute, pan, monitor/bus sends, name, color, source and group
  // assignments always stay with the target strip.
  function copyableSuffixes(s) {
    const skip = new Set([s.name, s.color, s.source, s.grpDca, s.grpMute, s.solo, s.fader, s.on, s.pan]);
    return detailPaths(s)
      .filter((p) => !skip.has(p) && p.startsWith(s.prefix + '/') && !p.startsWith(s.prefix + '/mix/'))
      .map((p) => p.slice(s.prefix.length));
  }

  const GATE_KEYS = ['on', 'mode', 'thr', 'range', 'attack', 'hold', 'release'];
  const DYN_KEYS = ['on', 'mode', 'det', 'env', 'thr', 'ratio', 'knee', 'mgain', 'attack', 'hold', 'release', 'mix', 'auto'];

  // ---- Conversions -------------------------------------------------------
  function faderToDb(f) {
    if (f <= 0) return -Infinity;
    if (f >= 0.5) return f * 40 - 30;
    if (f >= 0.25) return f * 80 - 50;
    if (f >= 0.0625) return f * 160 - 70;
    return f * 480 - 90;
  }
  function dbToFader(db) {
    let f;
    if (db <= -90) f = 0;
    else if (db < -60) f = (db + 90) / 480;
    else if (db < -30) f = (db + 70) / 160;
    else if (db < -10) f = (db + 50) / 80;
    else f = (db + 30) / 40;
    return Math.min(1, Math.max(0, f));
  }
  const lin = (min, max) => ({
    toUnit: (v) => min + v * (max - min),
    fromUnit: (u) => Math.min(1, Math.max(0, (u - min) / (max - min))),
  });
  const log = (min, max) => ({
    toUnit: (v) => min * Math.pow(max / min, v),
    fromUnit: (u) => Math.min(1, Math.max(0, Math.log(u / min) / Math.log(max / min))),
  });

  const fmtDb = (db) => (db === -Infinity ? '-∞' : (db > 0 ? '+' : '') + db.toFixed(1));
  const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + 'k' : hz.toFixed(0));
  const fmtMs = (ms) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

  // Display descriptors keyed by a param "role".
  const PARAMS = {
    fader: { label: 'Level', fmt: (v) => fmtDb(faderToDb(v)) + ' dB' },
    pan: { label: 'Pan', map: lin(-100, 100), fmt: (u) => (Math.abs(u) < 1 ? 'C' : u < 0 ? 'L' + Math.round(-u) : 'R' + Math.round(u)) },
    trim: { label: 'Trim', map: lin(-18, 18), fmt: (u) => fmtDb(u) + ' dB' },
    hpf: { label: 'Low cut', map: log(20, 400), fmt: (u) => fmtHz(u) + ' Hz' },
    eqF: { label: 'Freq', map: log(20, 20000), fmt: (u) => fmtHz(u) + ' Hz' },
    eqG: { label: 'Gain', map: lin(-15, 15), fmt: (u) => fmtDb(u) + ' dB' },
    eqQ: { label: 'Q', map: log(10, 0.3), fmt: (u) => u.toFixed(1) },
    gateThr: { label: 'Threshold', map: lin(-80, 0), fmt: (u) => u.toFixed(1) + ' dB' },
    gateRange: { label: 'Range', map: lin(3, 60), fmt: (u) => u.toFixed(1) + ' dB' },
    attack: { label: 'Attack', map: lin(0, 120), fmt: (u) => u.toFixed(0) + ' ms' },
    hold: { label: 'Hold', map: log(0.02, 2000), fmt: (u) => fmtMs(u) + ' ms' },
    release: { label: 'Release', map: log(5, 4000), fmt: (u) => fmtMs(u) + ' ms' },
    dynThr: { label: 'Threshold', map: lin(-60, 0), fmt: (u) => u.toFixed(1) + ' dB' },
    knee: { label: 'Knee', map: lin(0, 5), fmt: (u) => u.toFixed(0) },
    headamp: { label: 'Gain', map: lin(-12, 60), fmt: (u) => fmtDb(u) + ' dB' },
    fxPar: { label: 'Param', fmt: (v) => (v * 100).toFixed(0) + '%' },
    mgain: { label: 'Makeup', map: lin(0, 24), fmt: (u) => u.toFixed(1) + ' dB' },
    mix: { label: 'Mix', map: lin(0, 100), fmt: (u) => u.toFixed(0) + '%' },
  };
  for (const d of Object.values(PARAMS)) {
    if (d.map && !d.display) d.display = (v) => d.fmt(d.map.toUnit(v));
    if (!d.display) d.display = d.fmt;
  }

  const ENUMS = {
    eqType: ['LCut', 'LShv', 'PEQ', 'VEQ', 'HShv', 'HCut'],
    gateMode: ['EXP2', 'EXP3', 'EXP4', 'GATE', 'DUCK'],
    dynMode: ['COMP', 'EXP'],
    dynDet: ['PEAK', 'RMS'],
    dynEnv: ['LIN', 'LOG'],
    ratio: ['1.1', '1.3', '1.5', '2.0', '2.5', '3.0', '4.0', '5.0', '7.0', '10', '20', '100'],
  };
  const RATIO_VALUES = [1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100];

  // Scribble-strip colors 0..15 (8..15 are the inverted variants).
  const COLORS = ['#3a3d44', '#e5484d', '#46a758', '#f5d90a', '#3e63dd', '#d23197', '#05a2c2', '#e8e8e8'];
  const COLOR_NAMES = ['Off', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
  const colorOf = (i) => COLORS[(i | 0) % 8];

  // ---- Meters ------------------------------------------------------------
  // /meters/0: 70 = 32 ch, 8 aux, 8 fx-return sides, 16 bus, 6 mtx
  // /meters/1: 96 = 32 ch, 32 gate gain reduction, 32 dyn gain reduction
  // /meters/2: 49 = 16 bus, 6 mtx, 2 main LR, 1 mono, 16 bus GR, 6 mtx GR, 1 LR GR, 1 mono GR
  const METER_BANKS = { 0: 70, 1: 96, 2: 49 };

  // ---- Scenes ------------------------------------------------------------
  const SCENE_COUNT = 100;
  const sceneNamePath = (i) => `/-show/showfile/scene/${String(i).padStart(3, '0')}/name`;
  const CURRENT_SCENE_PATH = '/-show/prepos/current';

  return {
    KINDS, strip, strips, ALL_STRIPS, STRIP_BY_ID, sendLevel, sendOn,
    typeOf, overviewPaths, stripViewPaths, detailPaths, globalPaths, copyableSuffixes, GATE_KEYS, DYN_KEYS,
    sourceName, SOURCE_OPTIONS, haIndexPath, headampPath, headampName,
    MUTE_GROUPS, DCA_COUNT, muteGroupPath, FX_SLOTS, FX_PARAMS, fxTypePath, fxParPath, FX_TYPES,
    faderToDb, dbToFader, fmtDb, fmtHz, PARAMS, ENUMS, RATIO_VALUES,
    COLORS, COLOR_NAMES, colorOf, METER_BANKS,
    SCENE_COUNT, sceneNamePath, CURRENT_SCENE_PATH, pad2,
  };
});
