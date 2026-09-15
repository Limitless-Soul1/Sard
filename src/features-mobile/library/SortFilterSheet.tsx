// SORT & FILTER — design C4, "one sheet replaces three toolbars".
//
// The desk spends a toolbar on sort, another on the format filter and a third on the view; the phone
// has room for none of them, and the design's answer is one sheet holding all three questions at once,
// with the answer to "how many books will that leave" written on the button that applies it.
//
// WHAT EACH CONTROL IS MADE OF, and none of it is new:
//   * Sort by — `libraryListBooks` sorts in SQL and already knows title, author, date read and date
//     added. PROGRESS is the exception: it is not a `SortKey`, but `fraction` is on every row, so it
//     sorts the list that has already arrived. Sorting real values is not inventing data.
//   * Show — `fraction` says whether a book has been started. "Finished" is NOT offered: Sard has no
//     completion concept (`read_at` is the last-read DATE, not a flag), and the library was until now
//     calling every opened book finished because of exactly that confusion. A filter that cannot be
//     computed is a filter that lies, so the sheet asks a question it can answer.
//   * With notes — `annotationsAll()` is the same cross-book query the marks place reads; a book is in
//     the set when it owns a mark.
//   * Language — `BookRow.language`, sniffed at import. `ListQuery` has no language parameter, so this
//     one also filters the arrived list.
//
// The sheet owns no data and no query. It reports a settled choice and the library runs it.

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";

/** The design's five sort chips. `progress` sorts client-side; the rest are SQL sort keys. */
export type SortChoice = "date_read" | "title" | "author" | "date_added" | "progress";
/** The design draws five; "finished" is absent because Sard cannot compute it — see the note above. */
export type ShowChoice = "all" | "reading" | "unread" | "notes";
export type LangChoice = "any" | "ar" | "en";

export interface Filters {
  sort: SortChoice;
  show: ShowChoice;
  lang: LangChoice;
}

/** What the library starts as, and what Reset returns to: most recently read, everything, any language. */
export const DEFAULT_FILTERS: Filters = { sort: "date_read", show: "all", lang: "any" };

export const filtersAreDefault = (f: Filters): boolean =>
  f.sort === DEFAULT_FILTERS.sort && f.show === DEFAULT_FILTERS.show && f.lang === DEFAULT_FILTERS.lang;

function Group<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onPick: (id: T) => void;
}) {
  return (
    <div className="mf-group">
      <div className="mh-group">{label}</div>
      <div className="mf-opts" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`ml-chip${o.id === value ? " on" : ""}`}
            aria-pressed={o.id === value}
            onClick={() => onPick(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SortFilterSheet({
  value,
  onChange,
  onApply,
  resultCount,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  onApply: () => void;
  /** How many books the CURRENT choice leaves. The design writes it on the button that applies it. */
  resultCount: number;
}) {
  const { t, lang } = useI18n();

  return (
    <>
      <div className="mh-scrim" onClick={onApply} />
      <div
        className="mh-sheet mf-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("lib.sortFilter")}
      >
        <div className="mh-grab" />

        <div className="mf-head">
          <span className="mf-title">{t("lib.sortFilter")}</span>
          {/* Reset is only an offer when there is something to undo. */}
          <button
            type="button"
            className="mf-reset"
            disabled={filtersAreDefault(value)}
            onClick={() => onChange(DEFAULT_FILTERS)}
          >
            {t("lib.reset")}
          </button>
        </div>

        <div className="mf-body">
          <Group
            label={t("lib.sortBy")}
            value={value.sort}
            options={[
              { id: "date_read", label: t("lib.sort.dateRead") },
              { id: "title", label: t("lib.sort.title") },
              { id: "author", label: t("lib.sort.author") },
              { id: "date_added", label: t("lib.sort.dateAdded") },
              { id: "progress", label: t("lib.col.progress") },
            ]}
            onPick={(sort) => onChange({ ...value, sort })}
          />

          <Group
            label={t("lib.show")}
            value={value.show}
            options={[
              { id: "all", label: t("inbox.all") },
              { id: "reading", label: t("lib.show.reading") },
              { id: "unread", label: t("lib.show.unread") },
              { id: "notes", label: t("lib.show.withNotes") },
            ]}
            onPick={(show) => onChange({ ...value, show })}
          />

          <Group
            label={t("lib.language")}
            value={value.lang}
            options={[
              { id: "any", label: t("lib.language.any") },
              { id: "ar", label: "العربية" },
              { id: "en", label: "English" },
            ]}
            onPick={(l) => onChange({ ...value, lang: l })}
          />
        </div>

        {/* The design puts the RESULT on the button: the reader learns what a choice costs before they
            commit to it, which is the whole argument for one sheet instead of three toolbars. */}
        <div className="mf-foot">
          <button type="button" className="mf-apply" onClick={onApply}>
            {t("lib.showBooks").replace("{n}", localeDigits(String(resultCount), lang))}
          </button>
        </div>
      </div>
    </>
  );
}
