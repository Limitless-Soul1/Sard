// TRANSLATION MODELS — the Settings section (private Settings design, approved 2026-10-21).
//
// Two cards, the same for both models, built on the Fonts cards. Nothing is pushed: Download is the accent-TINTED
// action on each ("offered, not urged"), and the section has no accent primary. What a card says is decided in
// `view.ts`; this file only draws it. Every rule — the licence gate, the check before a download, one operation per
// file, "in use" — is the backend's, so a disabled control here is a courtesy and never the only guard.
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import type { TKey } from "../../../i18n/locales/en";
import { localeNum } from "../../../lib/format";
import {
  acceptTerms,
  cancelFetch,
  fetchModel,
  licenceTerms,
  modelsOverview,
  onModelEvent,
  removeModel,
  verifyModel,
  type ActionErrorView,
  type ModelView,
  type Overview,
  type TermsView,
} from "./api";
import { LicenceDialog } from "./LicenceDialog";
import { applyEvent, cardView, shownLicence, size, without, type Failures, type Jobs, type Message } from "./view";

/** The models' names: proper names, never translated (shown in <bdi> inside Arabic). */
const NAMES: Record<string, string> = { "milmmt-46-4b-q6k": "MiLMMT-46", "gemma-4-e2b-it-q4-0": "Gemma 4 E2B" };

/** A Latin name inside a sentence: isolated (U+2068 … U+2069), so it keeps its own direction in Arabic. */
const isolated = (name: string) => `\u2068${name}\u2069`;

const COPY: Record<string, { tagline: TKey; body: TKey }> = {
  "milmmt-46-4b-q6k": { tagline: "translation.model.a.tagline", body: "translation.model.a.body" },
  "gemma-4-e2b-it-q4-0": { tagline: "translation.model.b.tagline", body: "translation.model.b.body" },
};

const LICENCE_NAME: Record<string, TKey> = { gemma_terms: "translation.licence.name.gemma", apache2: "translation.licence.name.apache2" };

/** Where a licence can be read today, when Sard carries no text of it: the page the model's own card links to. */
const LICENCE_PAGE: Record<string, string> = { apache2: "https://ai.google.dev/gemma/apache_2" };

const DownloadGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);

const openPage = (href: string) => {
  void (async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(href);
    } catch {
      /* a link that cannot open must not become an error */
    }
  })();
};

export function TranslationSection() {
  const { t, lang } = useI18n();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // What is running and what failed change together on every event, so they are one state.
  const [run, setRun] = useState<{ jobs: Jobs; failures: Failures }>({ jobs: {}, failures: {} });
  const { jobs, failures } = run;
  const setJobs = (f: (j: Jobs) => Jobs) => setRun((r) => ({ ...r, jobs: f(r.jobs) }));
  const setFailures = (f: (x: Failures) => Failures) => setRun((r) => ({ ...r, failures: f(r.failures) }));
  /** A finished verification's result line, per model. */
  const [notices, setNotices] = useState<Record<string, TKey>>({});
  /** The model whose Remove is at its confirm step. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** A verify or remove under way. */
  const [working, setWorking] = useState<Record<string, "verify" | "remove">>({});
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const [licence, setLicence] = useState<{ model: ModelView; terms: TermsView } | null>(null);

  const refresh = useCallback(() => {
    modelsOverview()
      .then((o) => { setOverview(o); setLoadError(null); })
      .catch((e: unknown) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const stop = onModelEvent((e) => {
      setRun((r) => {
        const applied = applyEvent(r.jobs, r.failures, e);
        return { jobs: applied.jobs, failures: applied.failures };
      });
      // The same rule as `applyEvent`'s `ended`: the model's own end, finished or failed.
      if ((e.kind === "finished" && !e.runtime) || e.kind === "failed") refresh();
    });
    return () => { void stop.then((un) => un()); };
  }, [refresh]);

  const fmt = (bytes: number) => size(bytes, { mb: t("upd.mb"), gb: t("translation.unit.gb") });
  const say = (m: Message) => t(m.key, m.vars ? Object.fromEntries(Object.entries(m.vars).map(([k, v]) => [k, fmt(v)])) : undefined);
  const fail = (model: string, e: unknown) => setFailures((f) => ({ ...f, [model]: e as ActionErrorView }));

  const start = async (m: ModelView, resume: boolean, needsLicence: boolean) => {
    setNotices((n) => without(n, m.id));
    if (needsLicence) {
      // Only ever reached when the backend carries the terms: without them the card's Download is disabled, and the
      // backend refuses an acceptance anyway.
      const terms = await licenceTerms(m.id).catch(() => null);
      if (terms) setLicence({ model: m, terms });
      return;
    }
    setFailures((f) => without(f, m.id));
    setJobs((j) => ({ ...j, [m.id]: { step: "checking", runtime: false, done: null, total: null, cancelling: false } }));
    await fetchModel(m.id, resume).catch((e: unknown) => {
      setJobs((j) => without(j, m.id));
      fail(m.id, e);
    });
  };

  const cancel = (model: string) => {
    setJobs((j) => (j[model] ? { ...j, [model]: { ...j[model], cancelling: true } } : j));
    void cancelFetch(model);
  };

  const verify = async (model: string) => {
    setWorking((w) => ({ ...w, [model]: "verify" }));
    setNotices((n) => without(n, model));
    try {
      const r = await verifyModel(model);
      if (r !== "nothing") setNotices((n) => ({ ...n, [model]: r === "intact" ? "translation.verify.intact" : "translation.verify.mismatch" }));
      setFailures((f) => without(f, model));
    } catch (e) {
      fail(model, e);
    } finally {
      setWorking((w) => without(w, model));
      refresh();
    }
  };

  const remove = async (model: string) => {
    setConfirming(null);
    setWorking((w) => ({ ...w, [model]: "remove" }));
    try {
      await removeModel(model);
      setFailures((f) => without(f, model));
      setNotices((n) => without(n, model));
    } catch (e) {
      fail(model, e);
    } finally {
      setWorking((w) => without(w, model));
      refresh();
    }
  };

  if (!overview) {
    return (
      <>
        <div className="gs-h1">{t("translation.models.title")}</div>
        {loadError ? <Failure text={t("translation.fail.load")} detail={loadError} open={!!details._load} onToggle={() => setDetails((d) => ({ ...d, _load: !d._load }))} /> : <span className="spin-ring tr-spin" aria-hidden />}
      </>
    );
  }

  const running = new Set([...Object.keys(jobs), ...overview.fetching]);

  return (
    <>
      <div className="gs-h1">{t("translation.models.title")}</div>
      <p className="tr-hint">{t("translation.privacy.local")}</p>
      {!overview.supported && <p className="tr-reason">{t("translation.unsupportedPlatform")}</p>}
      {overview.testCatalog && <p className="tr-reason">{t("translation.dev.testCatalog")}</p>}

      <div className="tr-cards">
        {overview.models.map((m) => {
          const name = NAMES[m.id] ?? m.id;
          const copy = COPY[m.id];
          const job = jobs[m.id];
          const v = cardView(m, job, failures[m.id], {
            otherRunning: [...running].some((id) => id !== m.id),
            fetching: overview.fetching.includes(m.id),
            preparing: overview.preparing.includes(m.id),
            supported: overview.supported,
          });
          const busyWith = working[m.id];
          const licence = shownLicence(m);
          const licenceName = licence ? LICENCE_NAME[licence] : undefined;
          const page = licence ? LICENCE_PAGE[licence] : undefined;
          return (
            <section key={m.id} className="gs-fcard tr-card">
              <div className="tr-card-head">
                <div className="tr-card-id">
                  <div className="gs-fcard-title"><bdi>{name}</bdi></div>
                  {copy && <div className="gs-fcard-sub">{t(copy.tagline)}</div>}
                </div>
                {v.primary && v.primary.action !== "verify" && (
                  <button className="gs-update-btn" disabled={v.primary.disabled != null} onClick={() => void start(m, v.primary!.action === "resume", v.primary!.needsLicence)}>
                    <DownloadGlyph />
                    <span>{t(v.primary.label)}</span>
                  </button>
                )}
              </div>

              {copy && <p className="tr-body">{t(copy.body)}</p>}

              <div className="tr-facts">
                <span>{t("translation.facts.downloadSize")} <span className="tnum">{fmt(m.size)}</span></span>
                {m.diskStillNeeded > 0 && <span>{t("translation.facts.spaceNeeded")} <span className="tnum">{fmt(m.diskStillNeeded)}</span></span>}
              </div>

              {licenceName && (
                <div className="tr-licence">
                  <span className="tr-licence-lbl">{t("translation.licence.label")}</span>
                  <bdi>{t(licenceName)}</bdi>
                  {page && <button className="gs-flib-remove" onClick={() => openPage(page)}>{t("translation.licence.view")}</button>}
                </div>
              )}

              {v.busy && (
                <div className="tr-busy">
                  <div className="tr-line">
                    {!v.busy.progress && <span className="spin-ring tr-spin" aria-hidden />}
                    <span>{t(v.busy.label)}</span>
                  </div>
                  {v.busy.progress && (
                    <>
                      <div className="upd-bar tr-bar">
                        <div className="upd-bar-fill" style={{ width: `${Math.min(100, (v.busy.progress.done / v.busy.progress.total) * 100)}%` }} />
                      </div>
                      <div className="upd-bar-meta tr-bar-meta">
                        <span className="tnum">{t("translation.progress.amount", { done: fmt(v.busy.progress.done), total: fmt(v.busy.progress.total) })}</span>
                        <span className="tnum">{localeNum(Math.round((v.busy.progress.done / v.busy.progress.total) * 100), lang)}%</span>
                      </div>
                    </>
                  )}
                  {(v.busy.canCancel || v.busy.cancelling) && (
                    <div className="tr-actions">
                      <button className="upd-btn" disabled={v.busy.cancelling} onClick={() => cancel(m.id)}>
                        {v.busy.cancelling ? t("upd.cancelling") : t("upd.cancel")}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {(v.state || v.inUse) && (
                <div className="tr-line">
                  {v.state && <span className="tr-state tnum">{say(v.state)}</span>}
                  {v.inUse && <span className="tr-badge">{t("translation.state.inUse")}</span>}
                </div>
              )}

              {notices[m.id] && <p className="tr-reason">{t(notices[m.id])}</p>}

              {v.failure && (
                <Failure
                  text={say(v.failure.message)}
                  detail={v.failure.detail}
                  open={!!details[m.id]}
                  onToggle={() => setDetails((d) => ({ ...d, [m.id]: !d[m.id] }))}
                />
              )}

              {v.note && <p className="tr-reason">{t(v.note, { name: isolated(name) })}</p>}
              {v.primary?.disabled && v.primary.disabled !== v.note && <p className="tr-reason">{t(v.primary.disabled, { name: isolated(name) })}</p>}

              {(v.verify || v.remove || v.primary?.action === "verify") && !v.busy && (
                <div className="tr-actions">
                  {confirming === m.id ? (
                    <>
                      <button className="edit-del confirm" onClick={() => void remove(m.id)}>{t("translation.remove.confirm")}</button>
                      <span className="edit-del-warn">{t("translation.remove.keeps")}</span>
                      <button className="upd-btn" onClick={() => setConfirming(null)}>{t("upd.cancel")}</button>
                    </>
                  ) : (
                    <>
                      {v.remove && (
                        <button className="edit-del" disabled={v.remove.disabled != null || busyWith != null} onClick={() => setConfirming(m.id)}>
                          {busyWith === "remove" ? t("translation.state.removing") : t("gs.remove")}
                        </button>
                      )}
                      {(v.verify || v.primary?.action === "verify") && (
                        <button
                          className="upd-btn tr-push-end"
                          disabled={(v.verify?.disabled ?? v.primary?.disabled ?? null) != null || busyWith != null}
                          onClick={() => void verify(m.id)}
                        >
                          {busyWith === "verify" ? t("translation.state.verifying") : t("translation.action.verify")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              {(v.remove?.disabled ?? v.verify?.disabled) && <p className="tr-reason">{t((v.remove?.disabled ?? v.verify?.disabled)!)}</p>}
            </section>
          );
        })}
      </div>

      <p className="tr-note">{t("translation.engine.note", { size: fmt(overview.runtimeSize) })}</p>

      {licence && (
        <LicenceDialog
          name={isolated(NAMES[licence.model.id] ?? licence.model.id)}
          terms={licence.terms}
          stale={licence.model.licenceStatus.kind === "stale"}
          onDecline={() => setLicence(null)}
          onAccept={async (revision) => {
            await acceptTerms(licence.model.id, revision);
            const m = licence.model;
            setLicence(null);
            await start({ ...m, licenceStatus: { kind: "accepted", revision, at: 0 } }, false, false);
          }}
        />
      )}
    </>
  );
}

/** A failure, said in one sentence in the card — never a toast — with the technical text behind Details. */
function Failure({ text, detail, open, onToggle }: { text: string; detail: string | null; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <div className="tr-failure">
      <p className="edit-cover-error">{text}</p>
      {detail && (
        <>
          <button className="reader-error-btn err-btn-quiet tr-details" onClick={onToggle}>{open ? t("err.act.hideDetails") : t("err.act.details")}</button>
          {open && <pre className="tr-detail" dir="ltr">{detail}</pre>}
        </>
      )}
    </div>
  );
}
