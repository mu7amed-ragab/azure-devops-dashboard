const fs = require('fs');
const path = require('path');

/**
 * Two-tier cache: hot in-memory Map + JSON-on-disk persistence.
 * Disk persistence means a restart repaints instantly from the last known
 * good state instead of cold-calling Azure DevOps for everything.
 */
class Cache {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  get(key) {
    if (this.mem.has(key)) return this.mem.get(key);
    const file = this._file(key);
    if (fs.existsSync(file)) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.mem.set(key, value);
        return value;
      } catch (err) {
        return undefined;
      }
    }
    return undefined;
  }

  set(key, value) {
    this.mem.set(key, value);
    try {
      fs.writeFileSync(this._file(key), JSON.stringify(value), 'utf8');
    } catch (err) {
      // disk persistence is best-effort; memory cache still works this run
    }
  }

  /** Removes one entry from both the in-memory map and disk. Missing is a
   * no-op, not an error — a caller invalidating "whatever's there" shouldn't
   * have to check first. */
  delete(key) {
    this.mem.delete(key);
    try {
      fs.unlinkSync(this._file(key));
    } catch (err) {
      // already absent from disk — fine
    }
  }

  /** Every cache key present on disk or in memory (union, deduped). */
  keys() {
    const keys = new Set(this.mem.keys());
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.json')) keys.add(f.slice(0, -'.json'.length));
      }
    } catch (err) {
      // directory may not exist yet; memory keys are still returned
    }
    return [...keys];
  }
}

module.exports = { Cache };
