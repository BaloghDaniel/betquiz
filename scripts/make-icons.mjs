// Regenerates the PWA icons from the palette in src/index.css.
//
//   node scripts/make-icons.mjs
//
// Writes public/icon-192.png, public/icon-512.png and public/apple-touch-icon.png.
//
// This exists because there is no ImageMagick, rsvg, Pillow or canvas library in
// this environment, and the icons must not drift away from the app's colours the
// way they did when the palette went from dark-plum-and-yellow to light. Node's
// zlib is enough to write a PNG by hand, so the mark is drawn analytically and
// encoded here rather than depending on a toolchain that may not be installed.
//
// The mark: two overlapping discs -- the two duellists -- on the palette's navy.
// Where they overlap the colour brightens (a per-channel max, i.e. a screen
// blend), and a hole is punched through the middle of the intersection.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

// Straight from the @theme block in src/index.css.
const GROUND = rgb('#1b3f8b') // blue  -- the palette's filled-surface anchor
const LEFT = rgb('#00a6d6') // accent
const RIGHT = rgb('#12b981') // mint
const OVERLAP = LEFT.map((v, i) => Math.max(v, RIGHT[i])) // screen blend

// Geometry as fractions of the canvas, so every size is identical.
const R = 0.25 // disc radius
const CX_L = 0.4 // left disc centre x
const CX_R = 0.6 // right disc centre x
const CY = 0.5
const HOLE = 0.0625 // punched through the intersection
const CORNER = 0.125 // rounded-square corner radius

const SS = 4 // supersampling factor per axis -> 16 samples/pixel

/** Colour at a point in unit space, or null for "outside the rounded square". */
function sample(x, y) {
  // Rounded-square mask. Only the corner quadrants need the distance test.
  const dx = Math.max(CORNER - x, x - (1 - CORNER), 0)
  const dy = Math.max(CORNER - y, y - (1 - CORNER), 0)
  if (dx * dx + dy * dy > CORNER * CORNER) return null

  const inL = (x - CX_L) ** 2 + (y - CY) ** 2 <= R * R
  const inR = (x - CX_R) ** 2 + (y - CY) ** 2 <= R * R
  const inHole = (x - 0.5) ** 2 + (y - CY) ** 2 <= HOLE * HOLE

  if (inL && inR) return inHole ? GROUND : OVERLAP
  if (inL) return LEFT
  if (inR) return RIGHT
  return GROUND
}

function render(size) {
  // RGBA, one filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let p = 0
  for (let py = 0; py < size; py++) {
    raw[p++] = 0
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255 }
        }
      }
      const n = SS * SS
      // Premultiplied average, then un-premultiply, so edge pixels blend
      // toward transparency instead of toward black.
      const cov = a / (255 * n)
      raw[p++] = cov ? Math.round(r / (n * cov)) : 0
      raw[p++] = cov ? Math.round(g / (n * cov)) : 0
      raw[p++] = cov ? Math.round(b / (n * cov)) : 0
      raw[p++] = Math.round(a / n)
    }
  }
  return raw
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [file, size] of [
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['public/apple-touch-icon.png', 180],
]) {
  const buf = png(size)
  writeFileSync(file, buf)
  console.log(`  ${file}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} kB`)
}
