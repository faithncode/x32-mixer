'use strict';
const dgram = require('node:dgram');
const os = require('node:os');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const osc = require('./osc');
const X32 = require('../shared/x32');

const X32_PORT = 10023;
const XREMOTE_INTERVAL_MS = 8000; // console drops /xremote clients after 10 s
const METER_RENEW_MS = 9000; // meter subscriptions also last 10 s
const LINK_TIMEOUT_MS = 6000;
const QUEUE_TICK_MS = 5;
const QUERY_RATE_PER_MS = 0.8; // ~800 queries/s keeps the console's UDP input from overflowing
const QUERY_RETRY_MS = 1000; // re-ask if no reply (UDP can drop packets)
const QUERY_TRIES = 3;
const METER_BANKS = [0, 1, 2];

/**
 * UDP/OSC session with one X32. Emits:
 *  'status' {state: 'disconnected'|'connecting'|'connected'|'lost', host, info?, error?}
 *  'updates' Array<[path, value]>   (batched every ~16 ms)
 *  'meters'  {bank, values}
 */
class X32Client extends EventEmitter {
  constructor() {
    super();
    this.state = new Map();
    this.socket = null;
    this.host = null;
    this.port = X32_PORT;
    this.queue = [];
    this.queued = new Set();
    this.pending = [];
    this.timers = [];
    this.status = { state: 'disconnected' };
    this.lastRx = 0;
    this.info = null;
    this.inflight = new Map(); // path -> {at, tries}
    this.gen = 0;
    this.lastPump = 0;
    this.wasLost = false;
  }

  connect(host, port = X32_PORT) {
    this.disconnect();
    const gen = ++this.gen;
    this.host = host;
    this.port = port;
    this.state.clear();
    this.info = null;
    this.wasLost = false;
    const sock = dgram.createSocket('udp4');
    this.socket = sock;
    sock.on('message', (msg, rinfo) => {
      // Only accept packets from the console we talk to (when addressed by IP).
      if (net.isIP(this.host) && rinfo.address !== this.host) return;
      try {
        this._onPacket(msg);
      } catch {
        /* never let one bad packet take the app down */
      }
    });
    // A single send error (e.g. a full network buffer) is not a lost link; the
    // receive timeout below decides that.
    sock.on('error', () => {});
    this._setStatus({ state: 'connecting' });

    return new Promise((resolve) => {
      sock.once('close', resolve); // a newer connect() closed this one before bind finished
      sock.bind(0, () => {
        if (gen !== this.gen) return resolve();
        this.lastPump = Date.now();
        const ping = () => this.send('/info');
        ping();
        const every = (fn, ms) => this.timers.push(setInterval(fn, ms));
        every(() => {
          if (this.status.state !== 'connected') ping();
        }, 1000);
        every(() => this.send('/xremote'), XREMOTE_INTERVAL_MS);
        every(() => this._subscribeMeters(), METER_RENEW_MS);
        every(() => this._pumpQueue(), QUEUE_TICK_MS);
        every(() => this._flushUpdates(), 16);
        every(() => this._retryQueries(), 250);
        every(() => {
          if (this.status.state === 'connected' && Date.now() - this.lastRx > LINK_TIMEOUT_MS) {
            this.wasLost = true;
            this._setStatus({ state: 'lost', error: 'No reply from console' });
            // Meters would otherwise freeze on the last level.
            for (const [bank, n] of Object.entries(X32.METER_BANKS)) this.emit('meters', { bank: Number(bank), values: new Array(n).fill(0) });
          }
        }, 1000);
        resolve();
      });
    });
  }

  disconnect() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.queue = [];
    this.queued.clear();
    this.inflight.clear();
    this.pending = [];
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    if (this.status.state !== 'disconnected') this._setStatus({ state: 'disconnected' });
  }

  send(address, args = []) {
    if (!this.socket) return;
    const buf = osc.encode(address, args);
    try {
      this.socket.send(buf, this.port, this.host);
    } catch {
      /* socket closing */
    }
  }

  /** Set a parameter; value type comes from the path unless given. */
  set(path, value, type = X32.typeOf(path)) {
    if (typeof path !== 'string' || !path.startsWith('/')) return;
    if (type !== 's' && !Number.isFinite(value)) return; // never put NaN on the wire
    const v = type === 'i' ? Math.round(value) : value;
    this.state.set(path, v);
    this.send(path, [{ type, value: v }]);
  }

  /** Queue value queries (address with no arguments); console replies with the value. */
  query(paths) {
    for (const p of paths) {
      if (this.queued.has(p)) continue;
      this.queued.add(p);
      this.queue.push(p);
    }
  }

  snapshot(paths) {
    const out = [];
    for (const p of paths || this.state.keys()) if (this.state.has(p)) out.push([p, this.state.get(p)]);
    return out;
  }

  _onPacket(buf) {
    let msg;
    try {
      msg = osc.decode(buf);
    } catch {
      return; // ignore malformed datagrams
    }
    this.lastRx = Date.now();
    const { address, args } = msg;

    if (address === '/info' || address === '/status' || address === '/xinfo') {
      if (address === '/info') this.info = { version: args[0], serverName: args[1], model: args[2], firmware: args[3] };
      if (this.status.state !== 'connected') this._onConnected();
      return;
    }
    if (this.status.state !== 'connected') this._onConnected();

    if (address.startsWith('/meters/')) {
      const bank = Number(address.slice(8));
      if (Buffer.isBuffer(args[0])) this.emit('meters', { bank, values: osc.decodeMeterBlob(args[0]) });
      return;
    }
    if (args.length === 0) return;
    const value = args[0];
    this.inflight.delete(address);
    this.state.set(address, value);
    this.pending.push([address, value]);
  }

  _onConnected() {
    // After a real outage the console may have changed (reboot, scene recall from
    // its own screen), so nothing cached is trusted: start from a clean slate.
    const resync = this.wasLost;
    this.wasLost = false;
    if (resync) {
      this.state.clear();
      this.queue = [];
      this.queued.clear();
      this.inflight.clear();
    }
    if (!this.info) this.send('/info');
    this._setStatus({ state: 'connected', info: this.info || {}, resync });
    this.send('/xremote');
    this._subscribeMeters();
    // Load the console overview; details are requested on demand by the UI.
    const paths = [];
    for (const s of X32.ALL_STRIPS) paths.push(...X32.overviewPaths(s));
    paths.push(...X32.globalPaths());
    this.query(paths);
  }

  _subscribeMeters() {
    if (this.status.state !== 'connected') return;
    for (const b of METER_BANKS) this.send('/meters', [osc.str(`/meters/${b}`)]);
  }

  _pumpQueue() {
    const now = Date.now();
    const budget = Math.min(40, Math.floor((now - this.lastPump) * QUERY_RATE_PER_MS));
    if (budget < 1) return;
    this.lastPump = now;
    if (this.status.state !== 'connected') return;
    for (let i = 0; i < budget && this.queue.length; i++) {
      const p = this.queue.shift();
      this.queued.delete(p);
      const f = this.inflight.get(p);
      this.inflight.set(p, { at: now, tries: f ? f.tries + 1 : 1 });
      this.send(p);
    }
  }

  // Re-ask for values whose reply never came.
  _retryQueries() {
    if (this.status.state !== 'connected') return;
    const now = Date.now();
    for (const [p, f] of this.inflight) {
      if (now - f.at < QUERY_RETRY_MS || this.queued.has(p)) continue;
      if (f.tries >= QUERY_TRIES) {
        this.inflight.delete(p);
        continue;
      }
      this.queued.add(p);
      this.queue.push(p);
    }
  }

  _flushUpdates() {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.emit('updates', batch);
  }

  _setStatus(s) {
    if (s.state === 'connected' && this.info) s.info = this.info;
    this.status = { ...s, host: this.host };
    this.emit('status', this.status);
  }
}

/** Broadcast /xinfo on every IPv4 interface and collect replies. */
function discover(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf, rinfo) => {
      try {
        const { address, args } = osc.decode(buf);
        if (address !== '/xinfo') return;
        const [ip, name, model, firmware] = args;
        found.set(rinfo.address, { ip: rinfo.address, reportedIp: ip, name, model, firmware });
      } catch {
        /* ignore */
      }
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const msg = osc.encode('/xinfo');
      const targets = new Set(['255.255.255.255']);
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family !== 'IPv4' || a.internal) continue;
          const ip = a.address.split('.').map(Number);
          const mask = a.netmask.split('.').map(Number);
          targets.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
        }
      }
      targets.add('127.0.0.1'); // local emulator
      for (const t of targets) sock.send(msg, X32_PORT, t, () => {});
    });
    setTimeout(() => {
      sock.close();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

module.exports = { X32Client, discover, X32_PORT };
