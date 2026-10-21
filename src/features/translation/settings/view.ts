// What a model card shows, decided from the backend's overview, the fetch events and the last failure — pure, so it
// is tested without a DOM. The rules are the Settings design's (private plan): no hardware verdict is shown except an
// exact disk shortage; a downloaded model is "Downloaded" until a preparation has passed, and only then "Ready" (the
// backend decides which); a disabled action always carries its reason; a failure is a sentence in the card, with the
// technical text behind Details; a cancel is not a failure (the card shows what was kept).

import type { TKey } from "../../../i18n/locales/en";
import type { ActionErrorView, EventView, ModelView, StepView } from "./api";

export interface Job {
  step: StepView;
  /** The step concerns the translation engine (first model only), not the model itself. */
  runtime: boolean;
  done: number | null;
  total: number | null;
  cancelling: boolean;
}

export type Jobs = Readonly<Record<string, Job>>;
export type Failures = Readonly<Record<string, ActionErrorView>>;

export interface Applied {
  jobs: Jobs;
  failures: Failures;
  /** The fetch ended: the overview must be read again. */
  ended: boolean;
}

/** A copy of `record` without `key`. */
export function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** Fold one fetch event into what is running and what failed. */
export function applyEvent(jobs: Jobs, failures: Failures, e: EventView): Applied {
  const prev = jobs[e.model];
  const keep = { cancelling: prev?.cancelling ?? false };
  switch (e.kind) {
    case "step": {
      const sameFile = prev && prev.runtime === e.runtime && prev.step === "downloading" && e.step === "downloading";
      const job: Job = { step: e.step, runtime: e.runtime, done: sameFile ? prev.done : null, total: sameFile ? prev.total : null, ...keep };
      return { jobs: { ...jobs, [e.model]: job }, failures: without(failures, e.model), ended: false };
    }
    case "progress":
      return { jobs: { ...jobs, [e.model]: { step: "downloading", runtime: e.runtime, done: e.done, total: e.total, ...keep } }, failures, ended: false };
    case "finished":
      if (e.runtime) return { jobs, failures, ended: false };
      return { jobs: without(jobs, e.model), failures, ended: true };
    case "failed": {
      const cancelled = (e.error.kind === "download" && e.error.cause.kind === "cancelled") || e.error.kind === "cancelled";
      return { jobs: without(jobs, e.model), failures: cancelled ? failures : { ...failures, [e.model]: e.error }, ended: true };
    }
  }
}

export interface Message {
  key: TKey;
  vars?: Record<string, number>;
}

/** The sentence for a failure, and whether trying again means resuming (bytes were kept). */
export function failureMessage(e: ActionErrorView): { message: Message; resume: boolean; detail: string | null } {
  const detail = "detail" in e ? e.detail : "reason" in e ? e.reason : null;
  const m = (key: TKey, vars?: Record<string, number>) => ({ key, vars });
  switch (e.kind) {
    case "download": {
      const c = e.cause;
      switch (c.kind) {
        case "network":
        case "bad_response":
        case "io":
          if (c.keptBytes > 0) return { message: m("translation.fail.networkKept"), resume: true, detail };
          return { message: m(c.kind === "bad_response" ? "translation.fail.sourceUnavailable" : "upd.err.download"), resume: false, detail };
        case "checksum_mismatch":
        case "oversized_partial":
          return { message: m("translation.fail.damaged"), resume: false, detail };
        case "insufficient_space":
          return { message: m("translation.fail.disk", { needed: c.needed, free: c.available }), resume: false, detail };
        case "partial_exists":
          return { message: m("translation.fail.partialExists"), resume: true, detail };
        case "cancelled":
          return { message: m("translation.state.interrupted"), resume: true, detail };
        default:
          return { message: m("translation.fail.unknown"), resume: false, detail };
      }
    }
    case "not_eligible": {
      const g = e.gpu as { kind: string; needed?: number; available?: number };
      if (g.kind === "insufficient_disk") return { message: m("translation.fail.disk", { needed: g.needed ?? 0, free: g.available ?? 0 }), resume: false, detail };
      if (g.kind === "insufficient_ram") return { message: m("translation.fail.memory"), resume: false, detail };
      return { message: m("translation.fail.check"), resume: false, detail };
    }
    case "check_failed":
      return { message: m("translation.fail.check"), resume: false, detail };
    case "licence_not_accepted":
      return { message: m("translation.fail.licence"), resume: false, detail };
    case "damaged":
      return { message: m("translation.fail.damagedRecord"), resume: false, detail };
    case "install":
      return { message: m(e.engineBusy ? "translation.inUse.engine" : "translation.fail.install"), resume: false, detail };
    case "in_use":
      return { message: m(e.by === "engine" ? "translation.inUse.engine" : "translation.inUse.translation"), resume: false, detail };
    case "busy":
    case "running":
      return { message: m("translation.fail.busy"), resume: false, detail };
    case "prepare":
      return { message: m(e.memory ? "translation.fail.memory" : e.engineBusy ? "translation.inUse.engine" : "translation.fail.unknown"), resume: false, detail };
    default:
      return { message: m("translation.fail.unknown"), resume: false, detail };
  }
}

export type PrimaryAction = "download" | "resume" | "verify";

export interface CardView {
  /** A muted state line ("Downloaded", "Interrupted", …), or none. */
  state: Message | null;
  /** The advisory badge. */
  inUse: boolean;
  /** A fetch is running: what it is doing. */
  busy: { label: TKey; progress: { done: number; total: number } | null; canCancel: boolean; cancelling: boolean } | null;
  primary: { action: PrimaryAction; label: TKey; disabled: TKey | null; needsLicence: boolean } | null;
  verify: { disabled: TKey | null } | null;
  remove: { disabled: TKey | null } | null;
  failure: { message: Message; resume: boolean; detail: string | null } | null;
  /** A line that explains why the model cannot be fetched at all (its terms, the platform, the disk). */
  note: TKey | null;
}

export interface CardContext {
  /** Another model's fetch is running. */
  otherRunning: boolean;
  /** The backend says a fetch of this model runs, though no event has arrived yet (the section was reopened). */
  fetching: boolean;
  /** The backend says that fetch is preparing the model. */
  preparing: boolean;
  supported: boolean;
}

const stepLabel = (j: Job): TKey =>
  j.cancelling
    ? "upd.cancelling"
    : j.step === "checking"
      ? "translation.state.checking"
      : j.step === "verifying"
        ? "translation.state.verifying"
        : j.step === "installing"
          ? "upd.installing"
          : j.step === "preparing"
            ? "translation.state.preparing"
            : j.runtime
              ? "translation.state.engine"
              : "translation.state.downloading";

export function cardView(m: ModelView, job: Job | undefined, failure: ActionErrorView | undefined, ctx: CardContext): CardView {
  const inUseReason: TKey | null = m.inUse === "engine" ? "translation.inUse.engine" : m.inUse === "translation" ? "translation.inUse.translation" : null;
  const empty: CardView = { state: null, inUse: m.inUse != null, busy: null, primary: null, verify: null, remove: null, failure: null, note: null };

  if (job || ctx.fetching) {
    const j = job ?? { step: (ctx.preparing ? "preparing" : "downloading") as StepView, runtime: false, done: null, total: null, cancelling: false };
    const progress = j.step === "downloading" && j.done != null && j.total != null && j.total > 0 ? { done: j.done, total: j.total } : null;
    const cancellable = j.step === "checking" || j.step === "downloading" || j.step === "preparing";
    return { ...empty, busy: { label: stepLabel(j), progress, canCancel: cancellable && !j.cancelling, cancelling: j.cancelling } };
  }

  // Why a fetch cannot start, in order of what the reader can least change.
  const blocked: TKey | null = !ctx.supported
    ? "translation.unsupportedPlatform"
    : m.licenceMustBeAccepted && !m.termsAvailable
      ? "translation.licence.pending"
      : ctx.otherRunning
        ? "translation.busy.other"
        : m.notEnoughDisk
          ? "translation.fit.noDisk"
          : null;
  const needsLicence = m.licenceMustBeAccepted && m.licenceStatus.kind !== "accepted" && m.licenceStatus.kind !== "not_required";
  // While the terms are not carried there is nothing to accept: a refused fetch must not say "accept them first", which
  // would imply that accepting is possible. The card's note ("still being reviewed") is the whole truth then.
  const licenceRefusalWithoutTerms = failure?.kind === "licence_not_accepted" && !m.termsAvailable;
  const fail = failure && !licenceRefusalWithoutTerms ? failureMessage(failure) : null;
  const removable = { disabled: inUseReason };

  switch (m.state.kind) {
    case "not_downloaded":
      return {
        ...empty,
        primary: { action: "download", label: fail ? "err.act.retry" : "translation.action.download", disabled: blocked, needsLicence },
        failure: fail,
        note: blocked === "translation.licence.pending" || blocked === "translation.unsupportedPlatform" ? blocked : null,
      };
    case "interrupted":
      return {
        ...empty,
        state: { key: "translation.progress.kept", vars: { done: m.state.bytes, total: m.size } },
        primary: { action: "resume", label: "translation.action.resume", disabled: blocked === "translation.fit.noDisk" ? null : blocked, needsLicence },
        remove: removable,
        failure: fail && fail.message.key !== "translation.state.interrupted" ? fail : null,
        note: blocked === "translation.licence.pending" ? blocked : null,
      };
    case "installed":
      if (m.ready) return { ...empty, state: { key: "translation.state.ready" }, verify: { disabled: inUseReason }, remove: removable, failure: fail };
      // Downloaded, but no preparation has passed: it was cancelled, it failed, or Sard closed during it. Trying again
      // is the same fetch, which finds every file in place and prepares.
      return {
        ...empty,
        state: { key: "translation.state.downloaded" },
        primary: { action: "download", label: "err.act.retry", disabled: blocked, needsLicence },
        verify: { disabled: inUseReason },
        remove: removable,
        failure: fail,
        note: blocked === "translation.licence.pending" || blocked === "translation.unsupportedPlatform" ? blocked : null,
      };
    case "unverified":
      return { ...empty, state: { key: "translation.state.unverified" }, primary: { action: "verify", label: "translation.action.verify", disabled: inUseReason, needsLicence: false }, remove: removable, failure: fail };
    case "damaged":
      return {
        ...empty,
        verify: { disabled: inUseReason },
        remove: removable,
        failure: fail ?? { message: { key: "translation.fail.damagedRecord" }, resume: false, detail: m.state.reason },
      };
  }
}

/** The licence a card names, or none. MiLMMT-46's is not named while its terms are not carried: whether the Gemma terms
 *  govern its weights is the open legal question, and naming them would answer it. The card's "still being reviewed"
 *  line says why. */
export function shownLicence(m: ModelView): ModelView["licence"] | null {
  return m.licence === "gemma_terms" && !m.termsAvailable ? null : m.licence;
}

/** Bytes as the updater shows them (binary units, the locale's unit names), GB from 1 GiB up. Under 1 MB, two decimals,
 *  so that a small file never reads as "0.0". */
export function size(bytes: number, units: { mb: string; gb: string }): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(2)} ${units.gb}`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(mib < 1 ? 2 : mib < 10 ? 1 : 0)} ${units.mb}`;
}
