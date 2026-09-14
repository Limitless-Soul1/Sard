// RAWY-203: pick/add tags for the note being written. Tags are SHARED across all books and unique by
// name — adding a name that exists reuses it. Lives in the note popover (HighlightPopover), matching the
// card's button palette (no new design language). Controlled: the parent holds the selected tag ids and
// persists them (note_tags_set) when the note is saved; this component manages the SELECTION and the
// shared tag list (create / delete). Deleting a tag removes it everywhere but never deletes a note.
//
// RAWY-204 (PART B): tightened to TWO calm rows within the existing palette — a single chip CLOUD of all
// tags (click a chip to apply/unapply it to this note; applied = filled; a quiet ✕ that reveals on hover
// deletes the tag globally) and one add-field whose inline + IS the action (Enter also adds). No toggle
// button, no separate menu, no disconnected "Add" button — adding a tag is one gesture.

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { tagsList, tagCreate, tagDelete, tagRename, type Tag } from "../../lib/ipc";

export function TagPicker({
  selected,
  onChange,
  onTagsChanged,
}: {
  selected: string[]; // tag ids
  onChange: (ids: string[]) => void;
  /**
   * A tag ENTITY changed — renamed or deleted — so anything showing tag NAMES is now stale.
   *
   * Notes and highlights carry names resolved through the join, never stored, so the rows have to be
   * re-read for the change to appear on their cards. `from`/`to` is given for a rename so a filter
   * holding the old name can follow it rather than be dropped.
   */
  onTagsChanged?: (change?: { from: string; to: string }) => void;
}) {
  const { t } = useI18n();
  const [tags, setTags] = useState<Tag[]>([]);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // RENAME, in place on the chip. The tag cloud is where tags already live, so the rename belongs
  // here rather than behind a management screen — the chip becomes a field, Enter confirms, Escape
  // cancels. `renameErr` carries the refusal token so the field can say WHY without a dialog.
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameErr, setRenameErr] = useState<"empty" | "taken" | null>(null);

  useEffect(() => {
    tagsList().then(setTags).catch(console.error);
  }, []);

  const selectedSet = new Set(selected);
  const toggle = (id: string) =>
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const addNew = async () => {
    const name = draft.trim();
    if (!name) return;
    const tag = await tagCreate(name).catch(() => null);
    setDraft("");
    if (!tag) return;
    // Reload the shared list (a new tag, or the reused existing one) and ensure it's selected.
    setTags(await tagsList().catch(() => tags));
    if (!selectedSet.has(tag.id)) onChange([...selected, tag.id]);
    inputRef.current?.focus();
  };

  const remove = async (id: string) => {
    // Deleting a tag only unlinks it (join-row cascade) — notes are never touched (RAWY-203 schema).
    await tagDelete(id).catch(console.error);
    setTags((ts) => ts.filter((x) => x.id !== id));
    if (selectedSet.has(id)) onChange(selected.filter((x) => x !== id));
    onTagsChanged?.();
  };

  const beginRename = (tg: Tag) => { setRenameId(tg.id); setRenameDraft(tg.name); setRenameErr(null); };
  const cancelRename = () => { setRenameId(null); setRenameDraft(""); setRenameErr(null); };
  const commitRename = async (tg: Tag) => {
    const next = renameDraft.trim();
    // An unchanged name is a confirmation, not an edit — close quietly rather than round-tripping.
    if (!next || next === tg.name) { cancelRename(); return; }
    const res = await tagRename(tg.id, next).catch(() => null);
    if (!res || res.status === "empty" || res.status === "taken") {
      // Stay in the field with the reason showing, so the name is not silently lost.
      setRenameErr(res?.status === "taken" ? "taken" : "empty");
      return;
    }
    setTags(await tagsList().catch(() => tags));
    cancelRename();
    onTagsChanged?.({ from: tg.name, to: res.tag?.name ?? next });
  };

  return (
    <div className="tag-picker">
      {tags.length > 0 && (
        <div className="tag-cloud">
          {tags.map((tg) => (
            <span key={tg.id} className={`tag-chip${selectedSet.has(tg.id) ? " on" : ""}${renameId === tg.id ? " renaming" : ""}`}>
              {renameId === tg.id ? (
                <input
                  className={`tag-rename-input${renameErr ? " err" : ""}`}
                  value={renameDraft}
                  autoFocus
                  dir="auto"
                  aria-label={t("tag.rename")}
                  title={renameErr === "taken" ? t("tag.renameTaken") : renameErr === "empty" ? t("tag.renameEmpty") : t("tag.rename")}
                  onChange={(e) => { setRenameDraft(e.target.value); setRenameErr(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void commitRename(tg); }
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelRename(); }
                  }}
                  // Leaving the field is a cancel, not a silent commit: an accidental click elsewhere
                  // must never rename a tag the reader shares with every book.
                  onBlur={cancelRename}
                />
              ) : (
                <>
                  <button className="tag-chip-name" onClick={() => toggle(tg.id)} title={t("tag.toggle")}>
                    {tg.name}
                  </button>
                  <button className="tag-ren" onClick={() => beginRename(tg)} title={t("tag.rename")} aria-label={t("tag.rename")}>✎</button>
                  <button className="tag-del" onClick={() => remove(tg.id)} title={t("tag.delete")} aria-label={t("tag.delete")}>×</button>
                </>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="tag-add">
        <input
          ref={inputRef}
          className="tag-add-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addNew(); } }}
          placeholder={t("tag.new")}
          dir="auto"
        />
        <button className="tag-add-plus" onClick={() => void addNew()} disabled={!draft.trim()} title={t("tag.add")} aria-label={t("tag.add")}>+</button>
      </div>
    </div>
  );
}
