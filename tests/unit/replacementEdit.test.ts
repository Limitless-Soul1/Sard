// EDITING A REPLACEMENT FROM ITS CARD — one record, kept.
//
// THE TRAP. `reps` is UNIQUE on (book_id, phrase_fold), and the fold is derived from the phrase. So
// the store's `save` — which is right for composing a rule from a selection, where the phrase IS the
// identity — cannot express "this same rule, about other words": it would write a row under the new
// key and leave the old one behind, and the reader would find two rules where they had edited one.
//
// `edit` takes the row's ID and answers the three cases the data model actually has. This file
// exercises them against a fake that behaves like the table does — the same unique key, the same
// COALESCE on the place, the same "a new row is born enabled" — because the whole question here is
// what the STORAGE does to identity, and a fake that forgot the unique key would prove nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string; book_id: string; phrase: string; phrase_fold: string; replacement: string;
  word_count: number; enabled: boolean; cfi: string | null; created_at: number | null; updated_at: number | null;
}

let rows: Row[] = [];
let seq = 0;

vi.mock("../../src/lib/ipc", () => ({
  repsForBook: async (bookId: string) => rows.filter((r) => r.book_id === bookId),
  // The real command is an upsert on (book_id, phrase_fold) that COALESCEs the cfi and never
  // touches `enabled`; a row it has to create is born enabled.
  repSave: async (bookId: string, phrase: string, fold: string, replacement: string, wc: number, cfi?: string | null) => {
    const hit = rows.find((r) => r.book_id === bookId && r.phrase_fold === fold);
    if (hit) {
      hit.phrase = phrase; hit.replacement = replacement; hit.word_count = wc;
      hit.cfi = cfi ?? hit.cfi; hit.updated_at = 2;
      return { ...hit };
    }
    const made: Row = {
      id: `id-${++seq}`, book_id: bookId, phrase, phrase_fold: fold, replacement,
      word_count: wc, enabled: true, cfi: cfi ?? null, created_at: 1, updated_at: 1,
    };
    rows.push(made);
    return { ...made };
  },
  repSetEnabled: async (id: string, enabled: boolean) => {
    const hit = rows.find((r) => r.id === id);
    if (!hit) return null;
    hit.enabled = enabled;
    return { ...hit };
  },
  repDelete: async (id: string) => { rows = rows.filter((r) => r.id !== id); return true; },
}));

const { useReplacements } = await import("../../src/features/reader/replacementsStore");

/** What the renderer was last told to substitute — the page's own view of the rules. */
let pushed: { id: string; phrase: string; replacement: string }[] = [];
const ctrl = { setReplacements: (v: typeof pushed) => { pushed = v; } };

const store = () => useReplacements.getState();

beforeEach(async () => {
  rows = []; seq = 0; pushed = [];
  useReplacements.setState({ reps: [], bookId: null, ctrl: null });
  store().bind(ctrl as never, "book-1");
  await store().save("الأوّل", "البديل", "cfi-A");
  await store().save("الثاني", "بديل ثانٍ", "cfi-B");
});

describe("the ordinary edit — the rule keeps its identity", () => {
  it("changing only the replacement updates the row in place", async () => {
    const before = store().reps.find((r) => r.phrase === "الأوّل")!;
    const res = await store().edit(before.id, before.phrase, "بديل مُصحَّح");
    expect(res).toMatchObject({ ok: true });
    expect(store().reps).toHaveLength(2);           // nothing was created
    expect(rows).toHaveLength(2);                   // and nothing was created in storage either
    const after = store().reps.find((r) => r.id === before.id)!;
    expect(after.id).toBe(before.id);               // THE SAME RECORD
    expect(after.book_id).toBe("book-1");           // the scope is untouched
    expect(after.cfi).toBe("cfi-A");                // and so is the place
    expect(after.replacement).toBe("بديل مُصحَّح");
  });

  it("the page is re-told at once, with no reload", async () => {
    const r = store().reps[0];
    pushed = [];
    await store().edit(r.id, r.phrase, "جديد");
    expect(pushed.find((p) => p.id === r.id)?.replacement).toBe("جديد");
  });

  it("an edit does not switch a disabled rule back on", async () => {
    const r = store().reps[0];
    await store().setEnabled(r.id, false);
    await store().edit(r.id, r.phrase, "جديد");
    expect(store().reps.find((x) => x.id === r.id)?.enabled).toBe(false);
    // …and a rule that is off still reaches the page as absence, not as a flag.
    expect(pushed.some((p) => p.id === r.id)).toBe(false);
  });
});

describe("the edit that changes the rule's key", () => {
  it("leaves exactly one rule, carrying the place and the on/off state", async () => {
    const before = store().reps.find((r) => r.phrase === "الأوّل")!;
    await store().setEnabled(before.id, false);
    const res = await store().edit(before.id, "كلمة أخرى", "بديل آخر");
    expect(res).toMatchObject({ ok: true });
    // ONE rule about these words, and the old key is gone — in the store AND in storage.
    expect(store().reps).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.id === before.id)).toBe(false);
    const now = store().reps.find((r) => r.phrase === "كلمة أخرى")!;
    expect(now.book_id).toBe("book-1");             // same book
    expect(now.cfi).toBe("cfi-A");                  // the place travelled with it
    expect(now.enabled).toBe(false);                // and so did "switched off"
  });

  it("refuses to swallow a rule the reader did not open", async () => {
    const first = store().reps.find((r) => r.phrase === "الأوّل")!;
    const second = store().reps.find((r) => r.phrase === "الثاني")!;
    const res = await store().edit(first.id, "الثاني", "شيء آخر");
    expect(res).toMatchObject({ ok: false });
    expect(res && "conflict" in res && res.conflict.id).toBe(second.id);
    // NOTHING was written: both rules stand exactly as they were.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.id)!.phrase).toBe("الأوّل");
    expect(rows.find((r) => r.id === second.id)!.replacement).toBe("بديل ثانٍ");
  });
});

describe("what an edit will not do", () => {
  it("refuses a phrase with nothing to match on", async () => {
    const r = store().reps[0];
    expect(await store().edit(r.id, "   ", "بديل")).toBeNull();
    expect(rows).toHaveLength(2);
  });

  it("answers null for a rule that is no longer there, without creating one", async () => {
    expect(await store().edit("id-gone", "كلمة", "بديل")).toBeNull();
    expect(rows).toHaveLength(2);
  });
});
