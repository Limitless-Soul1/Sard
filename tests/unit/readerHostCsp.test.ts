// The application must be allowed to embed the reader host.
//
// WHY THIS EXISTS. On a real Linux machine the reader was blank, and the diagnostic build named the
// reason in one line:
//
//     APP csp "frame-src blocked sardhost://localhost"
//
// The host iframe was refused by the application's own Content-Security-Policy before it could load,
// so the handshake never happened, `open()` timed out after 20 s, and every later call failed with
// "the reader host is not mounted yet" — including the TTS calls behind the spinner.
//
// WHY NO GATE CAUGHT IT. The throwaway probe branch carried `sardhost:` in its own `frame-src` so
// its harness could embed the host. That exemption was correctly kept out of production — and then
// production was never given the permission it actually needed. Every WebKitGTK run passed against a
// policy no user would ever have.
//
// So this asserts the permission in the SHIPPED config, on every platform, in the ordinary unit
// suite. It is the check whose absence let a one-token omission reach a real machine.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const csp = (JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app?.security?.csp ?? "") as string;
const directive = (name: string) =>
  csp.split(";").find((d) => d.trim().startsWith(name))?.trim() ?? "";

describe("the application can embed the reader host", () => {
  it("frame-src admits the host origin", () => {
    // The reader host is served from `sardhost://localhost` (see src-tauri/src/bookhost.rs). Without
    // this token the iframe is refused and the reader cannot start on WebKit.
    expect(directive("frame-src")).toContain("sardhost://localhost");
  });

  it("admits the ORIGIN, not the whole scheme", () => {
    // `sardhost:` as a bare scheme-source would admit every host under that scheme. There is exactly
    // one, and naming it keeps the grant as small as the need.
    const frame = directive("frame-src");
    expect(frame).not.toMatch(/(^|\s)sardhost:(\s|$)/);
  });

  it("grants nothing else while doing it", () => {
    // The one-token discipline. A permission added to fix a blank screen is exactly the moment
    // something unrelated gets waved through alongside it.
    expect(directive("frame-src")).toBe("frame-src 'self' blob: sardhost://localhost");
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(directive("default-src")).toBe("default-src 'self'");
    // The host origin must not become reachable as a fetch target, a script source or a style source
    // just because a frame may load it.
    for (const name of ["script-src", "connect-src", "style-src", "img-src", "font-src", "media-src"]) {
      expect(directive(name)).not.toContain("sardhost");
    }
  });
});
