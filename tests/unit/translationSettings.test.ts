// The Translation models section's decisions, without a DOM: what each card shows for each backend state and fetch
// event, which actions are offered and why one is disabled, how a failure is worded — and the copy's own rules
// (Latin names isolated inside Arabic, an ellipsis on every in-progress label, "Ready" only as the prepared state).
import { describe, expect, it } from "vitest";

import { ar } from "../../src/i18n/locales/ar";
import { en } from "../../src/i18n/locales/en";
import type { ActionErrorView, EventView, ModelView } from "../../src/features/translation/settings/api";
import { applyEvent, cardView, failureMessage, shownLicence, size, type Job } from "../../src/features/translation/settings/view";

const A = "milmmt-46-4b-q6k";
const B = "gemma-4-e2b-it-q4-0";

function model(over: Partial<ModelView> = {}): ModelView {
  return {
    id: B,
    size: 2_841_481_184,
    licence: "apache2",
    licenceMustBeAccepted: false,
    licenceStatus: { kind: "not_required" },
    termsAvailable: false,
    state: { kind: "not_downloaded" },
    ready: false,
    diskStillNeeded: 2_900_000_000,
    notEnoughDisk: false,
    inUse: null,
    gpu: null,
    cpu: null,
    ...over,
  };
}

const modelA = (over: Partial<ModelView> = {}) =>
  model({ id: A, licence: "gemma_terms", licenceMustBeAccepted: true, licenceStatus: { kind: "missing", revision: "r" }, ...over });

const ctx = { otherRunning: false, fetching: false, preparing: false, supported: true };

describe("the cards", () => {
  it("keeps Model A closed while its terms are not carried, and says why", () => {
    const v = cardView(modelA(), undefined, undefined, ctx);
    expect(v.primary).toMatchObject({ action: "download", disabled: "translation.licence.pending" });
    expect(v.note).toBe("translation.licence.pending");
  });

  it("offers Model B's download, and would route Model A through its terms once they are carried", () => {
    expect(cardView(model(), undefined, undefined, ctx).primary).toMatchObject({ action: "download", disabled: null, needsLicence: false });
    expect(cardView(modelA({ termsAvailable: true }), undefined, undefined, ctx).primary).toMatchObject({ disabled: null, needsLicence: true });
    expect(cardView(modelA({ termsAvailable: true, licenceStatus: { kind: "accepted", revision: "r", at: 1 } }), undefined, undefined, ctx).primary).toMatchObject({ needsLicence: false });
  });

  it("disables a download with its reason: another download, no disk, another platform", () => {
    expect(cardView(model(), undefined, undefined, { ...ctx, otherRunning: true }).primary?.disabled).toBe("translation.busy.other");
    expect(cardView(model({ notEnoughDisk: true }), undefined, undefined, ctx).primary?.disabled).toBe("translation.fit.noDisk");
    const other = cardView(model(), undefined, undefined, { ...ctx, supported: false });
    expect(other.primary?.disabled).toBe("translation.unsupportedPlatform");
    expect(other.note).toBe("translation.unsupportedPlatform");
  });

  it("says Downloaded for a model no preparation has passed, and offers to try again", () => {
    const v = cardView(model({ state: { kind: "installed" } }), undefined, undefined, ctx);
    expect(v.state?.key).toBe("translation.state.downloaded");
    expect(v.primary).toMatchObject({ action: "download", label: "err.act.retry", disabled: null });
    expect(v.verify).toEqual({ disabled: null });
    expect(v.remove).toEqual({ disabled: null });
    // "Ready" is only the prepared state's word — and the reader's line that no model is ready yet.
    expect(Object.keys(en).filter((k) => k.startsWith("translation.") && /\bready\b/i.test((en as Record<string, string>)[k]))).toEqual(["translation.state.ready", "translation.reader.noModel"]);
  });

  it("says Ready only for a model the backend says is prepared, and offers nothing to start", () => {
    const v = cardView(model({ state: { kind: "installed" }, ready: true }), undefined, undefined, ctx);
    expect(v.state?.key).toBe("translation.state.ready");
    expect(v.primary).toBeNull();
    expect(v.verify).toEqual({ disabled: null });
    expect(v.remove).toEqual({ disabled: null });
    // Never for a model that is not installed, whatever the flag says.
    expect(cardView(model({ ready: true }), undefined, undefined, ctx).state?.key).not.toBe("translation.state.ready");
  });

  it("shows Preparing while the model is prepared, with Cancel — and again when the section is reopened", () => {
    const preparing: Job = { step: "preparing", runtime: false, done: null, total: null, cancelling: false };
    const v = cardView(model({ state: { kind: "installed" } }), preparing, undefined, ctx);
    expect(v.busy).toEqual({ label: "translation.state.preparing", progress: null, canCancel: true, cancelling: false });
    expect(v.state).toBeNull();
    const reopened = cardView(model({ state: { kind: "installed" } }), undefined, undefined, { ...ctx, fetching: true, preparing: true });
    expect(reopened.busy?.label).toBe("translation.state.preparing");
    const cancelling = cardView(model({ state: { kind: "installed" } }), { ...preparing, cancelling: true }, undefined, ctx);
    expect(cancelling.busy).toMatchObject({ label: "upd.cancelling", canCancel: false });
  });

  it("turns the preparing step into the card's state, and the end of the job into a reload", () => {
    const step: EventView = { kind: "step", model: B, artifact: B, runtime: false, step: "preparing" };
    const a = applyEvent({}, {}, step);
    expect(a.jobs[B]).toMatchObject({ step: "preparing", runtime: false });
    const done = applyEvent(a.jobs, a.failures, { kind: "finished", model: B, artifact: B, runtime: false, state: { kind: "installed" } });
    expect(done).toMatchObject({ jobs: {}, ended: true });
  });

  it("does not treat a cancelled preparation as a failure", () => {
    const e: EventView = { kind: "failed", model: B, artifact: B, runtime: false, state: { kind: "installed" }, error: { kind: "cancelled" } };
    expect(applyEvent({}, {}, e).failures).toEqual({});
  });

  it("words a failed preparation by what the backend found, with the technical text behind Details", () => {
    const prepare = (memory: boolean, engineBusy: boolean): ActionErrorView => ({ kind: "prepare", memory, engineBusy, detail: "the test translation failed: timeout" });
    expect(failureMessage(prepare(true, false)).message.key).toBe("translation.fail.memory");
    expect(failureMessage(prepare(false, true)).message.key).toBe("translation.inUse.engine");
    const other = failureMessage(prepare(false, false));
    expect(other).toEqual({ message: { key: "translation.fail.unknown" }, resume: false, detail: "the test translation failed: timeout" });
    // The card keeps the model downloaded, with the failure and Try again.
    const v = cardView(model({ state: { kind: "installed" } }), undefined, prepare(false, false), ctx);
    expect(v.state?.key).toBe("translation.state.downloaded");
    expect(v.failure?.message.key).toBe("translation.fail.unknown");
    expect(v.primary?.label).toBe("err.act.retry");
  });

  it("shows an interruption with what was kept, and offers Resume and Remove", () => {
    const v = cardView(model({ state: { kind: "interrupted", bytes: 1000 } }), undefined, undefined, ctx);
    expect(v.state).toEqual({ key: "translation.progress.kept", vars: { done: 1000, total: 2_841_481_184 } });
    expect(v.primary).toMatchObject({ action: "resume", label: "translation.action.resume", disabled: null });
    expect(v.remove).toEqual({ disabled: null });
  });

  it("refuses removal and verification of a model in use, with the reason", () => {
    const v = cardView(model({ state: { kind: "installed" }, inUse: "translation" }), undefined, undefined, ctx);
    expect(v.inUse).toBe(true);
    expect(v.remove).toEqual({ disabled: "translation.inUse.translation" });
    expect(v.verify).toEqual({ disabled: "translation.inUse.translation" });
    expect(cardView(model({ state: { kind: "installed" }, inUse: "engine" }), undefined, undefined, ctx).remove).toEqual({ disabled: "translation.inUse.engine" });
  });

  it("draws a running fetch: a bar when there is a fraction, a spinner when there is none, Cancel only while it can stop", () => {
    const down: Job = { step: "downloading", runtime: false, done: 50, total: 200, cancelling: false };
    expect(cardView(model(), down, undefined, ctx).busy).toEqual({ label: "translation.state.downloading", progress: { done: 50, total: 200 }, canCancel: true, cancelling: false });
    const verifying: Job = { step: "verifying", runtime: false, done: null, total: null, cancelling: false };
    expect(cardView(model(), verifying, undefined, ctx).busy).toEqual({ label: "translation.state.verifying", progress: null, canCancel: false, cancelling: false });
    const engine: Job = { step: "downloading", runtime: true, done: 1, total: 2, cancelling: false };
    expect(cardView(model(), engine, undefined, ctx).busy?.label).toBe("translation.state.engine");
    expect(cardView(model(), { ...down, cancelling: true }, undefined, ctx).busy).toMatchObject({ label: "upd.cancelling", canCancel: false, cancelling: true });
    expect(cardView(model(), undefined, undefined, { ...ctx, fetching: true }).busy?.label).toBe("translation.state.downloading");
  });

  it("puts a damaged record's reason behind Details", () => {
    const v = cardView(model({ state: { kind: "damaged", reason: "the file is missing" } }), undefined, undefined, ctx);
    expect(v.failure).toEqual({ message: { key: "translation.fail.damagedRecord" }, resume: false, detail: "the file is missing" });
  });

  it("does not name the Gemma terms on MiLMMT-46's card while the legal question is open", () => {
    expect(shownLicence(modelA())).toBeNull();
    expect(cardView(modelA(), undefined, undefined, ctx).note).toBe("translation.licence.pending");
    expect(shownLicence(model())).toBe("apache2");
    // Named again once the terms are carried — which happens only after the review.
    expect(shownLicence(modelA({ termsAvailable: true }))).toBe("gemma_terms");
  });

  it("words verification by what it checks: the expected contents, not damage", () => {
    expect((en as Record<string, string>)["translation.verify.intact"]).toBe("The file passed verification.");
    expect((en as Record<string, string>)["translation.verify.mismatch"]).toBe("The file didn't match the expected contents, so it was removed. Download it again to use this model.");
    expect((ar as Record<string, string>)["translation.verify.mismatch"]).toBe("لم يطابق الملف المحتوى المتوقَّع، فأُزيل. نزّله مجددًا لاستخدام هذا النموذج.");
  });

  it("scopes the privacy line to the text being translated", () => {
    expect((en as Record<string, string>)["translation.privacy.local"]).toBe("Translation runs entirely on this computer, and the text being translated never leaves it.");
    expect((ar as Record<string, string>)["translation.privacy.local"]).toBe("تجري الترجمة كلّها على هذا الجهاز، ولا يغادره النص الذي يُترجَم.");
  });

  it("never says 'accept the terms first' while there are no terms to accept", () => {
    const refused: ActionErrorView = { kind: "licence_not_accepted", model: A, status: { kind: "missing", revision: "r" } };
    const closed = cardView(modelA(), undefined, refused, ctx);
    expect(closed.failure).toBeNull();
    expect(closed.note).toBe("translation.licence.pending");
    // Once the terms are carried, the refusal is worded as what it is.
    expect(cardView(modelA({ termsAvailable: true }), undefined, refused, ctx).failure?.message.key).toBe("translation.fail.licence");
  });

  it("offers Try again after a failure", () => {
    const e: ActionErrorView = { kind: "check_failed", detail: "x" };
    expect(cardView(model(), undefined, e, ctx).primary?.label).toBe("err.act.retry");
  });
});

describe("the events", () => {
  const step = (s: "checking" | "downloading", runtime = false): EventView => ({ kind: "step", model: B, artifact: B, runtime, step: s });

  it("follows a fetch from its first step to its end", () => {
    let a = applyEvent({}, { [B]: { kind: "cancelled" } }, step("checking"));
    expect(a.jobs[B]).toMatchObject({ step: "checking" });
    expect(a.failures[B]).toBeUndefined();
    a = applyEvent(a.jobs, a.failures, { kind: "progress", model: B, artifact: B, runtime: false, done: 10, total: 20 });
    expect(a.jobs[B]).toMatchObject({ step: "downloading", done: 10, total: 20 });
    expect(applyEvent(a.jobs, a.failures, { kind: "finished", model: B, artifact: "rt", runtime: true, state: { kind: "installed" } }).ended).toBe(false);
    const end = applyEvent(a.jobs, a.failures, { kind: "finished", model: B, artifact: B, runtime: false, state: { kind: "installed" } });
    expect(end.jobs[B]).toBeUndefined();
    expect(end.ended).toBe(true);
  });

  it("records a failure, but a cancel is not one", () => {
    const failed = (error: ActionErrorView): EventView => ({ kind: "failed", model: B, artifact: B, runtime: false, state: { kind: "not_downloaded" }, error });
    const cancelled = applyEvent({}, {}, failed({ kind: "download", artifact: B, cause: { kind: "cancelled", keptBytes: 5 }, detail: "" }));
    expect(cancelled.failures[B]).toBeUndefined();
    const broken = applyEvent({}, {}, failed({ kind: "download", artifact: B, cause: { kind: "checksum_mismatch" }, detail: "d" }));
    expect(broken.failures[B]).toMatchObject({ kind: "download" });
    expect(broken.ended).toBe(true);
  });
});

describe("the failure sentences", () => {
  const download = (cause: Extract<ActionErrorView, { kind: "download" }>["cause"]): ActionErrorView => ({ kind: "download", artifact: B, cause, detail: "technical" });

  it("words each kind, and offers Resume only when bytes were kept", () => {
    expect(failureMessage(download({ kind: "network", keptBytes: 9 }))).toEqual({ message: { key: "translation.fail.networkKept", vars: undefined }, resume: true, detail: "technical" });
    expect(failureMessage(download({ kind: "network", keptBytes: 0 })).message.key).toBe("upd.err.download");
    expect(failureMessage(download({ kind: "bad_response", keptBytes: 0 })).message.key).toBe("translation.fail.sourceUnavailable");
    expect(failureMessage(download({ kind: "checksum_mismatch" })).message.key).toBe("translation.fail.damaged");
    expect(failureMessage(download({ kind: "insufficient_space", needed: 3, available: 1 })).message).toEqual({ key: "translation.fail.disk", vars: { needed: 3, free: 1 } });
    expect(failureMessage({ kind: "not_eligible", model: B, gpu: { kind: "insufficient_ram" }, cpu: { kind: "insufficient_ram" } }).message.key).toBe("translation.fail.memory");
    expect(failureMessage({ kind: "licence_not_accepted", model: A, status: { kind: "missing", revision: "r" } }).message.key).toBe("translation.fail.licence");
    expect(failureMessage({ kind: "in_use", model: B, by: "engine" }).message.key).toBe("translation.inUse.engine");
    expect(failureMessage({ kind: "store", detail: "x" }).message.key).toBe("translation.fail.unknown");
  });
});

describe("sizes", () => {
  it("uses binary units, as the updater does", () => {
    const u = { mb: "MB", gb: "GB" };
    expect(size(2_841_481_184, u)).toBe("2.65 GB");
    expect(size(3_190_739_232, u)).toBe("2.97 GB");
    expect(size(33_425_118, u)).toBe("32 MB");
    expect(size(5_000_000, u)).toBe("4.8 MB");
    expect(size(13_000, u)).toBe("0.01 MB");
  });
});

describe("the copy", () => {
  const arabic = ar as Record<string, string>;
  const english = en as Record<string, string>;
  const ours = Object.keys(english).filter((k) => k.startsWith("translation.") || k === "gs.nav.translation");

  it("isolates every Latin name inside an Arabic sentence", () => {
    for (const k of ours) {
      for (const name of ["MiLMMT-46", "Gemma", "Apache 2.0"]) {
        const s = arabic[k];
        let at = s.indexOf(name);
        while (at >= 0) {
          expect(s[at - 1], `${k}: ${name}`).toBe("\u2068");
          expect(s[at + name.length], `${k}: ${name}`).toBe("\u2069");
          at = s.indexOf(name, at + 1);
        }
      }
    }
  });

  it("ends every in-progress label with an ellipsis, in both languages", () => {
    for (const k of ["translation.state.checking", "translation.state.downloading", "translation.state.engine", "translation.state.verifying", "translation.state.preparing", "translation.state.removing", "translation.reader.translating"]) {
      expect(english[k].endsWith("…"), k).toBe(true);
      expect(arabic[k].endsWith("…"), k).toBe(true);
    }
  });

  it("carries Preparing and Ready exactly as approved", () => {
    expect([english["translation.state.preparing"], english["translation.state.ready"]]).toEqual(["Preparing…", "Ready"]);
    expect([arabic["translation.state.preparing"], arabic["translation.state.ready"]]).toEqual(["جارٍ التجهيز…", "جاهز"]);
  });

  it("leaves the approved strings it reuses exactly as they were", () => {
    expect([english["upd.cancel"], english["upd.cancelling"], english["upd.installing"], english["err.act.retry"]]).toEqual(["Cancel", "Cancelling…", "Installing…", "Try again"]);
    expect([arabic["upd.cancel"], arabic["upd.cancelling"], arabic["err.act.retry"]]).toEqual(["إلغاء", "جارٍ الإلغاء…", "إعادة المحاولة"]);
  });
});
