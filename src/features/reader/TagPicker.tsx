// RAWY-203: pick/add tags for the note being written. Tags are SHARED across all books and unique by
// name — adding a name that exists reuses it. Lives in the note popover (HighlightPopover), matching the
// card's button palette (no new design language). Controlled: the parent holds the selected tag ids and
// persists them (note_tags_set) when the note is saved; this component only manages the SELECTION and the
// shared tag list (create / delete). Deleting a tag removes it everywhere but never deletes a note.

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
  const [open, setOpen] = useState(false);
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

  const selectedTags = tags.filter((x) => selectedSet.has(x.id));

  return (
    <div className="tag-picker">
      <div className="tag-row">
        {selectedTags.map((tg) => (
          <button key={tg.id} className="tag-chip on" onClick={() => toggle(tg.id)} title={t("tag.remove")}>
            {tg.name}
          </button>
        ))}
        <button className="tag-add-btn" onClick={() => setOpen((o) => !o)}>
          {t("tag.button")}
        </button>
      </div>

      {open && (
        <div className="tag-menu">
          {tags.length > 0 && (
            <div className="tag-menu-list">
              {tags.map((tg) => (
                <span key={tg.id} className={`tag-chip${selectedSet.has(tg.id) ? " on" : ""}`}>
                  <button className="tag-chip-name" onClick={() => toggle(tg.id)}>{tg.name}</button>
                  <button className="tag-del" onClick={() => remove(tg.id)} title={t("tag.delete")} aria-label={t("tag.delete")}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="tag-add-row">
            <input
              ref={inputRef}
              className="tag-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addNew(); } }}
              placeholder={t("tag.new")}
              dir="auto"
            />
            <button className="tag-add-confirm" onClick={() => void addNew()} disabled={!draft.trim()}>{t("tag.add")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
