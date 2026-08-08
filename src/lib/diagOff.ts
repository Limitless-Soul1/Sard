// THE RELEASE BUILD'S DIAGNOSTIC MODULES — every one of them, doing nothing.
//
// `vite.config.ts` aliases `lib/diag`, `lib/pdfDiag` and `lib/renderDiag` to THIS file whenever the
// build is not a diagnostic one. The real modules are then never reached by the bundler, so a release
// bundle does not merely leave the instrumentation switched off — it does not contain it. That is the
// difference the 2026-08-07 incident turned on: a build whose diagnostic behaviour is decided at
// RUNTIME can always be mistaken for the other kind, and eventually is.
//
// Why an alias rather than `if (import.meta.env.DEV)` guards at each call site: a guard leaves the
// code, its strings and its imports in the bundle, so `verify-artifact.mjs` could never prove an
// absence — and an unprovable safeguard is a belief, not a control.
//
// TYPE SAFETY IS NOT LOST. `tsc` resolves these specifiers to the REAL modules (tsconfig paths are
// untouched); only the bundler substitutes this file. So the diagnostic modules are still fully
// typechecked, and if a product file starts importing a name this stub does not export, the RELEASE
// BUILD FAILS — Rollup errors on a missing named export. The stub cannot silently drift out of date.
//
// Every function here must stay side-effect-free and total: product code calls them unconditionally.

/* eslint-disable @typescript-eslint/no-unused-vars */

/** The universal no-op. Accepts any arguments so a signature change upstream cannot break a release build. */
const noop = (..._args: unknown[]): void => {};

// ---- lib/diag ---------------------------------------------------------------------------------
export const diagStart = noop;
export const diagAttachDocument = noop;
export const diagNote = noop;
export const diagStop = noop;
export const exportNow = noop;
export const diagArmed = (): boolean => false;
export const diagSave = async (): Promise<string> => "";
export const diagPublishAudio = noop;
export const diagPublishUnits = noop;

// ---- lib/pdfDiag ------------------------------------------------------------------------------
export const stageEnter = noop;
export const stageOk = noop;
export const stageFail = noop;
export const stageUnobservable = noop;
export const pdfDiagReset = noop;
export const pdfAttemptStarted = noop;
export const pdfAttemptActive = (): boolean => false;
// `watchFirstPage` and `probePdfChain` are awaited at their call sites; a resolved promise keeps the
// awaiting code on exactly the path it takes when the observation finds nothing.
export const watchFirstPage = async (..._args: unknown[]): Promise<void> => {};
export const probePdfChain = async (..._args: unknown[]): Promise<void> => {};
export const renderStages = (): string => "";
export const pdfStages = (): unknown[] => [];
export const pdfAttempts = (): unknown[] => [];

// ---- lib/renderDiag ---------------------------------------------------------------------------
export const renderStageEnter = noop;
export const renderStageOk = noop;
export const renderStageFail = noop;
export const renderStageUnobservable = noop;
export const renderStagesText = (): string => "";
export const renderDiagReset = noop;
export const renderDiagSurface = noop;
export const renderDiagNotEpub = noop;
export const renderDiagTheme = noop;
export const renderDiagAdoptDoc = noop;
export const autopsy = (): null => null;
export const renderBlackScreenText = (): string => "";
