// Builds the Chrome Web Store upload: dist/ration/ and dist/ration-<version>.zip.
// Only manifest.json, src/, and icons/ ship. Run: npm run package
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'ration');
const SHIP = ['manifest.json', 'src', 'icons'];

function fail(msg) {
  console.error(`package: ${msg}`);
  process.exit(1);
}

function walk(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((n) => (n.startsWith('.') ? [] : walk(join(path, n))));
}

// ---------- checks ----------

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`bad version "${manifest.version}"`);
if (manifest.description.length > 132) fail(`description is ${manifest.description.length} characters; the store allows 132`);
if (manifest.name.length > 75) fail('name is longer than 75 characters');

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.web_accessible_resources.flatMap((w) => w.resources),
];
for (const f of referenced) if (!existsSync(join(ROOT, f))) fail(`manifest names a missing file: ${f}`);

const files = SHIP.flatMap((p) => walk(join(ROOT, p)));
for (const f of files) {
  const text = /\.(js|html|css|json)$/.test(f) ? readFileSync(f, 'utf8') : '';
  // The store rejects remote code. Pages may load only local files.
  if (/<script[^>]+src=["']https?:/i.test(text) || /import\s.*from\s+["']https?:/.test(text)) fail(`remote code in ${relative(ROOT, f)}`);
  if (/\beval\(|new Function\(/.test(text)) fail(`eval in ${relative(ROOT, f)}`);
}

// Every relative import in shipped JS must resolve to a shipped file.
for (const f of files.filter((x) => x.endsWith('.js'))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    if (!existsSync(join(dirname(f), m[1]))) fail(`${relative(ROOT, f)} imports missing ${m[1]}`);
  }
}

// ---------- copy ----------

rmSync(OUT, { recursive: true, force: true });
for (const f of files) {
  const to = join(OUT, relative(ROOT, f));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(f, to);
}

// ---------- zip ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    // A fixed time and date (1980-01-01), so builds repeat byte for byte.
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const entries = files
  .map((f) => ({ name: relative(ROOT, f).split(sep).join('/'), data: readFileSync(f) }))
  .sort((a, b) => a.name.localeCompare(b.name));
const zipPath = join(DIST, `ration-${manifest.version}.zip`);
writeFileSync(zipPath, zip(entries));

const kb = (statSync(zipPath).size / 1024).toFixed(1);
console.log(`${entries.length} files -> ${relative(ROOT, zipPath)} (${kb} KB)`);
console.log(`unpacked copy -> ${relative(ROOT, OUT)}`);
