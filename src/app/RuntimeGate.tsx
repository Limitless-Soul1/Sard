// RESILIENCE-1 / WP-1 — the startup runtime gate.
//
// WHEN THIS SHOWS. Only when the EPUB capability itself is missing — i.e. foliate's OPF parser
// cannot run, so NO book of any kind will open. That is a genuinely fatal precondition, and letting
// the user browse a library where every single book fails would be a worse experience than saying
// so once, clearly, at the front door.
//
// A missing PDF capability is deliberately NOT fatal here: EPUB reading is completely unaffected,
// so it is handled where it actually bites (PDF import is refused, and opening an already-imported
// PDF shows the same runtime message through the same card).

import { useI18n } from "../i18n";
import type { Classified } from "../lib/errors";
import { currentEnv, engineLabel, missingFeatures } from "../lib/runtime";
import { canUpdateRuntime, openWebView2Help, WEBVIEW2_URL } from "../lib/webview2";
import { ErrorCard } from "./ErrorCard";

export function RuntimeGate() {
  const { t } = useI18n();
  const env = currentEnv();
  const missing = missingFeatures(env, "epub");

  // The repair offer is WebView2-only. Everywhere else the engine is not the app's to update, so the
  // card states the problem and drops the action rather than pointing at a page that cannot help.
  const canRepair = canUpdateRuntime();

  // The gate is a precondition rather than a caught exception, so its `Classified` is built here.
  // It still goes through ErrorCard: one failure look, no matter where the failure came from.
  const classified: Classified = {
    kind: "runtime-outdated",
    presentation: {
      fault: "environment",
      titleKey: canRepair ? "err.gate.title" : "err.gate.title.engine",
      bodyKey: canRepair ? "err.gate.body" : "err.gate.body.engine",
      actions: canRepair ? ["update-runtime", "details"] : ["details"],
    },
    raw: `pre-flight: this web engine lacks ${missing.join(", ")} — required to render EPUB`,
    context: { stage: "startup-gate", missingForFormat: missing.join(",") },
  };

  return (
    <div className="runtime-gate" role="alert">
      <ErrorCard
        classified={classified}
        handlers={{ "update-runtime": () => void openWebView2Help() }}
        diagnosticsText={`${t("err.gate.engine", { engine: engineLabel() })}\n${t("err.gate.missing", {
          features: missing.join(", "),
        })}${canRepair ? `\n${WEBVIEW2_URL}` : ""}`}
        extra={
          <>
            <p className="err-body">{t(canRepair ? "err.gate.how" : "err.gate.how.engine")}</p>
            <p className="err-gate-meta">{t("err.gate.missing", { features: missing.join(", ") })}</p>
            <p className="err-gate-meta">{t("err.gate.engine", { engine: engineLabel() })}</p>
          </>
        }
      />
    </div>
  );
}
