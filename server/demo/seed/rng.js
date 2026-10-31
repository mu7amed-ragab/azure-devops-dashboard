/**
 * Seeded randomness for the demo organization, so the same seed always
 * produces the same people, work and history (only the dates move with
 * today). mulberry32 — tiny, fast and good enough for invented content.
 */
function mulberry32(seed) {
  let a = seed >>> 0;

  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(min, max) {
    return min + Math.floor(next() * (max - min + 1));
  }

  function pick(arr) {
    return arr[Math.floor(next() * arr.length)];
  }

  function chance(p) {
    return next() < p;
  }

  function shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function hex(length) {
    let s = '';
    while (s.length < length) s += Math.floor(next() * 16).toString(16);
    return s;
  }

  function guid() {
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
  }

  return { next, int, pick, chance, shuffle, hex, guid };
}

module.exports = { mulberry32 };
