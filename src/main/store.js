'use strict';
// The app's settings (mix groups, stream bus, mappings, screen choices) in one
// JSON file in the user's app data folder. Written atomically with a backup of
// the previous version, so a power cut or forced shutdown can't wipe them.
const fs = require('node:fs');
const path = require('node:path');

function createStore(dir, { delayMs = 300 } = {}) {
  const file = path.join(dir, 'settings.json');
  const backup = `${file}.bak`;
  const read = (f) => {
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  };
  const main = read(file);
  const loaded = main || read(backup);
  let data = loaded || {};
  let mainIsGood = Boolean(main); // never copy a damaged file over the backup
  let timer = null;

  function flush() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 1));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (mainIsGood) fs.copyFileSync(file, backup);
      fs.renameSync(tmp, file);
      mainIsGood = true;
    } catch (err) {
      console.error(`Could not save settings: ${err.message}`);
      timer = setTimeout(flush, 2000); // e.g. an antivirus scan holding the file
    }
  }

  return {
    // null when nothing has ever been saved
    load: () => (loaded || Object.keys(data).length ? { ...data } : null),
    set(key, value) {
      data[key] = value;
      timer ||= setTimeout(flush, delayMs);
    },
    flush,
  };
}

module.exports = { createStore };
