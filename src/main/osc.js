'use strict';
// Minimal OSC 1.0 codec covering the types the X32 uses: i, f, s, b.

function pad4(n) {
  return (n + 3) & ~3;
}

function encodeString(str) {
  const raw = Buffer.from(str, 'utf8');
  const buf = Buffer.alloc(pad4(raw.length + 1));
  raw.copy(buf);
  return buf;
}

function encodeBlob(data) {
  const buf = Buffer.alloc(4 + pad4(data.length));
  buf.writeInt32BE(data.length, 0);
  Buffer.from(data).copy(buf, 4);
  return buf;
}

/**
 * Encode an OSC message.
 * args: array of {type: 'i'|'f'|'s'|'b', value} or plain JS values
 * (integers -> i only when wrapped; numbers default to f, strings -> s).
 */
function encode(address, args = []) {
  const typed = args.map((a) => {
    if (a && typeof a === 'object' && 'type' in a) return a;
    if (typeof a === 'string') return { type: 's', value: a };
    if (Buffer.isBuffer(a)) return { type: 'b', value: a };
    return { type: 'f', value: Number(a) };
  });
  const parts = [encodeString(address), encodeString(',' + typed.map((a) => a.type).join(''))];
  for (const a of typed) {
    switch (a.type) {
      case 'i': {
        const b = Buffer.alloc(4);
        b.writeInt32BE(a.value | 0, 0);
        parts.push(b);
        break;
      }
      case 'f': {
        const b = Buffer.alloc(4);
        b.writeFloatBE(a.value, 0);
        parts.push(b);
        break;
      }
      case 's':
        parts.push(encodeString(String(a.value)));
        break;
      case 'b':
        parts.push(encodeBlob(a.value));
        break;
      default:
        throw new Error(`Unsupported OSC type ${a.type}`);
    }
  }
  return Buffer.concat(parts);
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error('Unterminated OSC string');
  return { value: buf.toString('utf8', offset, end), next: pad4(end + 1) };
}

/** Decode one OSC message. Returns {address, types, args} where args are plain values (blobs as Buffer). */
function decode(buf) {
  const addr = readString(buf, 0);
  if (!addr.value.startsWith('/')) throw new Error('Not an OSC message');
  if (addr.next >= buf.length) return { address: addr.value, types: '', args: [] };
  const tags = readString(buf, addr.next);
  if (!tags.value.startsWith(',')) return { address: addr.value, types: '', args: [] };
  const types = tags.value.slice(1);
  let off = tags.next;
  const args = [];
  for (const t of types) {
    switch (t) {
      case 'i':
        args.push(buf.readInt32BE(off));
        off += 4;
        break;
      case 'f':
        args.push(buf.readFloatBE(off));
        off += 4;
        break;
      case 's': {
        const s = readString(buf, off);
        args.push(s.value);
        off = s.next;
        break;
      }
      case 'b': {
        const len = buf.readInt32BE(off);
        args.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + pad4(len);
        break;
      }
      default:
        throw new Error(`Unsupported OSC type tag ${t}`);
    }
  }
  return { address: addr.value, types, args };
}

/**
 * X32 meter blobs: the OSC blob holds an int32 little-endian count followed by
 * that many float32 little-endian values (linear, 1.0 = 0 dBFS).
 */
function decodeMeterBlob(blob) {
  if (blob.length < 4) return [];
  const count = blob.readInt32LE(0);
  const n = Math.max(0, Math.min(count, Math.floor((blob.length - 4) / 4)));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = blob.readFloatLE(4 + i * 4);
  return out;
}

function encodeMeterBlob(values) {
  const b = Buffer.alloc(4 + values.length * 4);
  b.writeInt32LE(values.length, 0);
  values.forEach((v, i) => b.writeFloatLE(v, 4 + i * 4));
  return b;
}

const int = (value) => ({ type: 'i', value });
const float = (value) => ({ type: 'f', value });
const str = (value) => ({ type: 's', value });

module.exports = { encode, decode, decodeMeterBlob, encodeMeterBlob, int, float, str };
