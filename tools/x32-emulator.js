#!/usr/bin/env node
'use strict';
// A small X32 stand-in for developing without a console. It answers value
// queries, accepts sets, pushes changes to /xremote clients, streams simulated
// meters, and supports scene save/recall. Usage: node tools/x32-emulator.js [port]
const dgram = require('node:dgram');
const osc = require('../src/main/osc');
const X32 = require('../src/shared/x32');

function defaults() {
  const st = new Map();
  for (const s of X32.ALL_STRIPS) {
    for (const p of [...X32.overviewPaths(s), ...X32.detailPaths(s)]) {
      const leaf = p.slice(p.lastIndexOf('/') + 1);
      let v;
      if (leaf === 'name') v = '';
      else if (leaf === 'color') v = s.kind === 'ch' ? 1 + ((s.n - 1) >> 2) % 7 : s.kind === 'bus' ? 4 : 0;
      else if (p === s.fader) v = s.kind === 'ch' || s.kind === 'main' || s.kind === 'dca' ? 0.75 : 0.5;
      else if (leaf === 'on') v = p.includes('/gate/') || p.includes('/dyn/') ? 0 : 1;
      else if (leaf === 'level') v = 0.5;
      else if (leaf === 'pan' || leaf === 'trim') v = 0.5;
      else if (leaf === 'type') v = 2;
      else if (leaf === 'f') v = 0.2 + 0.2 * Number(p.split('/').at(-2));
      else if (leaf === 'g') v = 0.5;
      else if (leaf === 'q') v = 0.46;
      else if (leaf === 'ratio') v = 5;
      else if (leaf === 'mix') v = 1;
      else if (leaf === 'source') v = s.kind === 'ch' ? s.n : 0;
      else if (leaf === 'index') v = s.kind === 'ch' ? s.n - 1 : -1;
      else if (X32.typeOf(p) === 'i') v = 0;
      else v = 0.4;
      st.set(p, v);
    }
  }
  for (const p of X32.globalPaths()) st.set(p, X32.typeOf(p) === 's' ? '' : 0);
  for (let i = 0; i < 128; i++) {
    st.set(X32.headampPath(i, 'gain'), 0.35);
    st.set(X32.headampPath(i, 'phantom'), 0);
  }
  for (let n = 1; n <= X32.FX_SLOTS; n++) {
    st.set(X32.fxTypePath(n), [0, 10, 13, 5, 28, 28, 28, 28][n - 1]);
    for (let i = 1; i <= X32.FX_PARAMS; i++) st.set(X32.fxParPath(n, i), 0.5);
  }
  st.set('/ch/01/eq/1/type', 0);
  st.set('/ch/01/eq/1/f', 0.12);
  st.set('/ch/01/eq/2/g', 0.75);
  st.set('/ch/01/eq/2/f', 0.15);
  st.set('/ch/01/dyn/on', 1);
  st.set('/ch/01/gate/on', 1);
  st.set('/ch/09/eq/3/g', 0.68);
  st.set('/ch/09/eq/4/type', 4);
  st.set('/ch/09/eq/4/f', 0.86);
  st.set('/ch/09/eq/4/g', 0.62);
  st.set('/ch/09/preamp/hpon', 1);
  st.set('/ch/09/preamp/hpf', 0.5);
  st.set('/ch/09/dyn/on', 1);
  st.set('/ch/01/config/name', 'Kick');
  st.set('/ch/02/config/name', 'Snare');
  st.set('/ch/09/config/name', 'Vocal');
  st.set('/bus/01/config/name', 'Wedge 1');
  st.set(X32.CURRENT_SCENE_PATH, 0);
  for (let i = 0; i < X32.SCENE_COUNT; i++) st.set(X32.sceneNamePath(i), i === 0 ? 'Default' : '');
  return st;
}

function startEmulator(port = 10023, { quiet = false } = {}) {
  const state = defaults();
  const scenes = new Map([[0, snapshotParams(state)]]);
  const forced = new Map(); // stripId -> 'clip' | 'silent' | 'low' (test scenarios)
  const remotes = new Map(); // "ip:port" -> {rinfo, until}
  const meterSubs = new Map(); // "ip:port|path" -> {rinfo, path, until}
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const log = (...a) => quiet || console.log(...a);
  const key = (r) => `${r.address}:${r.port}`;
  const reply = (r, address, args) => sock.send(osc.encode(address, args), r.port, r.address);
  const typed = (p, v) => ({ type: X32.typeOf(p), value: v });

  function push(path, value, except) {
    const now = Date.now();
    for (const [k, c] of remotes) {
      if (c.until < now) remotes.delete(k);
      else if (k !== except) reply(c.rinfo, path, [typed(path, value)]);
    }
  }

  function snapshotParams(st) {
    return new Map([...st].filter(([p]) => !p.startsWith('/-')));
  }

  sock.on('message', (buf, r) => {
    let msg;
    try {
      msg = osc.decode(buf);
    } catch {
      return;
    }
    const { address, args } = msg;
    switch (address) {
      case '/info':
        return reply(r, '/info', ['V2.07', 'osc-server', 'X32', '4.06']);
      case '/xinfo':
        return reply(r, '/xinfo', ['127.0.0.1', 'X32-EMULATOR', 'X32', '4.06']);
      case '/status':
        return reply(r, '/status', ['active', '127.0.0.1', 'X32-EMULATOR']);
      case '/xremote':
        remotes.set(key(r), { rinfo: r, until: Date.now() + 10000 });
        return;
      case '/meters':
        meterSubs.set(`${key(r)}|${args[0]}`, { rinfo: r, path: args[0], until: Date.now() + 10000 });
        return;
      case '/emu/force': {
        // Test hook: /emu/force ,ss <stripId> <normal|clip|silent|low>
        const [id, mode] = args;
        if (mode === 'normal') forced.delete(id);
        else forced.set(id, mode);
        return;
      }
      case '/-action/clearsolo': {
        for (const s of X32.ALL_STRIPS) {
          if (state.get(s.solo)) {
            state.set(s.solo, 0);
            push(s.solo, 0);
          }
        }
        state.set('/-stat/solo', 0);
        push('/-stat/solo', 0);
        return;
      }
      case '/-action/goscene': {
        const n = args[0] | 0;
        const snap = scenes.get(n);
        if (!snap) return;
        for (const [p, v] of snap) {
          if (state.get(p) !== v) {
            state.set(p, v);
            push(p, v);
          }
        }
        state.set(X32.CURRENT_SCENE_PATH, n);
        push(X32.CURRENT_SCENE_PATH, n);
        log(`recalled scene ${n}`);
        return;
      }
      case '/save': {
        const [what, n, name] = args;
        if (what !== 'scene') return;
        scenes.set(n, snapshotParams(state));
        state.set(X32.sceneNamePath(n), name || '');
        push(X32.sceneNamePath(n), name || '');
        log(`saved scene ${n} "${name}"`);
        return;
      }
      case '/delete': {
        const [what, n] = args;
        if (what !== 'scene') return;
        scenes.delete(n);
        state.set(X32.sceneNamePath(n), '');
        push(X32.sceneNamePath(n), '');
        return;
      }
      default:
        break;
    }
    if (!state.has(address)) return;
    if (args.length === 0) return reply(r, address, [typed(address, state.get(address))]);
    state.set(address, args[0]);
    push(address, args[0], key(r));
    if (address.startsWith('/-stat/solosw/')) {
      const any = X32.ALL_STRIPS.some((s) => state.get(s.solo)) ? 1 : 0;
      if (state.get('/-stat/solo') !== any) {
        state.set('/-stat/solo', any);
        push('/-stat/solo', any);
      }
    }
  });

  const groupMuted = (s) => {
    const mask = s.grpMute ? state.get(s.grpMute) | 0 : 0;
    for (let g = 1; g <= X32.MUTE_GROUPS; g++) if (mask & (1 << (g - 1)) && state.get(X32.muteGroupPath(g))) return true;
    return false;
  };

  // Simulated meters: level follows the fader, with some movement.
  let t = 0;
  const meterTimer = setInterval(() => {
    t += 0.05;
    const now = Date.now();
    const lvl = (s, i) => {
      if (!s) return 0;
      const f = state.get(s.fader) ?? 0;
      const on = state.get(s.on) ?? 1;
      const wobble = 0.6 + 0.4 * Math.sin(t * (1.3 + (i % 7) * 0.4) + i);
      const mode = forced.get(s.id);
      if (mode === 'silent') return 0;
      if (mode === 'clip') return 1;
      const v = on && !groupMuted(s) ? Math.min(0.95, f * f * wobble * 1.1) : 0;
      return mode === 'low' ? v * 0.03 : v;
    };
    const gr = (s, kind, i) => {
      if (!s || !state.get(`${s.prefix}/${kind}/on`)) return 1;
      return 1 - 0.5 * Math.max(0, Math.sin(t * 2 + i));
    };
    const banks = {
      '/meters/0': Array.from({ length: 70 }, (_, i) => {
        const s = X32.ALL_STRIPS.find((x) => x.meter && x.meter[0] === 0 && x.meter[1] === i);
        return lvl(s, i);
      }),
      '/meters/1': Array.from({ length: 96 }, (_, i) => {
        const s = X32.STRIP_BY_ID[`ch${(i % 32) + 1}`];
        return i < 32 ? lvl(s, i) : gr(s, i < 64 ? 'gate' : 'dyn', i);
      }),
      '/meters/2': Array.from({ length: 49 }, (_, i) =>
        i < 16 ? lvl(X32.STRIP_BY_ID[`bus${i + 1}`], i)
          : i === 22 || i === 23 ? lvl(X32.STRIP_BY_ID.main1, i)
            : i === 24 ? lvl(X32.STRIP_BY_ID.mono1, i) : 0,
      ),
    };
    for (const [k, sub] of meterSubs) {
      if (sub.until < now) {
        meterSubs.delete(k);
        continue;
      }
      const values = banks[sub.path];
      if (values) reply(sub.rinfo, sub.path, [{ type: 'b', value: osc.encodeMeterBlob(values) }]);
    }
  }, 50);

  return new Promise((resolve) => {
    sock.bind(port, () => {
      log(`X32 emulator listening on udp/${sock.address().port}`);
      resolve({
        port: sock.address().port,
        state,
        close: () => {
          clearInterval(meterTimer);
          sock.close();
        },
      });
    });
  });
}

if (require.main === module) startEmulator(Number(process.argv[2]) || 10023);

module.exports = { startEmulator };
