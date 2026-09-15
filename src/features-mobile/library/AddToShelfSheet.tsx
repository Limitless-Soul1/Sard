// ADD TO SHELF — design L3, "multi-select, new shelf inline".
//
// C5's "Add to shelf" row opens this, which is the only entry the design gives it. Shipping the row
// without the sheet would have left a control that leads nowhere, so it lands with the row.
//
// MULTI-SELECT, not a picker that closes on the first tap: a book belongs to as many shelves as it
// belongs to, and the design draws every shelf with a state rather than a list you choose once from.
// Each toggle writes immediately through `collectionAddBook` / `collectionRemoveBook`, both of which
// return the whole list, so the counts beside the names come back from the same call that changed them.
//
// The inline create is the same one C2 carries, for the same reason it is inline there: a reader who
// discovers mid-add that the shelf they want does not exist should not have to leave to make it.

import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import {
  collectionAddBook,
  collectionCreate,
  collectionRemoveBook,
  collectionsList,
  type CollectionRow,
} from "../../lib/ipc";
import { Icon } from "../components/Icon";

const SHELF_NAME_MAX = 60;

export function AddToShelfSheet({
  bookId,
  bookTitle,
  memberOf,
  onClose,
}: {
  bookId: string;
  bookTitle: string;
  /** The shelves this book is already on, so every row opens showing the truth. */
  memberOf: Set<string>;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const [shelves, setShelves] = useState<CollectionRow[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set(memberOf));
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    collectionsList().then((c) => alive && setShelves(c)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const next = on.has(id) ? await collectionRemoveBook(id, bookId) : await collectionAddBook(id, bookId);
      setShelves(next);
      setOn((cur) => {
        const s = new Set(cur);
        if (s.has(id)) s.delete(id);
        else s.add(id);
        return s;
      });
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy("new");
    try {
      setShelves(await collectionCreate(clean));
      setName("");
      setMaking(false);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mh-scrim" onClick={onClose} />
      <div className="mh-sheet mb-sheet" role="dialog" aria-modal="true" aria-label={t("m.book.addToShelf")}>
        <div className="mh-grab" />

        <div className="mb-head">
          <span className="mb-head-title">{t("m.book.addToShelf")}</span>
          <span className="mb-head-sub" dir="auto">
            {bookTitle}
          </span>
        </div>

        <div className="mb-shelves">
          {shelves.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`mb-shelf${on.has(s.id) ? " on" : ""}`}
              aria-pressed={on.has(s.id)}
              disabled={busy === s.id}
              onClick={() => void toggle(s.id)}
            >
              {/* A tick that is present or absent, so the row's state survives a colourless theme. */}
              <span className="mb-shelf-tick" aria-hidden="true">
                {on.has(s.id) ? <Icon name="check" /> : null}
              </span>
              <span className="mb-shelf-name" dir="auto">
                {s.name}
              </span>
              <span className="mb-shelf-count">{localeDigits(String(s.count), lang)}</span>
            </button>
          ))}

          {making ? (
            <form
              className="md-newshelf"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                className="md-newshelf-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("lib.shelf.namePlaceholder")}
                aria-label={t("lib.shelf.namePlaceholder")}
                dir="auto"
                autoFocus
                maxLength={SHELF_NAME_MAX}
              />
              <button type="submit" className="md-newshelf-go" disabled={!name.trim() || busy === "new"}>
                {t("lib.shelf.create")}
              </button>
            </form>
          ) : (
            <button type="button" className="mb-shelf mb-shelf--new" onClick={() => setMaking(true)}>
              <span className="mb-shelf-tick" aria-hidden="true" />
              <span className="mb-shelf-name">{t("lib.newShelf")}</span>
            </button>
          )}
        </div>

        <button type="button" className="mb-continue" onClick={onClose}>
          {t("hl.save")}
        </button>
      </div>
    </>
  );
}
