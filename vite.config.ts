import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// IS THIS A DIAGNOSTIC BUILD? Set by `scripts/pack-diag.mjs` and by nothing else.
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

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: IS_DIAG ? [react()] : [diagOffPlugin, react()],

  define: { __SARD_BUILD_ID__: JSON.stringify(BUILD_ID) },

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
