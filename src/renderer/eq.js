// EQ response math (RBJ biquads) used to draw the curve. Display only.
(function () {
  'use strict';
  const FS = 48000;

  function coeffs(type, f, g, q) {
    const w0 = (2 * Math.PI * f) / FS;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const A = Math.pow(10, g / 40);
    switch (type) {
      case 0: { // low cut (high-pass)
        const a = sin / (2 * 0.707);
        return [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + a, -2 * cos, 1 - a];
      }
      case 5: { // high cut (low-pass)
        const a = sin / (2 * 0.707);
        return [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + a, -2 * cos, 1 - a];
      }
      case 1: { // low shelf
        const a = sin / (2 * Math.min(q, 1.5));
        const s = 2 * Math.sqrt(A) * a;
        return [
          A * (A + 1 - (A - 1) * cos + s), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - s),
          A + 1 + (A - 1) * cos + s, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - s,
        ];
      }
      case 4: { // high shelf
        const a = sin / (2 * Math.min(q, 1.5));
        const s = 2 * Math.sqrt(A) * a;
        return [
          A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s),
          A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s,
        ];
      }
      default: { // PEQ / VEQ
        const a = sin / (2 * q);
        return [1 + a * A, -2 * cos, 1 - a * A, 1 + a / A, -2 * cos, 1 - a / A];
      }
    }
  }

  function magDb(c, f) {
    const w = (2 * Math.PI * f) / FS;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
    const dr = c[3] + c[4] * c1 + c[5] * c2, di = -(c[4] * s1 + c[5] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  // bands: [{type, f, g, q}] in real units. Returns dB at each frequency in `freqs`.
  function response(bands, freqs) {
    const cs = bands.map((b) => coeffs(b.type, b.f, b.g, b.q));
    return freqs.map((f) => cs.reduce((sum, c) => sum + magDb(c, f), 0));
  }

  self.EQMath = { response, hasGain: (type) => type >= 1 && type <= 4 };
})();
