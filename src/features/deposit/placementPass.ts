// PLACING A DEPOSIT'S MARKS IN THIS READER'S COPY.
//
// Runs only when a book is OPEN and only when that book actually has marks waiting — one indexed query
// answers that, and for every book that has never received a deposit the answer is empty and nothing
// else happens.
//
// Two steps, because counting and anchoring need different things:
//
//   1 · COUNT, over the raw documents, whole book, chunked. Decides — by the rules in
//       `model/placement.ts` — whether each mark is `located` in one section, `ambiguous`, `absent` or
//       `unanchorable`. No cfi is minted here.
//   2 · ANCHOR, when a located mark's section renders. The cfi is minted there and only there, because
//       measured over two books a cfi minted in a raw document failed to resolve on 2 of 55 ranges.
//
// The reader sees his marks appear as they reach their chapters. Nothing blocks the open, nothing is
// rewritten that the reader made, and every verdict is final — so this runs once per book and then
// never again.
import { foldChar } from "../../lib/references";
import {
  depositPendingMarks,
  depositPlaceMarks,
  type PendingMark,
  type PlacementVerdict,
} from "../../lib/ipc";
import { countIn, decide, foldText, isTerminal, MIN_NEEDLE, noteFollows, type Verdict } from "./model/placement";

/** What the engine must provide. Kept narrow so the pass can be reasoned about — and tested — alone. */
export interface PlacementEngine {
  sectionForChapterLabel(label: string | null | undefined): number | null;
  placementScan(
    needles: { id: string; needle: string }[],
    fold: (s: string) => string,
    count: (hay: string, needle: string) => number,
  ): Promise<Map<string, { total: number; sole: number | null; perSection: Map<number, number> }>>;
  placementAnchor(
    index: number,
    needle: string,
    foldCh: (c: string) => string,
  ): { status: "placed"; cfi: string } | { status: "notRendered" | "notUnique" | "notFound" };
  onSectionRendered(cb: ((index: number) => void) | null): void;
}

interface Located {
  mark: PendingMark;
  needle: string;
  section: number;
  /** Notes that ride on this highlight — they are placed with it, never searched for. */
  notes: PendingMark[];
}

export interface PassResult {
  scanned: number;
  located: number;
  refused: number;
}

/**
 * One book's placement pass.
 *
 * `onPlaced` lets the caller refresh what is drawn once marks land. `alreadyAt` answers "does this cfi
 * already carry a mark?" — the reader's own annotations are the only ones that can, and a mark that
 * lands on one is `already_yours`: terminal, not written, and the friendliest thing a deposit can say.
 */
export async function runPlacementPass(
  engine: PlacementEngine,
  bookId: string,
  opts: { alreadyAt: (cfi: string) => boolean; onPlaced?: () => void },
): Promise<PassResult> {
  const pending = await depositPendingMarks(bookId).catch(() => [] as PendingMark[]);
  if (!pending.length) return { scanned: 0, located: 0, refused: 0 };

  const highlights = pending.filter((p) => p.kind === "highlight");
  const notes = pending.filter((p) => p.kind === "note");
  const notesFor = new Map<string, PendingMark[]>();
  for (const n of notes) {
    const key = n.of_highlight ?? "";
    if (!notesFor.has(key)) notesFor.set(key, []);
    notesFor.get(key)!.push(n);
  }

  const verdicts: PlacementVerdict[] = [];
  const push = (m: PendingMark, v: Verdict, cfi: string | null = null) =>
    verdicts.push({ kind: m.kind, id: m.id, state: v.state, target_section: v.target_section, cfi });

  // A note with no highlight has nothing to anchor to: its body is the reader's words, and searching
  // for those could only ever find a coincidence.
  for (const n of notes) {
    if (!n.of_highlight) push(n, { state: "unanchorable", target_section: null });
  }

  // ── 1 · count ─────────────────────────────────────────────────────────────────────────────────
  const needles: { id: string; needle: string }[] = [];
  const needleOf = new Map<string, string>();
  const stillPending: PendingMark[] = [];
  for (const h of highlights) {
    if (isTerminal(h.state)) continue;
    const needle = foldText(h.excerpt ?? "");
    if (needle.length < MIN_NEEDLE) {
      // Too little to be evidence. Refused outright rather than let through to a tier where its
      // "uniqueness" would be luck.
      push(h, { state: "unanchorable", target_section: null });
      for (const n of notesFor.get(h.id) ?? []) push(n, { state: "unanchorable", target_section: null });
      continue;
    }
    needleOf.set(h.id, needle);
    needles.push({ id: h.id, needle });
    stillPending.push(h);
  }

  const located: Located[] = [];

  // ALREADY LOCATED ON AN EARLIER OPEN. The section was decided and stored; all that is left is to
  // anchor it when the reader reaches it, so it skips the scan entirely — reopening a book costs
  // nothing it has already paid.
  const resume = stillPending.filter((h) => h.state === "located" && h.target_section !== null);
  for (const h of resume) {
    located.push({
      mark: h,
      needle: needleOf.get(h.id)!,
      section: h.target_section as number,
      notes: notesFor.get(h.id) ?? [],
    });
  }
  const toScan = stillPending.filter((h) => !(h.state === "located" && h.target_section !== null));
  const needlesToScan = needles.filter((n) => toScan.some((h) => h.id === n.id));

  if (needlesToScan.length) {
    const counts = await engine.placementScan(needlesToScan, foldText, (hay, needle) => countIn(hay, needle));
    for (const h of toScan) {
      const needle = needleOf.get(h.id)!;
      const rec = counts.get(h.id) ?? { total: 0, sole: null, perSection: new Map<number, number>() };
      const labelSection = engine.sectionForChapterLabel(h.chapter_label);
      const v = decide(needle, {
        labelled:
          labelSection === null
            ? null
            : { section: labelSection, count: rec.perSection.get(labelSection) ?? 0 },
        whole: { count: rec.total, section: rec.sole },
      });
      if (v.state === "located" && v.target_section !== null) {
        located.push({ mark: h, needle, section: v.target_section, notes: notesFor.get(h.id) ?? [] });
        push(h, v);
        for (const n of notesFor.get(h.id) ?? []) push(n, v);
      } else {
        push(h, v);
        for (const n of notesFor.get(h.id) ?? []) push(n, noteFollows(v));
      }
    }
  }

  if (verdicts.length) await depositPlaceMarks(verdicts).catch(() => 0);

  // ── 2 · anchor, as each section renders ───────────────────────────────────────────────────────
  const waiting = new Map<number, Located[]>();
  for (const l of located) {
    if (!waiting.has(l.section)) waiting.set(l.section, []);
    waiting.get(l.section)!.push(l);
  }

  if (waiting.size) {
    const anchorSection = (index: number) => {
      const here = waiting.get(index);
      if (!here?.length) return;
      waiting.delete(index);
      const out: PlacementVerdict[] = [];
      const stillWaiting: Located[] = [];
      for (const l of here) {
        const res = engine.placementAnchor(index, l.needle, foldChar);
        if (res.status === "notRendered") {
          // THE SECTION IS SIMPLY NOT ON SCREEN YET. Saying anything now would condemn the mark for
          // where the reader happens to be standing rather than for its own text, so it keeps waiting
          // and its turn comes when the section renders.
          stillWaiting.push(l);
          continue;
        }
        if (res.status !== "placed") {
          // The rendered text did not hold the words exactly once after all: refused, never guessed.
          const state = res.status === "notUnique" ? "ambiguous" : "absent";
          out.push({ kind: "highlight", id: l.mark.id, state, target_section: index, cfi: null });
          for (const n of l.notes) out.push({ kind: "note", id: n.id, state, target_section: index, cfi: null });
          continue;
        }
        const cfi = res.cfi;
        if (opts.alreadyAt(cfi)) {
          // You marked this passage too. Nothing is written and nothing is doubled; the deposit's own
          // record keeps the sender's words, and your mark stays exactly as it is.
          out.push({ kind: "highlight", id: l.mark.id, state: "already_yours", target_section: index, cfi: null });
          for (const n of l.notes) out.push({ kind: "note", id: n.id, state: "already_yours", target_section: index, cfi: null });
          continue;
        }
        out.push({ kind: "highlight", id: l.mark.id, state: "placed", target_section: null, cfi });
        // A note tied to a highlight lives where the highlight lives.
        for (const n of l.notes) out.push({ kind: "note", id: n.id, state: "placed", target_section: null, cfi });
      }
      // Anything that has not had its turn yet goes back on the thread.
      if (stillWaiting.length) waiting.set(index, stillWaiting);
      if (out.length) {
        void depositPlaceMarks(out)
          .then(() => opts.onPlaced?.())
          .catch(() => {});
      }
    };

    engine.onSectionRendered((index: number) => anchorSection(index));
    // Sections already on screen never fire the hook again, so they are offered their turn now.
    for (const index of Array.from(waiting.keys())) anchorSection(index);
  }

  return {
    scanned: pending.length,
    located: located.length,
    refused: verdicts.filter((v) => v.state === "ambiguous" || v.state === "absent" || v.state === "unanchorable").length,
  };
}
