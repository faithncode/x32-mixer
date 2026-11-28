'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/main/store');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x32-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('settings survive a restart', (t) => {
  const dir = tmp(t);
  const a = createStore(dir);
  assert.equal(a.load(), null);
  a.set('mixGroups', '{"15":{}}');
  a.flush();
  assert.deepEqual(createStore(dir).load(), { mixGroups: '{"15":{}}' });
});

test('a damaged settings file falls back to the backup and keeps it', (t) => {
  const dir = tmp(t);
  const a = createStore(dir);
  a.set('bus', '15');
  a.flush();
  a.set('bus', '16');
  a.flush();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"bu');
  const b = createStore(dir);
  assert.deepEqual(b.load(), { bus: '15' });
  b.set('view', 'sermon');
  b.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8')), { bus: '15' });
  assert.deepEqual(createStore(dir).load(), { bus: '15', view: 'sermon' });
});
