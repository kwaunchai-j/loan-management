// Writes PLACEHOLDER app icons (a white coin on teal) into public/. Replace them with the lender's real
// artwork before launch; the file names and sizes below are what manifest.webmanifest points at.
// Usage: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const TEAL = [15, 118, 110];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** coinRadius is a fraction of the icon width; a maskable icon keeps it inside the 80% safe zone. */
function png(size, coinRadius) {
  const rows = [];
  const cx = size / 2;
  const outer = size * coinRadius;
  const inner = outer * 0.72;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cx);
      // white ring with a teal centre = a simple coin
      const color = d <= outer && d >= inner ? WHITE : d < inner * 0.45 ? WHITE : TEAL;
      row.set(color, 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = fileURLToPath(new URL("../public/", import.meta.url));
mkdirSync(out, { recursive: true });
const files = [
  ["icon-192.png", 192, 0.36],
  ["icon-512.png", 512, 0.36],
  ["icon-maskable-512.png", 512, 0.28],
  ["apple-touch-icon.png", 180, 0.3],
];
for (const [name, size, radius] of files) writeFileSync(out + name, png(size, radius));
console.log(`wrote ${files.length} placeholder icons to public/`);
