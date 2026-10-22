// The reader's contract with the translation backend. Each type mirrors a serde view in
// src-tauri/src/translation/reader.rs, field for field — the backend decides which model is ready, which edition a
// book has, and what each paragraph shows; this side only asks and shows.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Extraction } from "../source/extract";

export interface ReadyModelView {
  id: string;
  /** The GPU it was prepared on. */
  device: string;
}

export interface EditionView {
  id: string;
  model: string;
  paragraphs: number;
  done: number;
  pending: number;
}

export interface ReaderStatus {
  model: ReadyModelView | null;
  edition: EditionView | null;
  translating: boolean;
  translatingOther: boolean;
  supported: boolean;
}

export type ShowView =
  | { kind: "pending" }
  | { kind: "translation"; text: string; review: boolean }
  | { kind: "not_translated" }
  | { kind: "kept_original" };

export interface ParagraphView {
  ordinal: number;
  path: number[];
  tag: string;
  /** The original text, exactly as the edition took it: how the paragraph is recognised on the page. */
  text: string;
  show: ShowView;
}

export type ReaderErrorView =
  | { kind: "no_ready_model" }
  | { kind: "runtime_changed"; detail: string }
  | { kind: "busy" }
  | { kind: "failed"; memory: boolean; engineBusy: boolean; detail: string };

export type EditionEventView =
  | { kind: "progressed"; book: string; edition: string }
  | { kind: "ended"; book: string; edition: string }
  | { kind: "failed"; book: string; edition: string; error: ReaderErrorView };

/** The channel a translation job reports on (`reader::EVENT`). */
export const EDITION_EVENT = "translation-edition";

export const readerStatus = (bookId: string): Promise<ReaderStatus> => invoke<ReaderStatus>("translation_reader_status", { bookId });

/** The book's edition for the ready model: the one it has, or one made from this extraction. Rejects with a
 *  ReaderErrorView. */
export const readerEdition = (bookId: string, extraction: Extraction): Promise<string> => invoke<string>("translation_reader_edition", { bookId, extraction });

/** Start translating; the job's end arrives on EDITION_EVENT. Rejects with a ReaderErrorView. */
export const readerTranslate = (bookId: string, editionId: string, firstSection: number | null): Promise<void> =>
  invoke<void>("translation_reader_translate", { bookId, editionId, firstSection });

export const readerSection = (editionId: string, sectionIndex: number): Promise<ParagraphView[]> =>
  invoke<ParagraphView[]>("translation_reader_section", { editionId, sectionIndex });

export const onEditionEvent = (handler: (e: EditionEventView) => void): Promise<UnlistenFn> =>
  listen<EditionEventView>(EDITION_EVENT, (msg) => handler(msg.payload));
