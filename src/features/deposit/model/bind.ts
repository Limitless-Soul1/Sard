// BINDING AND UNBINDING — the sheaf's whole contract.
//
// The sender binds what they give; nothing else travels. A layer's checkbox takes or releases the
// whole layer at once; a slip's knot releases one mark. Two targets, never confused — which is why
// they are two functions here rather than one with a flag.
//
// Pure: sets in, sets out, no mutation of the argument.
import type { LayerKey, Selection } from "./manifest";

export interface LayerRows {
  highlights: { id: string }[];
  notes: { id: string }[];
  references: { id: string }[];
  replacements: { id: string }[];
}

const clone = (s: Selection): Selection => ({
  highlights: new Set(s.highlights),
  notes: new Set(s.notes),
  references: new Set(s.references),
  replacements: new Set(s.replacements),
});

/** Everything bound — the state a deposit opens in: you release what you would rather not send. */
export const bindAll = (rows: LayerRows): Selection => ({
  highlights: new Set(rows.highlights.map((r) => r.id)),
  notes: new Set(rows.notes.map((r) => r.id)),
  references: new Set(rows.references.map((r) => r.id)),
  replacements: new Set(rows.replacements.map((r) => r.id)),
});

/** A whole layer, taken or released at once. */
export function setLayer(sel: Selection, key: LayerKey, rows: LayerRows, on: boolean): Selection {
  const next = clone(sel);
  next[key] = on ? new Set(rows[key].map((r) => r.id)) : new Set();
  return next;
}

/** One slip's knot. */
export function toggleMark(sel: Selection, key: LayerKey, id: string): Selection {
  const next = clone(sel);
  if (next[key].has(id)) next[key].delete(id);
  else next[key].add(id);
  return next;
}

export type LayerState = "all" | "some" | "none";

export const layerState = (sel: Selection, key: LayerKey, rows: LayerRows): LayerState => {
  const total = rows[key].length;
  const n = sel[key].size;
  if (total === 0 || n === 0) return "none";
  return n >= total ? "all" : "some";
};

export const boundCount = (sel: Selection): number =>
  sel.highlights.size + sel.notes.size + sel.references.size + sel.replacements.size;
