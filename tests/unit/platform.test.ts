// The one place the frontend names an operating system.
//
// These assertions exist to keep that promise honest: the predicates are pure functions of a user
// agent string, so they are testable without a device, and a future edit that widens them (or that
// starts matching desktop engines as mobile) fails here rather than on a phone.
import { describe, it, expect } from "vitest";
import { isMobile, hasNativeTitlebar } from "../../src/lib/platform";

// Real user agents, captured from the engines Sard actually runs on.
const UA = {
  androidWebView:
    "Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BP22.250325.006; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36",
  webView2:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  webKitGtk:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iPad:
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
} as const;

describe("isMobile", () => {
  it("recognises the Android system WebView", () => {
    expect(isMobile(UA.androidWebView)).toBe(true);
  });

  it("recognises iOS devices", () => {
    expect(isMobile(UA.iPhone)).toBe(true);
    expect(isMobile(UA.iPad)).toBe(true);
  });

  it("does not mistake a desktop engine for a phone", () => {
    // WebKitGTK matters specifically: it shares `AppleWebKit` with iOS, which is exactly the trap
    // `needsReaderHost` had to navigate. A naive test for that token would report Linux as mobile.
    expect(isMobile(UA.webView2)).toBe(false);
    expect(isMobile(UA.webKitGtk)).toBe(false);
  });
});

describe("hasNativeTitlebar", () => {
  it("is true on desktop, where a caption exists to theme", () => {
    expect(hasNativeTitlebar(UA.webView2)).toBe(true);
    expect(hasNativeTitlebar(UA.webKitGtk)).toBe(true);
  });

  it("is false on mobile, so the caption command is never called there", () => {
    // The Rust command already no-ops off Windows, so this is not a crash guard — it stops an IPC
    // round trip on every light/dark change that could not do anything.
    expect(hasNativeTitlebar(UA.androidWebView)).toBe(false);
    expect(hasNativeTitlebar(UA.iPhone)).toBe(false);
  });

  it("is the exact inverse of isMobile", () => {
    for (const ua of Object.values(UA)) expect(hasNativeTitlebar(ua)).toBe(!isMobile(ua));
  });
});
