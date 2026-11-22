'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const osc = require('../src/main/osc');
const X32 = require('../src/shared/x32');
const { X32Client } = require('../src/main/x32client');
const { startEmulator } = require('../tools/x32-emulator');

test('OSC round-trips i/f/s/b and pads to 4 bytes', () => {
  const blob = Buffer.from([1, 2, 3]);
  const buf = osc.encode('/ch/01/mix/fader', [osc.float(0.75), osc.int(3), 'abc', blob]);
  assert.equal(buf.length % 4, 0);
  const m = osc.decode(buf);
  assert.equal(m.address, '/ch/01/mix/fader');
  assert.equal(m.types, 'fisb');
  assert.equal(m.args[0], 0.75);
  assert.equal(m.args[1], 3);
  assert.equal(m.args[2], 'abc');
  assert.deepEqual([...m.args[3]], [1, 2, 3]);
});

test('address-only query encodes with empty type tag', () => {
  const m = osc.decode(osc.encode('/info'));
  assert.equal(m.address, '/info');
  assert.deepEqual(m.args, []);
});

test('meter blob is little-endian count + floats', () => {
  const vals = osc.decodeMeterBlob(osc.encodeMeterBlob([0.5, 0.25]));
  assert.deepEqual(vals, [0.5, 0.25]);
});

test('malformed meter blob never throws', () => {
  const b = Buffer.alloc(8);
  b.writeInt32LE(-1, 0);
  assert.deepEqual(osc.decodeMeterBlob(b), []);
});

test('client reloads cleanly after the console goes away and comes back', async (t) => {
  let emu = await startEmulator(0, { quiet: true });
  const port = emu.port;
  const c = new X32Client();
  t.after(() => {
    c.disconnect();
    emu.close();
  });
  const statuses = [];
  c.on('status', (s) => statuses.push(s));
  c.on('error', () => {});
  await c.connect('127.0.0.1', port);
  const until = (fn, ms) =>
    new Promise((res, rej) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (fn()) {
          clearInterval(iv);
          res();
        } else if (Date.now() - start > ms) {
          clearInterval(iv);
          rej(new Error('timeout'));
        }
      }, 50);
    });
  await until(() => c.state.get('/ch/01/config/name') === 'Kick', 4000);
  // A socket error alone must not drop the link.
  c.socket.emit('error', new Error('ENOBUFS'));
  assert.equal(c.status.state, 'connected');
  emu.close();
  await until(() => c.status.state === 'lost', 9000);
  emu = await startEmulator(port, { quiet: true });
  emu.state.set('/ch/01/config/name', 'Changed');
  await until(() => c.status.state === 'connected', 5000);
  assert.equal(statuses.at(-1).resync, true);
  assert.equal(c.status.info.model, 'X32');
  await until(() => c.state.get('/ch/01/config/name') === 'Changed', 5000);
});

test('fader law matches X32 breakpoints', () => {
  assert.equal(X32.faderToDb(0.75), 0);
  assert.equal(X32.faderToDb(1), 10);
  assert.equal(X32.faderToDb(0.5), -10);
  assert.equal(X32.faderToDb(0.25), -30);
  assert.equal(X32.faderToDb(0.0625), -60);
  assert.equal(X32.faderToDb(0), -Infinity);
  for (const db of [-80, -45, -20, -3, 0, 6]) assert.ok(Math.abs(X32.faderToDb(X32.dbToFader(db)) - db) < 1e-9);
});

test('param mappings invert', () => {
  for (const key of ['eqF', 'eqQ', 'hpf', 'release', 'gateThr']) {
    const m = X32.PARAMS[key].map;
    assert.ok(Math.abs(m.fromUnit(m.toUnit(0.3)) - 0.3) < 1e-9, key);
  }
  assert.equal(Math.round(X32.PARAMS.eqF.map.toUnit(1)), 20000);
});

test('solo, group and headamp addressing', () => {
  assert.equal(X32.STRIP_BY_ID.ch1.solo, '/-stat/solosw/01');
  assert.equal(X32.STRIP_BY_ID.bus16.solo, '/-stat/solosw/64');
  assert.equal(X32.STRIP_BY_ID.main1.solo, '/-stat/solosw/71');
  assert.equal(X32.STRIP_BY_ID.dca8.solo, '/-stat/solosw/80');
  assert.equal(X32.haIndexPath(X32.STRIP_BY_ID.ch1), '/-ha/00/index');
  assert.equal(X32.haIndexPath(X32.STRIP_BY_ID.auxin8), '/-ha/39/index');
  assert.equal(X32.haIndexPath(X32.STRIP_BY_ID.bus1), null);
  assert.equal(X32.SOURCE_OPTIONS.length, 65);
  assert.equal(X32.sourceName(33), 'Aux 1');
  assert.equal(X32.sourceName(41), 'FX 1L');
  assert.equal(X32.sourceName(64), 'Bus 16');
  assert.equal(X32.typeOf('/-ha/00/index'), 'i');
  assert.equal(X32.headampPath(5, 'gain'), '/headamp/005/gain');
  assert.equal(X32.typeOf('/-stat/solosw/01'), 'i');
  assert.equal(X32.typeOf('/config/mute/3'), 'i');
  assert.equal(X32.typeOf('/ch/01/grp/dca'), 'i');
  assert.equal(X32.typeOf('/fx/1/par/01'), 'f');
  const suffixes = X32.copyableSuffixes(X32.STRIP_BY_ID.ch1);
  assert.ok(suffixes.includes('/eq/1/f') && suffixes.includes('/dyn/thr') && suffixes.includes('/preamp/hpf'));
  for (const no of ['/config/name', '/config/source', '/mix/fader', '/mix/on', '/mix/pan', '/mix/01/level', '/mix/16/on']) assert.ok(!suffixes.includes(no), no);
});

test('types inferred from leaf', () => {
  assert.equal(X32.typeOf('/ch/01/mix/on'), 'i');
  assert.equal(X32.typeOf('/ch/01/config/name'), 's');
  assert.equal(X32.typeOf('/ch/01/eq/2/f'), 'f');
  assert.equal(X32.typeOf('/ch/01/dyn/ratio'), 'i');
});

test('client syncs with emulator: overview, sets, push, meters, scenes', async (t) => {
  const emu = await startEmulator(0, { quiet: true });
  const a = new X32Client();
  const b = new X32Client();
  t.after(() => {
    a.disconnect();
    b.disconnect();
    emu.close();
  });
  const wait = (fn, ms = 4000) =>
    new Promise((res, rej) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (fn()) {
          clearInterval(iv);
          res();
        } else if (Date.now() - start > ms) {
          clearInterval(iv);
          rej(new Error('timeout'));
        }
      }, 20);
    });

  let meters = 0;
  a.on('meters', ({ bank, values }) => {
    if (bank === 0 && values.length === 70) meters++;
  });
  await a.connect('127.0.0.1', emu.port);
  await b.connect('127.0.0.1', emu.port);
  await wait(() => a.status.state === 'connected' && b.status.state === 'connected');
  assert.equal(a.status.info.model, 'X32');

  await wait(() => a.state.get('/ch/01/config/name') === 'Kick' && a.state.has(X32.sceneNamePath(99)));
  await wait(() => meters > 2);

  // A change from client a reaches client b through /xremote.
  a.set('/ch/05/mix/fader', 0.3);
  await wait(() => Math.abs((b.state.get('/ch/05/mix/fader') ?? 0) - 0.3) < 1e-6);
  a.set('/ch/05/mix/on', 0);
  await wait(() => b.state.get('/ch/05/mix/on') === 0);

  // Solo raises the global solo flag; clearsolo resets both.
  a.set(X32.STRIP_BY_ID.ch3.solo, 1);
  await wait(() => b.state.get('/-stat/solo') === 1);
  a.send('/-action/clearsolo', [osc.int(1)]);
  await wait(() => b.state.get('/-stat/solo') === 0 && b.state.get(X32.STRIP_BY_ID.ch3.solo) === 0);

  // Save a scene, change, recall, and b sees the restored value.
  a.send('/save', ['scene', osc.int(7), 'Sunday', '']);
  await wait(() => b.state.get(X32.sceneNamePath(7)) === 'Sunday');
  a.set('/ch/05/mix/fader', 0.9);
  await wait(() => Math.abs((b.state.get('/ch/05/mix/fader') ?? 0) - 0.9) < 1e-6);
  a.send('/-action/goscene', [osc.int(7)]);
  await wait(() => Math.abs((b.state.get('/ch/05/mix/fader') ?? 0) - 0.3) < 1e-6);
  await wait(() => b.state.get(X32.CURRENT_SCENE_PATH) === 7);
});
