// ChronoTask icon generator — pure Node, no image libraries.
// Rasterizes an alarm-clock glyph with signed-distance fields, encodes PNG + ICO.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// ---------- ICO encoding (PNG-compressed entries) ----------
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = Buffer.alloc(16 * entries.length);
  const parts = [];
  entries.forEach((e, i) => {
    const p = 16 * i;
    dir[p] = e.size === 256 ? 0 : e.size;
    dir[p + 1] = e.size === 256 ? 0 : e.size;
    dir[p + 2] = 0; dir[p + 3] = 0;
    dir.writeUInt16LE(1, p + 4);  // planes
    dir.writeUInt16LE(32, p + 6); // bpp
    dir.writeUInt32LE(e.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.data.length;
    parts.push(e.data);
  });
  return Buffer.concat([header, dir, ...parts]);
}

// ---------- SDF helpers ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function sdCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return Math.hypot(dx, dy) - r;
}
function sdRoundBox(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - (hx - r);
  const qy = Math.abs(y - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = x - ax, wy = y - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(wx - vx * t, wy - vy * t);
}
// coverage of a shape with `thickness` half-width, using distance `d`
function cov(d, edge) {
  return Math.max(0, Math.min(1, 0.5 - d / edge));
}

const C = {
  shellTop: hex('#23252b'),
  shellBot: hex('#0c0e12'),
  ring: hex('#464555'),
  indigo: hex('#4f46e5'),
  lavender: hex('#c3c0ff'),
  face: hex('#e2dfff'),
  hand: hex('#1d00a5'),
  mint: hex('#4edea3'),
};

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const edge = 1.6 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      let r = 0, g = 0, b = 0, a = 0;
      const over = (col, alpha) => {
        if (alpha <= 0) return;
        const na = alpha + a * (1 - alpha);
        r = (col[0] * alpha + r * a * (1 - alpha)) / na;
        g = (col[1] * alpha + g * a * (1 - alpha)) / na;
        b = (col[2] * alpha + b * a * (1 - alpha)) / na;
        a = na;
      };

      // shell: rounded square with a hairline ring
      const box = sdRoundBox(x, y, 0.5, 0.5, 0.47, 0.47, 0.21);
      const t = Math.max(0, Math.min(1, y));
      over([
        Math.round(C.shellTop[0] * (1 - t) + C.shellBot[0] * t),
        Math.round(C.shellTop[1] * (1 - t) + C.shellBot[1] * t),
        Math.round(C.shellTop[2] * (1 - t) + C.shellBot[2] * t),
      ], cov(box, edge));
      over(C.ring, cov(Math.abs(box + 0.012) - 0.008, edge));

      // alarm legs + bells
      over(C.lavender, cov(sdSegment(x, y, 0.345, 0.80, 0.285, 0.905) - 0.024, edge));
      over(C.lavender, cov(sdSegment(x, y, 0.655, 0.80, 0.715, 0.905) - 0.024, edge));
      over(C.lavender, cov(sdCircle(x, y, 0.315, 0.275, 0.085), edge));
      over(C.lavender, cov(sdCircle(x, y, 0.685, 0.275, 0.085), edge));

      // body + face
      over(C.indigo, cov(sdCircle(x, y, 0.5, 0.545, 0.315), edge));
      over(C.face, cov(sdCircle(x, y, 0.5, 0.545, 0.225), edge));

      // hands: 12 o'clock + ~4 o'clock, plus hub
      over(C.hand, cov(sdSegment(x, y, 0.5, 0.545, 0.5, 0.385) - 0.026, edge));
      over(C.hand, cov(sdSegment(x, y, 0.5, 0.545, 0.615, 0.612) - 0.022, edge));
      over(C.hand, cov(sdCircle(x, y, 0.5, 0.545, 0.032), edge));

      // mint "scheduler armed" dot with dark ring
      over(C.shellBot, cov(sdCircle(x, y, 0.775, 0.255, 0.082), edge));
      over(C.mint, cov(sdCircle(x, y, 0.775, 0.255, 0.055), edge));

      const i = py * size * 4 + px * 4;
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

const pngs = {};
for (const s of [32, 48, 128, 256, 512]) pngs[s] = encodePNG(s, render(s));

fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[512]);
fs.writeFileSync(path.join(OUT, '32x32.png'), pngs[32]);
fs.writeFileSync(path.join(OUT, '128x128.png'), pngs[128]);
fs.writeFileSync(path.join(OUT, '128x128@2x.png'), pngs[256]);
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeICO([
  { size: 32, data: pngs[32] },
  { size: 48, data: pngs[48] },
  { size: 256, data: pngs[256] },
]));

for (const f of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, f));
  console.log(f.padEnd(18), st.size, 'bytes');
}
