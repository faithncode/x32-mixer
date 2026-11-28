'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { X32Client, discover } = require('./x32client');
const { createStore } = require('./store');

// Dev/test runs can use their own settings folder so they never touch the user's.
if (process.env.X32_USERDATA) app.setPath('userData', process.env.X32_USERDATA);

// One window only: a second copy would overwrite the first one's saved settings.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

const store = createStore(app.getPath('userData'));
ipcMain.on('store:load', (e) => {
  e.returnValue = store.load();
});
ipcMain.on('store:set', (_e, key, value) => store.set(key, value));
app.on('will-quit', () => store.flush());

const client = new X32Client();
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#15171b',
    title: 'X32 Mixer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep timers running at full rate when the window is hidden or covered
      // (meters, alerts and Sermon mode must keep working).
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  devHooks(win);
  win.on('closed', () => {
    win = null;
  });
}

const toRenderer = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

client.on('status', (s) => toRenderer('x32:status', s));
client.on('updates', (batch) => toRenderer('x32:updates', batch));

// Forward meters at most ~25 fps per bank. Packets in between are folded in with
// a per-value maximum, so short peaks (clips) are never dropped.
const lastMeter = {};
const heldMeter = {};
client.on('meters', ({ bank, values }) => {
  const held = heldMeter[bank];
  if (held && held.length === values.length) for (let i = 0; i < values.length; i++) held[i] = Math.max(held[i], values[i]);
  else heldMeter[bank] = values.slice();
  const now = Date.now();
  if (now - (lastMeter[bank] || 0) < 40) return;
  lastMeter[bank] = now;
  toRenderer('x32:meters', { bank, values: heldMeter[bank] });
  heldMeter[bank] = null;
});

// X32_PORT lets test runs talk to an emulator on a non-standard port.
const devPort = () => Number(process.env.X32_PORT) || undefined;
ipcMain.handle('x32:connect', (_e, host, port) => client.connect(host, port || devPort()));
ipcMain.handle('x32:disconnect', () => client.disconnect());
ipcMain.handle('x32:discover', () => discover());
ipcMain.handle('x32:status', () => client.status);
ipcMain.handle('x32:query', (_e, paths) => {
  client.query(paths);
  return client.snapshot(paths);
});
ipcMain.handle('x32:snapshot', () => client.snapshot());
ipcMain.on('x32:set', (_e, p, value) => client.set(p, value));
ipcMain.on('x32:command', (_e, address, args) => client.send(address, args));

// Development helpers: X32_AUTOCONNECT=<host> connects on launch; X32_CAPTURE=<dir>
// runs X32_SCRIPT (JS evaluated in the page, steps separated by "|||"), saving a
// screenshot after each step, then quits. Renderer console errors go to stdout.
function devHooks(w) {
  w.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer] ${message} (${source}:${line})`);
  });
  if (process.env.X32_WINDOW) {
    const [w2, h2] = process.env.X32_WINDOW.split('x').map(Number);
    w.setMinimumSize(640, 480);
    w.setContentSize(w2, h2);
  }
  if (process.env.X32_AUTOCONNECT) {
    w.webContents.once('did-finish-load', () => client.connect(process.env.X32_AUTOCONNECT, devPort()));
  }
  const dir = process.env.X32_CAPTURE;
  if (!dir) return;
  const fs = require('node:fs');
  const steps = (process.env.X32_SCRIPT || '').split('|||').filter((s) => s.trim());
  w.webContents.once('did-finish-load', async () => {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    await pause(2500);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i <= steps.length; i++) {
      if (i > 0) {
        try {
          await w.webContents.executeJavaScript(steps[i - 1]);
        } catch (err) {
          console.log(`[capture] step ${i} failed: ${err.message}`);
        }
        await pause(1200);
      }
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `step${i}.png`), img.toPNG());
    }
    app.quit();
  });
}

app.whenReady().then(() => {
  if (!primary) return;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  client.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
