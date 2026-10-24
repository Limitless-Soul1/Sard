// THE EDGE READ-ALOUD ENDPOINTS, PINNED.
//
// The synthesis WebSocket is built from a vendored copy of msedge-tts carrying exactly one change: the host
// it connects to (see src-tauri/vendor/msedge-tts/VENDOR.txt for why, and what was measured). These tests
// fail if that change is lost on a re-vendor, if it spreads to anything else the client sends, or if the
// copy drifts from the published crate in any other file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const VENDOR = resolve(__dirname, "../../src-tauri/vendor/msedge-tts");
const read = (rel: string) => readFileSync(resolve(VENDOR, rel), "utf8");
const constant = (name: string) => {
  const m = read("src/constants.rs").match(new RegExp(`pub const ${name}: &str = "([^"]*)";`));
  if (!m) throw new Error(`${name} not found in constants.rs`);
  return m[1];
};
const KEY = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

describe("the endpoints the Edge client uses", () => {
  it("synthesis connects to the host Edge itself uses, with the same client key", () => {
    expect(constant("WSS_URL")).toBe(
      `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=${KEY}&ConnectionId=`,
    );
  });

  it("the voice list stays on its original host — it was measured working and needs no change", () => {
    expect(constant("VOICE_LIST_URL")).toBe(
      `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${KEY}`,
    );
  });

  it("the identity the client presents is untouched", () => {
    expect(constant("ORIGIN")).toBe("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
    expect(constant("USER_AGENT")).toBe(
      "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.193 Mobile Safari/537.36 EdgA/143.0.3650.125",
    );
  });

  it("the build uses the vendored copy", () => {
    const manifest = readFileSync(resolve(__dirname, "../../src-tauri/Cargo.toml"), "utf8");
    expect(manifest).toMatch(/\[patch\.crates-io\]\r?\nmsedge-tts = \{ path = "vendor\/msedge-tts" \}/);
  });
});

describe("the handshake carries the browser headers the synthesis host requires", () => {
  // Without Accept-Encoding the host answers a plain 200 with no upgrade (measured 2026-10-24).
  it("sends Accept-Encoding and Accept-Language", () => {
    const src = read("src/tts/mod.rs");
    expect(src).toMatch(/headers\.insert\(header::ACCEPT_ENCODING, "gzip, deflate, br, zstd"\.parse\(\)\.unwrap\(\)\);/);
    expect(src).toMatch(/headers\.insert\(header::ACCEPT_LANGUAGE, "en-US,en;q=0\.9"\.parse\(\)\.unwrap\(\)\);/);
  });
});

describe("keep-alive frames are not synthesis failures", () => {
  it("a Ping or Pong arriving during a synthesis yields no payload instead of an error", () => {
    expect(read("src/tts/mod.rs")).toMatch(/tungstenite::Message::Ping\(_\) \| tungstenite::Message::Pong\(_\) => Ok\(None\),/);
  });
});

const sha = (text: string) => createHash("sha256").update(text.replace(/\r/g, "")).digest("hex");

describe("the vendored copy is the published crate apart from the recorded changes", () => {
  // Each modified file, with exactly the change VENDOR.txt records taken back out, must be the published
  // file byte for byte — so nothing else can have changed in it.
  it("constants.rs differs only by the synthesis host", () => {
    const original = read("src/constants.rs").replace(/\r/g, "").replace(
      /\/\/ SARD LOCAL MODIFICATION[^\n]*\n(?:\/\/[^\n]*\n){3}pub const WSS_URL: &str = "[^"]*";/,
      'pub const WSS_URL: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=";',
    );
    expect(sha(original)).toBe("4d02b93495aa9108f8f060a6bb336cd72e004683a8fe0c3c177c32f08de5fe99");
  });

  it("tts/mod.rs differs only by the keep-alive arm and the handshake headers", () => {
    const original = read("src/tts/mod.rs").replace(/\r/g, "").replace(
      /\n {12}\/\/ SARD LOCAL MODIFICATION[^\n]*\n(?: {12}\/\/[^\n]*\n){2} {12}tungstenite::Message::Ping\(_\) \| tungstenite::Message::Pong\(_\) => Ok\(None\),/,
      "",
    ).replace(
      /\n {4}\/\/ SARD LOCAL MODIFICATION[^\n]*\n(?: {4}\/\/[^\n]*\n){2} {4}headers\.insert\(header::ACCEPT_ENCODING[^\n]*\n {4}headers\.insert\(header::ACCEPT_LANGUAGE[^\n]*/,
      "",
    );
    expect(sha(original)).toBe("e34b87af3bde94bfa598ca3a2a1403ea7c945d1fb82383cb11820e38fff25360");
  });

  // Every other file: sha256 of crates.io msedge-tts 0.4.0, line endings normalised (a Windows checkout may
  // hold CRLF).
  const PUBLISHED: Record<string, string> = {
    "Cargo.toml": "e314bd2b778e790c6a5e9233d21234ff1b73e7aff1a9f46a68904f2fbfa2eaa6",
    "LICENSE": "1ab49fbef60eb74f02a280f5bcefb187dd040a5ca1ff5dc6e2630bf7fb54fc16",
    "README.md": "76a28c6ca1aedacff818aecbfd100c213f023c382bfb1daa9ecf26cc0ebc7d0e",
    "src/error.rs": "91d06032d778b094ace144760c4bb2985903edc41d49ef3c51e144bc83338cd7",
    "src/lib.rs": "ad283233032fb468096a05bd4d07b97e6a504a70926ba895d917a358fc29f903",
    "src/tts/client/blocking.rs": "4aa5fab43ca50d358640be6017695c5ca3007786b1185d394292a185b738fb25",
    "src/tts/client/mod.rs": "d4591da4b02432f6f1ed9c8a52450a7845464ec86eccbbd9bca9994032fecb80",
    "src/tts/client/smol_runtime.rs": "a53a98739167872f35688529747a6a4c9b37fa17e40985f10098895db83c3429",
    "src/tts/client/tokio_runtime.rs": "6600e0fa089794f3995ef9272f18772b2f5666abc9e9e271d994e84b75cf1043",
    "src/tts/proxy/blocking.rs": "7bbb83976eea8955c37218a141c9075eccdc00450b785e67122962448b6c2da4",
    "src/tts/proxy/mod.rs": "d312189bdd31f6be9e8eb19831b17d850ae1a01e462fed6fd9a2c426ee1e398c",
    "src/tts/proxy/smol_runtime.rs": "d8e6d263cc7bdb405c7bac9cd5518a1226656c0253a494b8434d0f460783e247",
    "src/tts/proxy/tokio_runtime.rs": "03f0671a732b35282646ce2722f964ea2463b0d3b5c42517309a5b2f7272880b",
    "src/tts/stream/blocking.rs": "cdae2126ed2588079660be87f34bf9f8a0d0bc128c712c86daaa6f1f59110f07",
    "src/tts/stream/mod.rs": "486501d3ea21842c9e8602531351a3b695819a733def292ba1b177cd43ef9eb0",
    "src/tts/stream/smol_runtime.rs": "331ff94fd3296ca03e64b9a9fe0c89438b57f723852959fb120f8cabb88d13b8",
    "src/tts/stream/tokio_runtime.rs": "643c76047d145b1bee9b9891fea0119ff05e88f8acaa633c5d7b86b72d6ad7a0",
    "src/voice/blocking.rs": "89ff1d2114a5e8a6eb356b4003d3b50b1be20270723aebe5db4377598cdbb46e",
    "src/voice/mod.rs": "b29d76e16be71a8dc36cf4b6ee2bdd75cd2f4dff9107235c3bd0a1b98d2c2307",
    "src/voice/smol_runtime.rs": "36871d4a9b9e8871468d41baf7bae1ff7486de6c0b4d51714673efae968867ba",
    "src/voice/tokio_runtime.rs": "98fcbd374764aad4136eb8419265f0b3143d15218dcd8e2a957764b5fcd56663",
  };

  for (const [file, hash] of Object.entries(PUBLISHED)) {
    it(`${file} is unchanged`, () => {
      expect(sha(read(file))).toBe(hash);
    });
  }
});
