// RESILIENCE-1 / WP-1 — the generic error core.
//
// This is the layer WP-5's TTS classification will reuse, so its contract is tested here rather
// than only through the book classifier that happens to be its first consumer.

import { describe, it, expect, vi, beforeEach } from "vitest";

// `errors.ts` imports the Tauri IPC for its diagnostics ring. Under Node there is no Tauri, so the
// module is stubbed — this keeps the tests honest about what they cover (the ring's LOGIC) without
// pretending to test the IPC itself.
const store = new Map<string, string>();
vi.mock("../../src/lib/ipc", () => ({
  settingsGet: async (k: string) => store.get(k) ?? null,
  settingsSet: async (k: string, v: string) => void store.set(k, v),
}));

const {
  describeError,
  matchRule,
  formatDiagnostics,
  readDiagnostics,
  recordDiagnostic,
  resetDiagnosticsCache,
  toDiagnostic,
} = await import("../../src/lib/errors");

beforeEach(() => {
  store.clear();
  resetDiagnosticsCache();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("what a path-bearing failure hands over", () => {
  // MEASURED BEFORE THIS EXISTED: five of six realistic failures put an absolute path on screen
  // behind Details and onto the clipboard with it — the OS naming the file it could not find,
  // SQLite naming its database, and a failed asset fetch carrying the book's own percent-encoded
  // path inside the URL it reported. That is where the reader keeps their library and what they
  // were reading, in a block whose whole purpose is to be pasted somewhere else.
  const PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\|\/(?:home|Users|mnt)\/)/;

  const CASES: [string, unknown, string][] = [
    ["the OS naming the file it could not find",
     new Error("The system cannot find the file specified. (os error 2): D:\\كتب\\book.epub"), ".epub"],
    ["SQLite naming its own database file",
     new Error("unable to open database file: C:\\Users\\someone\\AppData\\Roaming\\Sard\\sard.db"), ".db"],
    ["a POSIX path, for the platforms that are not Windows",
     new Error("ENOENT: /home/reader/Books/private.epub"), ".epub"],
    ["a UNC share",
     new Error("EPERM: operation not permitted, open \\\\NAS\\share\\library\\book.epub"), ".epub"],
  ];

  for (const [label, thrown, ext] of CASES) {
    it(`redacts ${label}, keeping only that it was a ${ext}`, () => {
      const out = describeError(thrown);
      expect(out, "no path may survive").not.toMatch(PATH);
      expect(out, "the extension is what a diagnostic actually uses").toContain(`<path ${ext}>`);
    });
  }

  it("redacts the encoded path a failed asset fetch carries in its URL", () => {
    // foliate throws `new ResponseError(status, { cause: res })`, and the Response is followed by
    // the cause chain — which is how the book's own path reached the pane by a second route.
    const e = Object.assign(new Error("404 Not Found"), {
      name: "ResponseError",
      cause: { url: "http://asset.localhost/D%3A%2F%D9%83%D8%AA%D8%A8%2Fbook.epub", status: 404 },
    });
    const out = describeError(e);
    expect(out).toContain("ResponseError: 404 Not Found");
    expect(out).not.toContain("%D9%83");
    expect(out).toContain("<path .epub>");
  });

  it("redacts a filename that has SPACES in it, which is most of them", () => {
    // THE FIRST ATTEMPT AT THIS STOPPED THE PATH AT THE FIRST SPACE, and a stopped path leaves the
    // rest of the name standing: `/books/My Private Book.epub` came out as `<path> Private
    // Book.epub`, which hands over the title while looking as though it had not.
    const out = describeError(new Error("Failed to read /home/reader/Books/My Private Book.epub"));
    expect(out).not.toMatch(/Private|Book\.epub/);
    expect(out).toContain("<path .epub>");
  });

  it("keeps the host of an asset URL, which is the useful half of that message", () => {
    // ALSO FROM THE FIRST ATTEMPT: `http://` matched the drive-letter rule at `p:/`, so the whole
    // URL vanished — including `asset.localhost`, which is what says WHICH ROUTE was being used.
    const out = describeError(new Error("fetch failed: http://asset.localhost/C%3A%2Fbooks%2Fx.epub"));
    expect(out).toContain("http://asset.localhost/");
    expect(out).toContain("<path .epub>");
    expect(out).not.toMatch(/books/);
  });

  it("does not take the engine's own words with it", () => {
    // A path is closed by a character a filename cannot contain, so the reason survives beside it.
    expect(describeError(new Error("could not read C:\\books\\x.epub: access denied"))).toBe(
      "could not read <path .epub>: access denied",
    );
  });

  it("leaves a message that has no path in it completely alone", () => {
    // The redaction must not cost the diagnostic its content — this is the reported PDF failure.
    expect(describeError(new Error("hashOriginal.toHex is not a function"))).toBe(
      "hashOriginal.toHex is not a function",
    );
  });

  it("does not let a folder name decide how a failure is classified", () => {
    // A reader whose books live in a folder called `zips` was one substring away from being told a
    // perfectly good file was a damaged archive, because the `corrupt` rule matches "zip".
    const out = describeError(new Error("could not read C:\\zips\\novel.epub"));
    expect(out).not.toMatch(/zips/);
  });
});

describe("describeError", () => {
  it("keeps an explicitly-set name (the PDF.js convention)", () => {
    // PDF.js's BaseException assigns `this.name`, which is why the reported string carried
    // "UnknownErrorException:" at all.
    const e = new Error("hashOriginal.toHex is not a function");
    e.name = "UnknownErrorException";
    expect(describeError(e)).toBe("UnknownErrorException: hashOriginal.toHex is not a function");
  });

  it("keeps a CONSTRUCTOR name too (the foliate convention)", () => {
    // foliate declares `class NotFoundError extends Error {}` (view.js:66-68) and never sets
    // `name`, so `e.name` is the inherited "Error" and only the constructor knows the truth.
    // Reading `e.name` alone dropped every foliate error class.
    class NotFoundError extends Error {}
    expect(describeError(new NotFoundError("File not found"))).toBe("NotFoundError: File not found");
    class UnsupportedTypeError extends Error {}
    expect(describeError(new UnsupportedTypeError("File type not supported"))).toBe(
      "UnsupportedTypeError: File type not supported",
    );
  });

  it("does not prefix a plain Error with a useless 'Error:'", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
  });

  it("follows a cause chain, bounded so a cycle cannot hang it", () => {
    const deep = new Error("a", { cause: new Error("b", { cause: new Error("c", { cause: new Error("d") }) }) });
    const s = describeError(deep);
    expect(s).toContain("a");
    expect(s).toContain("b");
    expect(s.length).toBeLessThan(4100);
  });

  it("handles anything at all without throwing", () => {
    for (const junk of [null, undefined, 0, "", "x", { message: "m", name: "N" }, { a: 1 }, [1], Symbol("s")]) {
      expect(() => describeError(junk)).not.toThrow();
    }
    expect(describeError({ name: "N", message: "m" })).toBe("N: m");
  });

  it("caps a runaway string so it cannot bloat the settings row", () => {
    expect(describeError("x".repeat(50_000)).length).toBe(4000);
  });

  it("survives an object that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeError(cyclic)).not.toThrow();
  });
});

describe("matchRule", () => {
  const rules = [
    { kind: "a" as const, test: /alpha/, note: "" },
    { kind: "b" as const, test: /beta/, note: "" },
  ];

  it("returns the FIRST matching rule — order is the priority", () => {
    expect(matchRule("alpha beta", rules, "fallback" as never)).toBe("a");
  });

  it("falls back rather than force-fitting an unknown string", () => {
    expect(matchRule("gamma", rules, "fallback" as never)).toBe("fallback");
  });
});

describe("the diagnostics ring", () => {
  const entry = (kind: string) => ({
    at: Date.now(),
    scope: "book-open",
    kind,
    fault: "book" as const,
    raw: `raw-${kind}`,
    context: { bookId: "b1" },
  });

  it("records and reads back", async () => {
    recordDiagnostic(entry("corrupt"));
    await flush();
    const list = await readDiagnostics();
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("corrupt");
  });

  it("is bounded — an app that fails all day cannot grow the settings row without limit", async () => {
    for (let i = 0; i < 80; i++) {
      recordDiagnostic(entry(`k${i}`));
      await flush();
    }
    const list = await readDiagnostics();
    expect(list.length).toBeLessThanOrEqual(60);
    // …and it keeps the NEWEST, which are the ones a report is about.
    expect(list.at(-1)?.kind).toBe("k79");
  });

  it("treats a corrupt stored value as 'nothing recorded', never a throw", async () => {
    store.set("diagnostics", "{not json");
    resetDiagnosticsCache();
    await expect(readDiagnostics()).resolves.toEqual([]);
  });

  it("treats a non-array stored value as empty", async () => {
    store.set("diagnostics", '{"a":1}');
    resetDiagnosticsCache();
    await expect(readDiagnostics()).resolves.toEqual([]);
  });

  it("never throws when persistence fails — recording a failure must not fail", async () => {
    const { settingsSet } = await import("../../src/lib/ipc");
    const spy = vi.spyOn({ settingsSet }, "settingsSet");
    spy.mockRejectedValue(new Error("db locked"));
    expect(() => recordDiagnostic(entry("x"))).not.toThrow();
    await flush();
  });

  it("builds a diagnostic from a classified failure without losing the raw text", () => {
    const d = toDiagnostic("book-open", {
      kind: "runtime-outdated",
      presentation: { fault: "environment", titleKey: "err.runtime.title", bodyKey: "err.runtime.body", actions: ["back"] },
      raw: "UnknownErrorException: hashOriginal.toHex is not a function",
      context: { bookId: "abc", format: "pdf" },
    });
    expect(d.scope).toBe("book-open");
    expect(d.fault).toBe("environment");
    expect(d.raw).toContain("toHex");
    expect(d.context.format).toBe("pdf");
  });
});

describe("formatDiagnostics", () => {
  it("puts the environment first, then every failure, in one pasteable block", () => {
    const out = formatDiagnostics(
      [
        {
          at: 0,
          scope: "book-open",
          kind: "runtime-outdated",
          fault: "environment",
          raw: "UnknownErrorException: hashOriginal.toHex is not a function",
          context: { bookId: "abc", format: "pdf", empty: "" },
        },
      ],
      { engine: "Chrome/139.0.0.0", pdf: "missing: Uint8Array.prototype.toHex" },
    );
    expect(out).toContain("engine: Chrome/139.0.0.0");
    expect(out).toContain("missing: Uint8Array.prototype.toHex");
    expect(out).toContain("runtime-outdated");
    expect(out).toContain("fault=environment");
    expect(out).toContain("bookId=abc");
    expect(out).toContain("hashOriginal.toHex");
    expect(out).not.toContain("empty="); // blank context values are noise in a report
  });

  it("says so plainly when there is nothing recorded", () => {
    expect(formatDiagnostics([], { engine: "x" })).toContain("(none)");
  });
});
