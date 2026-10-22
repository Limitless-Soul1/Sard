// The Translation models section's contract with the backend. Each type mirrors a serde view in
// src-tauri/src/translation/overview.rs and model_commands.rs, field for field — the backend owns every rule (the
// licence gate, the check before a download, one operation per file, "in use"); this side only shows and asks.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type StateView =
  | { kind: "not_downloaded" }
  | { kind: "interrupted"; bytes: number }
  | { kind: "installed" }
  | { kind: "unverified" }
  | { kind: "damaged"; reason: string };

export type EngineView = { kind: "not_installed" } | { kind: "installed" } | { kind: "unverified" } | { kind: "damaged"; reason: string };

export type LicenceView = "gemma_terms" | "apache2" | "llama_cpp_runtime";

export type LicenceStatusView =
  | { kind: "not_required" }
  | { kind: "accepted"; revision: string; at: number }
  | { kind: "missing"; revision: string }
  | { kind: "stale"; revision: string; accepted: string[] };

export type InUseView = "translation" | "engine";

/** The hardware verdicts are carried, never shown: they are not calibrated (the Settings design, §2). */
export type FitView = { kind: string; [k: string]: unknown };

export interface ModelView {
  id: string;
  size: number;
  licence: LicenceView;
  licenceMustBeAccepted: boolean;
  licenceStatus: LicenceStatusView;
  termsAvailable: boolean;
  state: StateView;
  /** Prepared with its current bytes and the current engine, both installed: "Ready". Never for a model only downloaded. */
  ready: boolean;
  diskStillNeeded: number;
  notEnoughDisk: boolean;
  inUse: InUseView | null;
  gpu: FitView | null;
  cpu: FitView | null;
}

export interface Overview {
  models: ModelView[];
  runtime: StateView;
  runtimeSize: number;
  engine: EngineView;
  hardwareUnavailable: string | null;
  supported: boolean;
  testCatalog: boolean;
  /** The models a fetch is running for now. */
  fetching: string[];
  /** Of those, the models being prepared now. */
  preparing: string[];
}

export type DownloadCause =
  | { kind: "already_present" }
  | { kind: "partial_exists"; bytes: number }
  | { kind: "nothing_to_resume" }
  | { kind: "busy" }
  | { kind: "insufficient_space"; needed: number; available: number }
  | { kind: "url_refused" }
  | { kind: "network"; keptBytes: number }
  | { kind: "bad_response"; keptBytes: number }
  | { kind: "checksum_mismatch" }
  | { kind: "oversized_partial" }
  | { kind: "unsafe_partial" }
  | { kind: "cancelled"; keptBytes: number }
  | { kind: "io"; keptBytes: number };

export type ActionErrorView =
  | { kind: "not_a_model"; model: string }
  | { kind: "licence_not_accepted"; model: string; status: LicenceStatusView }
  | { kind: "busy"; artifact: string }
  | { kind: "check_failed"; detail: string }
  | { kind: "not_eligible"; model: string; gpu: FitView; cpu: FitView }
  | { kind: "damaged"; artifact: string; reason: string }
  | { kind: "download"; artifact: string; cause: DownloadCause; detail: string }
  | { kind: "install"; engineBusy: boolean; detail: string }
  | { kind: "in_use"; model: string; by: InUseView }
  | { kind: "cancelled" }
  | { kind: "store"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "running"; model: string }
  | { kind: "prepare"; memory: boolean; engineBusy: boolean; detail: string };

export type StepView = "checking" | "downloading" | "verifying" | "installing" | "preparing";

export type EventView =
  | { kind: "step"; model: string; artifact: string; runtime: boolean; step: StepView }
  | { kind: "progress"; model: string; artifact: string; runtime: boolean; done: number; total: number }
  | { kind: "finished"; model: string; artifact: string; runtime: boolean; state: StateView }
  | { kind: "failed"; model: string; artifact: string; runtime: boolean; state: StateView; error: ActionErrorView };

export type VerifiedView = "intact" | "mismatch" | "nothing";

export interface TermsView {
  revision: string;
  documents: { title: string; source: string; text: string }[];
}

export type AcceptErrorView =
  | { kind: "not_required" }
  | { kind: "terms_unavailable" }
  | { kind: "not_the_current_terms"; shown: string; current: string }
  | { kind: "store"; detail: string }
  | { kind: "not_a_model"; model: string };

/** The channel every fetch reports on (`model_commands::EVENT`). */
export const MODEL_EVENT = "translation-model";

export const modelsOverview = (): Promise<Overview> => invoke<Overview>("translation_models");

/** Start a fetch; it reports on MODEL_EVENT. Rejects with an ActionErrorView if it could not start. */
export const fetchModel = (model: string, resume: boolean): Promise<void> => invoke<void>("translation_model_fetch", { model, resume });

export const cancelFetch = (model: string): Promise<boolean> => invoke<boolean>("translation_model_cancel", { model });

export const verifyModel = (model: string): Promise<VerifiedView> => invoke<VerifiedView>("translation_model_verify", { model });

/** Resolves with the bytes freed. */
export const removeModel = (model: string): Promise<number> => invoke<number>("translation_model_remove", { model });

export const licenceTerms = (model: string): Promise<TermsView | null> => invoke<TermsView | null>("translation_licence_terms", { model });

export const acceptTerms = (model: string, revision: string): Promise<void> => invoke<void>("translation_accept_terms", { model, revision });

export const onModelEvent = (handler: (e: EventView) => void): Promise<UnlistenFn> =>
  listen<EventView>(MODEL_EVENT, (msg) => handler(msg.payload));
