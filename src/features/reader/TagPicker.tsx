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
import { tagsList, tagCreate, tagDelete, type Tag } from "../../lib/ipc";

export function TagPicker({
  selected,
  onChange,
}: {
  selected: string[]; // tag ids
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const [tags, setTags] = useState<Tag[]>([]);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
  };

  return (
    <div className="tag-picker">
      {tags.length > 0 && (
        <div className="tag-cloud">
          {tags.map((tg) => (
            <span key={tg.id} className={`tag-chip${selectedSet.has(tg.id) ? " on" : ""}`}>
              <button className="tag-chip-name" onClick={() => toggle(tg.id)} title={t("tag.toggle")}>
                {tg.name}
              </button>
              <button className="tag-del" onClick={() => remove(tg.id)} title={t("tag.delete")} aria-label={t("tag.delete")}>×</button>
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
