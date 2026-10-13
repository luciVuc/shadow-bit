// Generates the app icon with no external dependencies.
// The mark: a keyhole cut out of darkness, casting a long shadow — "ShadowBit".
// Renders an RGBA buffer via signed-distance fields, encodes PNG using
// Node's built-in zlib, and downscales to produce every platform format:
//   - build/icon.png   (1024x1024, Linux / source)
//   - build/icon.ico   (Windows, 16..256 multi-size PNG-in-ICO)
//   - build/icon.icns   (macOS, 16..1024 PNG chunks, no iconutil required)

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// --- tiny math helpers ----------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}
// Signed distance to a convex polygon (winding-number free, IQ).
function sdConvexPoly(px, py, v) {
  const n = v.length;
  let d = Infinity;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ex = v[j][0] - v[i][0];
    const ey = v[j][1] - v[i][1];
    const wx = px - v[i][0];
    const wy = py - v[i][1];
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= v[i][1];
    const c2 = py < v[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

// coverage from a signed distance (negative = inside), ~1px anti-aliasing
const cov = (sd) => clamp(0.5 - sd, 0, 1);

// alpha-over blend of a solid color onto an accumulator pixel
function over(dst, r, g, b, c) {
  const a = c;
  dst[0] = r * a + dst[0] * (1 - a);
  dst[1] = g * a + dst[1] * (1 - a);
  dst[2] = b * a + dst[2] * (1 - a);
  dst[3] = a + dst[3] * (1 - a);
}

// --- the keyhole mark -----------------------------------------------------
// A circle over a downward-tapering trapezoid: the universal keyhole glyph,
// here drawn as a hole punched through a lit surface, raking a shadow.
const KEYHOLE_CENTER = { x: 470, y: 430, r: 112 };
const KEYHOLE_STEM = [
  [470 - 60, 408],
  [470 + 60, 408],
  [470 + 120, 700],
  [470 - 120, 700],
];

function keyholeSd(px, py) {
  return Math.min(
    sdCircle(px, py, KEYHOLE_CENTER.x, KEYHOLE_CENTER.y, KEYHOLE_CENTER.r),
    sdConvexPoly(px, py, KEYHOLE_STEM),
  );
}

// The light sits up-and-left; the cast shadow therefore rakes down-and-right.
const LIGHT = (() => {
  const v = [-0.5, -0.866];
  return { x: v[0], y: v[1] };
})();

// --- render the icon at a given size -------------------------------------
function render(N) {
  const s = N / 1024; // scale factor from the 1024 reference design
  const rgba = Buffer.alloc(N * N * 4, 0);

  // palette — a muted slate surface, a near-black hole, one violet accent
  const surfaceHi = [96, 104, 136]; // up-left, facing the light
  const surfaceLo = [30, 34, 54]; // down-right, falling into shadow
  const holeCol = [13, 15, 25];
  const shadowCol = [14, 16, 28];
  const rimCol = [156, 140, 255]; // violet accent
  const specCol = [255, 255, 255];

  // geometry
  const bg = { cx: 512, cy: 512, hw: 460, hh: 460, r: 208 };
  const shadowShear = 0.72; // how far the cast shadow rakes per unit of y
  const shadowOriginY = 452;
  const shadowReach = 470;
  const rimWidth = 10;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = (x + 0.5) / s;
      const py = (y + 0.5) / s;
      const dst = [0, 0, 0, 0];

      // surface: a lit plane inside a rounded square
      const bgSd = sdRoundRect(px, py, bg.cx, bg.cy, bg.hw, bg.hh, bg.r);
      const bgCov = cov(bgSd);
      if (bgCov > 0) {
        const t = clamp(
          0.5 +
            0.5 * (((px - bg.cx) * -LIGHT.x + (py - bg.cy) * -LIGHT.y) / bg.hh),
          0,
          1,
        );
        over(
          dst,
          mix(surfaceHi[0], surfaceLo[0], t),
          mix(surfaceHi[1], surfaceLo[1], t),
          mix(surfaceHi[2], surfaceLo[2], t),
          bgCov,
        );

        // soft specular bloom in the upper-left, to sell the light source
        const d = Math.hypot(
          px - (bg.cx - bg.hw * 0.42),
          py - (bg.cy - bg.hh * 0.42),
        );
        const spec = Math.max(0, 1 - d / 430) ** 2.2 * 0.17;
        over(dst, specCol[0], specCol[1], specCol[2], spec * bgCov);

        // cast shadow: the keyhole sheared down-right, dissolving as it rakes
        const sx = px - shadowShear * (py - shadowOriginY);
        const fade = 1 - smoothstep(0, shadowReach, py - shadowOriginY);
        const shCov = cov(keyholeSd(sx, py)) * fade * 0.66;
        over(dst, shadowCol[0], shadowCol[1], shadowCol[2], shCov * bgCov);

        // violet rim-light, kept only on the edges that face the light
        const e = 1.5;
        const nx = keyholeSd(px + e, py) - keyholeSd(px - e, py);
        const ny = keyholeSd(px, py + e) - keyholeSd(px, py - e);
        const nl = Math.hypot(nx, ny) || 1;
        const facing = clamp((nx / nl) * LIGHT.x + (ny / nl) * LIGHT.y, 0, 1);
        over(
          dst,
          rimCol[0],
          rimCol[1],
          rimCol[2],
          cov(keyholeSd(px, py) - rimWidth) * facing ** 1.6 * 0.9 * bgCov,
        );

        // the hole itself
        const kCov = cov(keyholeSd(px, py));
        if (kCov > 0) {
          // bounce light lifting the far (lower-right) inner wall a touch
          const lift = 0.1 * smoothstep(0, 320, py - KEYHOLE_CENTER.y);
          over(
            dst,
            mix(holeCol[0], rimCol[0], lift),
            mix(holeCol[1], rimCol[1], lift),
            mix(holeCol[2], rimCol[2], lift),
            kCov,
          );
        }

        // hairline edge so the badge keeps its silhouette on light backgrounds
        over(dst, 190, 196, 220, cov(Math.abs(bgSd) - 5) * 0.4);
      }

      const i = (y * N + x) * 4;
      rgba[i] = Math.round(clamp(dst[0], 0, 255));
      rgba[i + 1] = Math.round(clamp(dst[1], 0, 255));
      rgba[i + 2] = Math.round(clamp(dst[2], 0, 255));
      rgba[i + 3] = Math.round(clamp(dst[3] * 255, 0, 255));
    }
  }
  return rgba;
}

// --- PNG encoder ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(N, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // raw scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- .ico wrapping multiple PNG sizes (Vista+ PNG-in-ICO) ------------------
function encodeICO(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4); // count
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width 256 -> 0
    entry[1] = size >= 256 ? 0 : size; // height 256 -> 0
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

// --- .icns wrapping PNG chunks (macOS 10.7+, no iconutil required) --------
function encodeICNS(entries) {
  const chunks = [];
  for (const { type, buf } of entries) {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(buf.length + 8, 4); // length incl. 8-byte header
    chunks.push(head, buf);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(body.length + 8, 4); // total length incl. header
  return Buffer.concat([header, body]);
}

// --- area-average downscale -------------------------------------------------
function downscale(src, srcN, dstN) {
  const dst = Buffer.alloc(dstN * dstN * 4);
  const ratio = srcN / dstN;
  for (let y = 0; y < dstN; y++) {
    const y0 = Math.floor(y * ratio);
    const y1 = Math.min(Math.ceil((y + 1) * ratio), srcN);
    for (let x = 0; x < dstN; x++) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.min(Math.ceil((x + 1) * ratio), srcN);
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcN + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n++;
        }
      }
      const i = (y * dstN + x) * 4;
      dst[i] = Math.round(r / n);
      dst[i + 1] = Math.round(g / n);
      dst[i + 2] = Math.round(b / n);
      dst[i + 3] = Math.round(a / n);
    }
  }
  return dst;
}

// --- main -----------------------------------------------------------------
const outDir = path.join(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });

// Render once at full resolution, then downscale so the small sizes get
// proper anti-aliasing instead of per-pixel SDF steps.
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ref = render(1024);
const pngs = Object.create(null);
for (const n of SIZES) {
  pngs[n] = encodePNG(n, n === 1024 ? ref : downscale(ref, 1024, n));
}

fs.writeFileSync(path.join(outDir, "icon.png"), pngs[1024]);
console.log("wrote build/icon.png (1024x1024)");

const icoPngs = [16, 24, 32, 48, 64, 128, 256].map((n) => ({
  size: n,
  buf: pngs[n],
}));
fs.writeFileSync(path.join(outDir, "icon.ico"), encodeICO(icoPngs));
console.log("wrote build/icon.ico (16..256, multi-size)");

const icnsEntries = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
].map(([type, n]) => ({ type, buf: pngs[n] }));
fs.writeFileSync(path.join(outDir, "icon.icns"), encodeICNS(icnsEntries));
console.log("wrote build/icon.icns (16..1024)");
