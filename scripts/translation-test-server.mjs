#!/usr/bin/env node
// A LOCAL TEST SERVER FOR THE TRANSLATION MODELS SECTION — development builds only.
//
// It writes small fake model files and a fake translation-engine archive into a folder, writes the matching test
// catalog (src-tauri/src/translation/active.rs), and serves them on 127.0.0.1 ONLY, with byte ranges so that Resume
// works. A development build pointed at that catalog downloads from here and from nowhere else: the catalog names only
// 127.0.0.1, and the download policy that comes with it refuses every other host. A release build never reads the
// variable at all.
//
// The fake engine is never run — nothing in Sard can start the engine from the interface — and the fake models are
// random bytes. Nothing here is a real model.
//
//   node scripts/translation-test-server.mjs [--dir <folder>] [--port <n>] [--rate <KiB per second>] [--drop-at <byte>]
//                                            [--model-mib <n>]
//
// Then start a development build with BOTH:
//   SARD_DATA_DIR=<an empty scratch folder>                 (a test catalog is used only beside moved data)
//   SARD_TRANSLATION_TEST_CATALOG=<folder>/catalog.json
//
// --rate slows the transfer so that progress, Cancel and Resume can be watched (default 2048 KiB/s).
// --drop-at closes each file's first connection once it passes that byte: an interruption, then Resume.
// --model-mib sets the fake models' size (default 64). Progress is reported once per 16 MiB block, so a model of
//   several blocks shows a moving bar.
// The files are kept in --dir: a server started again on the same folder serves the same bytes, so the catalog stays
// right and an interrupted download can be resumed. Every request is logged, with where it came from.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dir = resolve(arg("dir", join(tmpdir(), `sard-translation-test-${Date.now()}`)));
const port = Number(arg("port", "0"));
const rate = Number(arg("rate", "2048")) * 1024;
const dropAt = arg("drop-at", null) == null ? null : Number(arg("drop-at"));
const modelBytes = Number(arg("model-mib", "64")) * 1024 * 1024;

// ---- A stored (uncompressed) ZIP, as the installer reads one ----
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0x20, 38); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---- The files: made once per folder, then served as they are ----
mkdirSync(dir, { recursive: true });
const kept = (name, make) => {
  const path = join(dir, name);
  if (existsSync(path)) return readFileSync(path);
  const data = make();
  writeFileSync(path, data);
  return data;
};
const engineFiles = [
  { name: "llama-server.exe", data: kept("engine-llama-server.exe", () => Buffer.from("MZ fake translation engine - never run")) },
  { name: "ggml-base.dll", data: kept("engine-ggml-base.dll", () => randomBytes(4096)) },
  { name: "ggml-cpu-x64.dll", data: kept("engine-ggml-cpu-x64.dll", () => randomBytes(8192)) },
];
const notices = "Test notices: a fake translation engine for the local test server.\n";
const archive = kept("runtime.zip", () => zip(engineFiles));
const files = {
  "runtime.zip": archive,
  // The catalog ids of the two models, so that their licences and requirements are the built-in ones.
  "milmmt-46-4b-q6k.gguf": kept("milmmt-46-4b-q6k.gguf", () => randomBytes(modelBytes)),
  "gemma-4-e2b-it-q4-0.gguf": kept("gemma-4-e2b-it-q4-0.gguf", () => randomBytes(modelBytes)),
};

const server = createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} ${req.headers.range ?? "(whole file)"}`);
  const name = decodeURIComponent((req.url ?? "/").slice(1));
  if (!(name in files) || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404).end();
    return;
  }
  const data = readFileSync(join(dir, name));
  const total = statSync(join(dir, name)).size;
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const from = m ? Number(m[1]) : 0;
  const to = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (from > to) {
    res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
    return;
  }
  res.writeHead(m ? 206 : 200, {
    "Content-Length": to - from + 1,
    "Accept-Ranges": "bytes",
    ...(m ? { "Content-Range": `bytes ${from}-${to}/${total}` } : {}),
  });
  if (req.method === "HEAD") return res.end();
  let at = from;
  const step = Math.max(16 * 1024, Math.floor(rate / 10));
  const timer = setInterval(() => {
    if (dropAt != null && !dropped.has(name) && at >= dropAt) {
      dropped.add(name);
      clearInterval(timer);
      req.socket.destroy();
      return;
    }
    const end = Math.min(at + step, to + 1);
    res.write(data.subarray(at, end));
    at = end;
    if (at > to) {
      clearInterval(timer);
      res.end();
    }
  }, 100);
  req.on("close", () => clearInterval(timer));
});
const dropped = new Set();

server.listen(port, "127.0.0.1", () => {
  const { port: p } = server.address();
  const url = (name) => `http://127.0.0.1:${p}/${encodeURIComponent(name)}`;
  const catalog = {
    runtime: { url: url("runtime.zip"), file_name: "runtime.zip", size: archive.length, sha256: sha256(archive) },
    engine: {
      executable: "llama-server.exe",
      files: engineFiles.map((f) => ({ name: f.name, size: f.data.length, sha256: sha256(f.data) })),
      notices_name: "THIRD-PARTY-NOTICES.txt",
      notices,
    },
    models: ["milmmt-46-4b-q6k", "gemma-4-e2b-it-q4-0"].map((id) => {
      const data = files[`${id}.gguf`];
      return { id, url: url(`${id}.gguf`), file_name: "model.gguf", size: data.length, sha256: sha256(data) };
    }),
  };
  const catalogPath = join(dir, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log(`Serving fake translation files on 127.0.0.1:${p} from ${dir}`);
  console.log(`  SARD_TRANSLATION_TEST_CATALOG=${catalogPath}`);
  console.log(`  SARD_DATA_DIR=<an empty scratch folder>   (required: a test catalog is used only beside moved data)`);
});
