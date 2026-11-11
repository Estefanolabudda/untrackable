// Generates the extension icons (PNG) without external dependencies.
// Design: rounded teal square, white link bar cut before its (faded) query.
// Usage: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape coverage in unit coordinates [0,1]: returns [bgAlpha, fgAlpha].
// Same geometry as the inline SVG logo (24-unit grid): a link bar, a cut,
// and the faded rest of the query.
const U = 1 / 24;
function segDist(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
}
function sample(x, y) {
  const r = 6 * U; // corner radius
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  const inBg = dx * dx + dy * dy <= r * r;
  const half = 1.1 * U; // stroke width 2.2
  const bar = segDist(x, y, 5.5 * U, 12 * U, 12 * U, 12 * U) <= half;
  const cut = segDist(x, y, 13.6 * U, 16.4 * U, 16.4 * U, 7.6 * U) <= half;
  const dot = Math.hypot(x - 18.6 * U, y - 12 * U) <= half;
  return [inBg ? 1 : 0, inBg ? (bar || cut ? 1 : dot ? 0.55 : 0) : 0];
}

const BG = [0x0f, 0x5f, 0x56];
const FG = [0xff, 0xff, 0xff];
for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [b, f] = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          bg += b;
          fg += f;
        }
      }
      bg /= ss * ss;
      fg /= ss * ss;
      const t = bg > 0 ? fg / bg : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(BG[c] * (1 - t) + FG[c] * t);
      buf[i + 3] = Math.round(bg * 255);
    }
  }
  writeFileSync(new URL(`../apps/browser-extension/static/icons/icon-${size}.png`, import.meta.url), png(size, buf));
}
console.log('icons written');
