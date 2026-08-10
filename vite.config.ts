import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// IS THIS A DIAGNOSTIC BUILD? Set by the diagnostic packaging step and by nothing else.
//
// The default is FALSE, and that default is the point: every ordinary `npm run build`, every CI run
// and every release produces a bundle with no instrumentation in it, without anyone having to
// remember to turn anything off. Only the diagnostic packager opts in, and it opts in to the Cargo
// feature and the identity overlay at the same moment — the three cannot be set separately.
// @ts-expect-error process is a nodejs global
const IS_DIAG = process.env.SARD_BUILD_KIND === "diag";

// The diagnostic modules, replaced wholesale by no-ops in a release build. See src/lib/diagOff.ts for
// why this is a substitution and not a runtime flag: it makes the absence MEASURABLE, and
// `scripts/verify-artifact.mjs` refuses to ship an artifact whose absence it cannot measure.
const DIAG_MODULES = ["diag", "pdfDiag", "renderDiag", "stageLedger"];
const DIAG_OFF = resolve(import.meta.dirname, "src/lib/diagOff.ts");
const DIAG_FILES = new Set(
  DIAG_MODULES.map((m) => resolve(import.meta.dirname, `src/lib/${m}.ts`).replace(/\\/g, "/")),
);

// HOW PRODUCT CODE NAMES THE INSTRUMENTATION.
//
// Product code imports `@diag`, `@pdfDiag` and `@renderDiag` — BARE specifiers, not relative paths,
// and that is the whole point. `tsconfig.json` maps each to a two-entry fallback list, real module
// first and `diagOff.ts` second, so the typechecker follows the same substitution the bundler does:
// on `develop` it finds the real module, and on `main` — where the production tree does not carry the
// instrumentation at all — it falls back to the stub. TypeScript only applies `paths` to bare
// specifiers, never to `./diag`, which is why the specifiers had to change.
//
// This was found the hard way: the v1.2.0 release failed in CI because `npm run build` runs
// `tsc` BEFORE Vite, and the typechecker cannot resolve an import whose file the production tree
// legitimately excludes. The bundler alias alone was never enough.
const DIAG_ALIASES: Record<string, string> = {
  "@diag": "src/lib/diag.ts",
  "@pdfDiag": "src/lib/pdfDiag.ts",
  "@renderDiag": "src/lib/renderDiag.ts",
};

// ALWAYS REGISTERED, for BOTH build kinds — and that is not a detail.
//
// `diagOffPlugin` below is deliberately omitted from diagnostic builds. Putting this resolution inside
// it therefore left a diagnostic build unable to resolve `@diag` at all. The alias must be answered by
// a plugin that is never omitted; only the SUBSTITUTION stays conditional.
const diagAliasPlugin = {
  name: "sard-diagnostics-alias",
  enforce: "pre" as const,
  resolveId(source: string) {
    const target = DIAG_ALIASES[source];
    if (!target) return null;
    return IS_DIAG ? resolve(import.meta.dirname, target) : DIAG_OFF;
  },
};

// Matched on the RESOLVED FILE, never on the import specifier.
//
// The first version of this matched specifiers with a regex and silently missed `./diag` — the way
// a sibling inside src/lib spells it. One unmatched import pulled the entire subsystem back into the
// release bundle (682 KB instead of 646 KB, every marker present) while the config still looked
// correct. A rule about text can be evaded by rewording; a rule about the file on disk cannot, so
// this asks Vite where the import actually lands and decides from that.
const diagOffPlugin = {
  name: "sard-diagnostics-off",
  enforce: "pre" as const,
  async resolveId(source: string, importer: string | undefined, options: { isEntry: boolean }) {
    if (source === DIAG_OFF || source.endsWith("/diagOff.ts")) return null; // the stub itself
    // @ts-expect-error `this` is Rollup's PluginContext at run time
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!r) return null;
    return DIAG_FILES.has(r.id.replace(/\\/g, "/").split("?")[0]) ? DIAG_OFF : null;
  },
};

// THE BUILD ID, baked into the frontend bundle at build time.
//
// The Rust core gets the same string through build.rs, and the diagnostic report prints both side by
// side. Two values that were generated once and then travelled separately can be COMPARED, and that
// comparison answers a question nothing in the running app could answer during the 2026-08-07
// investigation: is the frontend in this executable the one we shipped with it?
//
// Never invented. Without the build scripts it says so, in words, rather than showing a plausible id.
// @ts-expect-error process is a nodejs global
const BUILD_ID = process.env.SARD_BUILD_ID || "UNSET — built directly, not through the Sard build scripts";

// THE READER-HOST BUNDLE — a SECOND build of this same config, not a second configuration.
//
// The host runs the reader engine inside an isolated origin on WebKit (see src-tauri/src/bookhost.rs).
// That code is the same `src/reader-engine` the application uses, so it needs the same `@diag`
// aliasing, the same substitution and the same build id — and getting those from a separate config
// file would mean two places to keep in step. A target switch reuses every plugin above verbatim.
//
// `inlineDynamicImports` makes the result ONE self-contained file. Shared chunks would be emitted to
// `assets/`, which the host origin deliberately does not serve — its allow-list names each path it
// answers, and widening it to `/assets/*.js` would hand the book origin the application's own bundle.
// @ts-expect-error process is a nodejs global
const IS_READER_HOST = process.env.SARD_BUILD_TARGET === "reader-host";

const READER_HOST_BUILD = {
  outDir: "dist/reader-host",
  emptyOutDir: false, // the static index.html is already there, copied from public/
  rollupOptions: {
    input: resolve(import.meta.dirname, "src/reader-host/main.ts"),
    output: {
      format: "es" as const,
      entryFileNames: "bundle.js", // fixed, because bookhost.rs allow-lists this exact path
      inlineDynamicImports: true,
    },
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: IS_DIAG ? [diagAliasPlugin, react()] : [diagAliasPlugin, diagOffPlugin, react()],

  define: { __SARD_BUILD_ID__: JSON.stringify(BUILD_ID) },

  // `publicDir: false` matters as much as the build block. Vite copies the public directory into
  // outDir on EVERY build, so without this the host build copies all of `public/` a second time into
  // `dist/reader-host/` — fonts, the whole foliate-js tree, everything — producing a duplicate of the
  // bundle's own assets nested inside it. The application build already placed those files once.
  ...(IS_READER_HOST ? { build: READER_HOST_BUILD, publicDir: false as const } : {}),

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
