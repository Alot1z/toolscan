#!/usr/bin/env node
/**
 * toolscan brand renderer — the single source of the logo.
 *
 * Original radar-sweep mark: a scope ring (the PATH horizon) with a swept
 * wedge of discovered tools inside; a bright leading ray escapes the ring to
 * lock the amber tool found beyond the horizon. Geometry is defined once here
 * and emitted as both vector (SVG) and raster (PNG, supersampled, encoded
 * with node:zlib — zero dependencies), so committed assets are reproducible:
 *
 *   node scripts/render-logo.mjs [--out assets] [--sizes 1024,512,256]
 *
 * Emits logo.svg, logo-banner.svg and logo-<size>.png. Palette is original
 * to toolscan: near-black navy ink, signal cyan scan, amber find.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- palette ---------------------------------------------------------------
export const PALETTE = {
  ink: "#0F172A", // deep navy — ring, structure
  inkSoft: "rgba(15,23,42,0.30)",
  beam: "#06B6D4", // signal cyan — the scan sweep
  beamBright: "#22D3EE",
  found: "#0891B2", // tools already inside PATH
  lock: "#F59E0B", // amber — the tool found beyond the PATH horizon
  chip: "#0B1220", // banner backdrop
};

// ---- geometry --------------------------------------------------------------
// All angles are IMAGE degrees: 0 = +x (right), +90 = +y (DOWN on screen),
// -90 = up. Y-down convention so polar() and atan2() agree visually.
const CX = 512;
const CY = 512;
const RING_R = 330; // the PATH horizon
const RING_W = 30;
const TRAIL_R = 348; // swept wedge reaches just past the ring's outer edge
const RAY_END = 400; // bright leading ray runs to the amber find
const FIND_R = 402; // amber dot centre — just past the ring, ON the ray
const FIND_ANGLE = -24; // upper right
const LEAD_ANGLE = FIND_ANGLE; // leading edge of the sweep == ray angle
const TAIL_ANGLE = -116; // trailing edge (upper left); wedge spans [TAIL..LEAD]
const TRAIL_STEPS = 14;

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function degAt(cx, cy, x, y) {
  return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
}

/** In the swept wedge? Angles span [TAIL_ANGLE .. LEAD_ANGLE] (TAIL < LEAD). */
function inSweep(deg) {
  return deg <= LEAD_ANGLE && deg >= TAIL_ANGLE;
}

// ---- PNG encoder (zero-dep) -------------------------------------------------
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- rasterizer -------------------------------------------------------------
function raster(size, ss = 3) {
  const rgba = Buffer.alloc(size * size * 4);
  const unit = size / 1024;
  const mapX = (fx) => (fx - CX) * unit + size / 2;
  const mapY = (fy) => (fy - CY) * unit + size / 2;

  const cover = (d, aa = 1) => Math.max(0, Math.min(1, 0.5 - d / aa));
  const rgbaColor = (hex, alpha = 1) => {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255, alpha];
  };

  // Per-pixel straight-alpha compositor over the feature stack.
  function features(fx, fy) {
    let col = [0, 0, 0, 0];
    const put = (rgb, cov) => {
      if (cov <= 0) return;
      const a = col[3] + rgb[3] * cov * (1 - col[3]);
      if (a <= 0) return;
      col = [
        (rgb[0] * rgb[3] * cov + col[0] * col[3] * (1 - rgb[3] * cov)) / a,
        (rgb[1] * rgb[3] * cov + col[1] * col[3] * (1 - rgb[3] * cov)) / a,
        (rgb[2] * rgb[3] * cov + col[2] * col[3] * (1 - rgb[3] * cov)) / a,
        a,
      ];
    };

    const r0 = Math.hypot(fx - CX, fy - CY);
    const ringDist = Math.abs(r0 - RING_R) - RING_W / 2;

    // graticule rings (faint depth inside the scope)
    put(rgbaColor(PALETTE.inkSoft), cover(Math.abs(r0 - 210) - 2) * 0.9);
    put(rgbaColor(PALETTE.inkSoft), cover(Math.abs(r0 - 100) - 1.5) * 0.7);

    // swept wedge trail: translucent, brightest just behind the leading ray
    if (r0 < TRAIL_R) {
      const deg = degAt(CX, CY, fx, fy);
      if (inSweep(deg)) {
        const span = LEAD_ANGLE - TAIL_ANGLE;
        const t = (LEAD_ANGLE - deg) / span; // 0 at tail .. 1 at leading ray
        const fade = 0.07 + 0.34 * t * t;
        put(rgbaColor(PALETTE.beam, fade), 1);
      }
    }

    // main ring (PATH horizon) drawn OVER the trail
    put(rgbaColor(PALETTE.ink), cover(ringDist));

    // found blips inside the swept area (tools already on PATH)
    const foundBlips = [
      [120, -100],
      [160, -80],
      [205, -62],
      [258, -45],
      [150, -110],
      [300, -70],
    ];
    for (const [br, bdeg] of foundBlips) {
      const [px, py] = polar(CX, CY, br, bdeg);
      const d = Math.hypot(fx - px, fy - py);
      put(rgbaColor(PALETTE.found), cover(d - 9, 1.6));
      put(rgbaColor(PALETTE.found, 0.9), cover(d - 2.5, 1.2));
    }

    // leading bright ray: runs from centre to the amber find (escapes the ring)
    {
      const aa = (LEAD_ANGLE * Math.PI) / 180;
      const t = (fx - CX) * Math.cos(aa) + (fy - CY) * Math.sin(aa);
      if (t > 0 && t < RAY_END) {
        const px = CX + t * Math.cos(aa);
        const py = CY + t * Math.sin(aa);
        const d = Math.hypot(fx - px, fy - py);
        put(rgbaColor(PALETTE.beamBright, 0.95), cover(d - 4.5, 2));
      }
    }

    // the amber find: ON the ray past the ring, locked by a thin ring + ticks
    const [bx, by] = polar(CX, CY, FIND_R, FIND_ANGLE);
    const lockRingD = Math.abs(Math.hypot(fx - bx, fy - by) - 31) - 3;
    put(rgbaColor(PALETTE.lock), cover(Math.hypot(fx - bx, fy - by) - 21, 2));
    put(rgbaColor(PALETTE.lock, 0.9), cover(lockRingD) * 0.9);
    // horizontal lock ticks
    const [lx1, ly1] = polar(bx, by, 44, 0);
    const [lx2, ly2] = polar(bx, by, 44, 180);
    const seg = (x1, y1, x2, y2, w) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      const t = ((fx - x1) * dx + (fy - y1) * dy) / (len * len);
      if (t < 0 || t > 1) return;
      const d = Math.abs((-dy) * (fx - x1) + dx * (fy - y1)) / len;
      put(rgbaColor(PALETTE.lock, 0.9), cover(d - w / 2, 1.2));
    };
    seg(lx1, ly1, lx2, ly2, 6);

    return col;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = (x + (sx + 0.5) / ss - size / 2) / unit + CX;
          const fy = (y + (sy + 0.5) / ss - size / 2) / unit + CY;
          const c = features(fx, fy);
          if (c[3] > 0) {
            r += c[0] * c[3];
            g += c[1] * c[3];
            b += c[2] * c[3];
            a += c[3];
          }
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(a > 0 ? r / a : 0);
      rgba[o + 1] = Math.round(a > 0 ? g / a : 0);
      rgba[o + 2] = Math.round(a > 0 ? b / a : 0);
      rgba[o + 3] = Math.round((a / n) * 255);
    }
  }
  return rgba;
}

// ---- SVG emission (same geometry, vector) ------------------------------------
function svgMark() {
  const ring = `<circle cx="${CX}" cy="${CY}" r="${RING_R}" fill="none" stroke="${PALETTE.ink}" stroke-width="${RING_W}"/>`;
  const g1 = `<circle cx="${CX}" cy="${CY}" r="210" fill="none" stroke="${PALETTE.ink}" stroke-opacity="0.3" stroke-width="4"/>`;
  const g2 = `<circle cx="${CX}" cy="${CY}" r="100" fill="none" stroke="${PALETTE.ink}" stroke-opacity="0.22" stroke-width="3"/>`;

  // swept wedge trail — stepped slices, brightest near the leading ray
  let trail = "";
  for (let i = 0; i < TRAIL_STEPS; i++) {
    const from = TAIL_ANGLE + ((LEAD_ANGLE - TAIL_ANGLE) * i) / TRAIL_STEPS;
    const to = TAIL_ANGLE + ((LEAD_ANGLE - TAIL_ANGLE) * (i + 1)) / TRAIL_STEPS;
    const [x1, y1] = polar(CX, CY, TRAIL_R, from);
    const [x2, y2] = polar(CX, CY, TRAIL_R, to);
    const t = (i + 1) / TRAIL_STEPS;
    const fade = (0.07 + 0.34 * t * t).toFixed(3);
    trail += `<path d="M${CX} ${CY} L${x1.toFixed(1)} ${y1.toFixed(1)} A${TRAIL_R} ${TRAIL_R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${PALETTE.beam}" fill-opacity="${fade}"/>`;
  }

  const [rx, ry] = polar(CX, CY, RAY_END, LEAD_ANGLE);
  const ray = `<line x1="${CX}" y1="${CY}" x2="${rx.toFixed(1)}" y2="${ry.toFixed(1)}" stroke="${PALETTE.beamBright}" stroke-width="9" stroke-linecap="round"/>`;

  const foundBlips = [
    [120, -100],
    [160, -80],
    [205, -62],
    [258, -45],
    [150, -110],
    [300, -70],
  ];
  const found = foundBlips
    .map(([br, bdeg]) => {
      const [px, py] = polar(CX, CY, br, bdeg);
      return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" fill="${PALETTE.found}"/><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="#FFFFFF" fill-opacity="0.55"/>`;
    })
    .join("");

  const [bx, by] = polar(CX, CY, FIND_R, FIND_ANGLE);
  const [tx1, ty1] = polar(bx, by, 44, 0);
  const [tx2, ty2] = polar(bx, by, 44, 180);
  const beyond =
    `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="21" fill="${PALETTE.lock}"/>` +
    `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="31" fill="none" stroke="${PALETTE.lock}" stroke-opacity="0.9" stroke-width="4"/>` +
    `<line x1="${tx1.toFixed(1)}" y1="${ty1.toFixed(1)}" x2="${tx2.toFixed(1)}" y2="${ty2.toFixed(1)}" stroke="${PALETTE.lock}" stroke-opacity="0.9" stroke-width="6" stroke-linecap="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="toolscan — radar-sweep mark">
${g1}
${g2}
${trail}
${ring}
${ray}
${found}
${beyond}
</svg>`;
}

function svgBanner() {
  const mark = svgMark().replace(/\n/g, "\n");
  const inner = mark.replace(/<svg[^>]*>|<\/svg>/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 420" width="1600" height="420" role="img" aria-label="toolscan">
<rect width="1600" height="420" rx="36" fill="${PALETTE.chip}"/>
<g transform="translate(40 45) scale(0.322)">${inner}</g>
<text x="392" y="228" font-family="Inter, ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif" font-size="120" font-weight="800" letter-spacing="2" fill="#FFFFFF">toolscan</text>
<text x="396" y="300" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="38" letter-spacing="5" fill="${PALETTE.beamBright}">DISCOVERY BEYOND PATH</text>
</svg>`;
}

// ---- main --------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const outDir = args[args.indexOf("--out") + 1] || join(ROOT, "assets");
  const sizes = (args[args.indexOf("--sizes") + 1] || "1024,512,256")
    .split(",")
    .map(Number)
    .filter(Boolean);
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, "logo.svg"), svgMark(), "utf8");
  writeFileSync(join(outDir, "logo-banner.svg"), svgBanner(), "utf8");
  console.log(`wrote ${join(outDir, "logo.svg")} and logo-banner.svg`);

  for (const size of sizes) {
    const rgba = raster(size, size >= 512 ? 3 : 4);
    writeFileSync(join(outDir, `logo-${size}.png`), encodePng(size, rgba));
    console.log(`wrote logo-${size}.png (${size}x${size}, supersampled)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
export { svgMark, svgBanner, raster, encodePng };