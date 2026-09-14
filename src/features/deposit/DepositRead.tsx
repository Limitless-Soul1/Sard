// «اقرأ الوديعة» — the deposit as the other reader will meet it.
//
// NOT a list of what was ticked. It is the deposit itself: the inscription first, then each layer set
// as an editorial page. It is rendered from the MANIFEST — the same object `deposit_export` writes
// verbatim — so what the sender reads here is exactly what leaves, not a second picture of it.
//
// It is inert. Reading sends nothing.
import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import type { DepositManifest } from "./model/manifest";
import { markCount } from "./model/manifest";

export function DepositRead({
  manifest,
  onClose,
  eyebrowKey = "dep.readEyebrow",
  footKey = "dep.readFoot",
  letterKey = "dep.letterLabel",
}: {
  manifest: DepositManifest;
  onClose: () => void;
  eyebrowKey?: string;
  footKey?: string;
  letterKey?: string;
}) {
  const { t, lang } = useI18n();
  const m = manifest.marks;
  const n = markCount(manifest);
  return (
    <div className="dep-read" role="dialog" aria-modal="true" aria-label={t("dep.readLabel")}>
      <header className="dep-read-head">
        <span className="dep-eyebrow">{t(eyebrowKey as never)}</span>
        <h2 className="dep-read-title">{manifest.book.title}</h2>
        <span className="dep-note">
          {n ? localeNum(n, lang) : ""} {n ? t("dep.sumLabel") : t("dep.readEmpty")}
        </span>
      </header>

      <div className="dep-read-body">
        {manifest.inscription.text.trim() && (
          <section className="dep-read-letter">
            <span className="dep-label">{t(letterKey as never)}</span>
            <p className="dep-letter-text">{manifest.inscription.text}</p>
            {manifest.inscription.signed && <p className="dep-letter-sign">— {manifest.inscription.signed}</p>}
          </section>
        )}

        {m.highlights.length > 0 && (
          <section className="dep-read-set">
            <h3>{t("dep.layer.theirs.highlights")}</h3>
            {m.highlights.map((h, i) => (
              <blockquote key={i} className="dep-read-exc" data-color={h.color}>
                {h.text}
                {h.chapter_label && <cite>{h.chapter_label}</cite>}
              </blockquote>
            ))}
          </section>
        )}

        {m.notes.length > 0 && (
          <section className="dep-read-set">
            <h3>{t("dep.layer.theirs.notes")}</h3>
            {m.notes.map((nt, i) => (
              <article key={i} className="dep-read-note">
                {nt.title && <h4>{nt.title}</h4>}
                <p>{nt.body}</p>
                {nt.chapter_label && <cite>{nt.chapter_label}</cite>}
              </article>
            ))}
          </section>
        )}

        {m.references.length > 0 && (
          <section className="dep-read-set">
            <h3>{t("dep.layer.theirs.references")}</h3>
            {m.references.map((r, i) => (
              <p key={i} className="dep-read-term">
                <b>{r.phrase}</b>
                <span>{r.note}</span>
              </p>
            ))}
          </section>
        )}

        {m.replacements.length > 0 && (
          <section className="dep-read-set">
            <h3>{t("dep.layer.theirs.replacements")}</h3>
            {m.replacements.map((r, i) => (
              <p key={i} className="dep-read-swap">
                <span>{r.phrase}</span>
                <i aria-hidden>→</i>
                <b>{r.replacement}</b>
              </p>
            ))}
          </section>
        )}

        {n === 0 && !manifest.inscription.text.trim() && <p className="dep-note">{t("dep.readEmpty")}</p>}
      </div>

      <footer className="dep-read-foot">
        <span className="dep-note">{t(footKey as never)}</span>
        <button type="button" className="dep-btn" onClick={onClose}>
          {t("dep.close")}
        </button>
      </footer>
    </div>
  );
}
