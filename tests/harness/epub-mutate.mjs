// Build a MUTATED copy of an EPUB, to turn an observational claim into a controlled experiment.
//
// Reading source code tells you what a program should do. Changing one input and watching the output
// change tells you what it DOES. This writes a modified copy (never touching the original) so a
// single variable — the navigation document — can be altered while everything else is held constant.
//
// Entries are written STORED (uncompressed). That is valid zip and valid EPUB, and it keeps this
// writer small enough to be obviously correct, which matters more here than file size.
import { crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import { readZip } from "./epub-nav.mjs";

/**
 * @param src        path to the original EPUB (read only)
 * @param dst        path to write the mutant
 * @param transform  (name, buffer) => Buffer | null   — return null to DROP the entry
 */
export function mutateEpub(src, dst, transform) {
  const zip = readZip(src);
  const locals = [];
  const central = [];
  let offset = 0;
  const changed = [];

  for (const [name] of zip.entries) {
    const original = zip.read(name);
    if (original == null) continue;
    const out = transform(name, original);
    if (out === null) { changed.push(`DROPPED ${name}`); continue; }
    if (out !== original && !out.equals(original)) changed.push(`REWROTE ${name} (${original.length} -> ${out.length} bytes)`);

    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(out);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags — no UTF-8 bit needed for ASCII names; set below if required
    local.writeUInt16LE(0, 8);         // method: STORED
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(out.length, 18);
    local.writeUInt32LE(out.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    if (/[^\x20-\x7e]/.test(name)) local.writeUInt16LE(0x800, 6); // UTF-8 name flag
    locals.push(local, nameBuf, out);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(local.readUInt16LE(6), 8);
    cen.writeUInt16LE(0, 10);          // method: STORED
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(out.length, 20);
    cen.writeUInt32LE(out.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + out.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  writeFileSync(dst, Buffer.concat([localBuf, centralBuf, eocd]));
  return changed;
}
