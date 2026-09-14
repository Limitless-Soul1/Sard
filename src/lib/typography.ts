/**
 * THE TYPOGRAPHY ROLES — what each piece of text in Sard is, and therefore which face it wears.
 *
 * The faces are declared once in `global.css` and exposed on `:root`, so they resolve everywhere:
 * inside the library shell, inside a portal on `document.body`, inside the stylesheet, and inside
 * the card that gets rasterised to a PNG.
 *
 *   --ui     IBM Plex Sans + IBM Plex Sans Arabic, joined by `unicode-range`, so ONE family name
 *            covers both scripts. This is the face the reader can replace from Settings.
 *   --book   Literata. Latin only.
 *   --ar     Amiri. Arabic only.
 *
 * ## The rule, taken from the design of record
 *
 * a private design reference — the approved reference `Chrome.tsx` was built
 * from — declares exactly these three and uses them by a rule that holds across all thirty-seven of
 * its per-script pairings:
 *
 *   **ARABIC IS ALWAYS `--ar`.** Amiri is Sard's Arabic voice, at every size, in every view.
 *
 *   **LATIN DEPENDS ON SCALE.** At LABEL scale — a caption, a table row, an author, a shelf name,
 *   the wordmark — Latin is `--ui`. At DISPLAY scale — a cabinet's name, a heading, the lede, the
 *   art on a typeset cover — Latin is `--book`.
 *
 * So `--ar` beside `--ui` is not a mistake, and an earlier pass through this file said it was. It is
 * the reference's own pairing: an Arabic caption in Amiri beside a Latin caption in Plex is what
 * Sard is supposed to look like. `labelFace` and `displayFace` are those two pairings, named.
 *
 * ## What was actually wrong
 *
 * Not the pairing — the DISAGREEMENT about it. The same conceptual text was drawn differently
 * depending on which view happened to draw it:
 *
 *   · a book's title was `--ar`/`--ui` in Covers, Spines, Vista and the Details rows, but the chrome
 *     face for BOTH scripts in Grid, so an Arabic title was Amiri in one format and Plex in another;
 *   · `Inter` — a SELECTABLE READING face belonging to no role — was hard-coded for the author line
 *     on generated jackets and the metadata on quote cards;
 *   · the roles were declared on `.libd-root`, so anything drawn outside that shell could not see
 *     them and reached for a family name instead;
 *   · the wordmark was drawn four ways, two of which set its Arabic half in the chrome sans;
 *   · reading-side text — a search snippet, a highlight, a note — offered Latin the book serif and
 *     Arabic the chrome sans, so an Arabic quotation was the one place Amiri never reached;
 *   · and underneath all of it, eight files each kept their own answer to "is this Arabic", two of
 *     which asked the BOOK's direction before the text's own script.
 *
 * The rule that prevents all of it: a component names a ROLE, never a family.
 * `tests/unit/typographyRoles.test.ts` fails the build if a family name reappears outside the
 * files that declare or offer the faces.
 *
 * ## What this module does NOT decide
 *
 * Weight, size and leading stay with the component. They are composition, not identity, and they
 * legitimately differ — Amiri needs more weight than Plex to hold the same colour on screen, and a
 * spine label is smaller than a sheet heading. The reference varies them freely and so does Sard.
 */

/**
 * WHICH SCRIPT A PIECE OF TEXT IS IN — the question that has to be answered before a face can be.
 *
 * Eight files each kept their own hand-written range and they were not the same range: seven covered
 * Arabic, its supplement and both presentation-form blocks, while the eighth also covered Arabic
 * Extended-A, so the same string was Arabic to one component and Latin to another.
 *
 * The union of the eight would still have been a hand-written range, and it carried a fault all of
 * them shared: it ran to the end of Arabic Presentation Forms-B, whose last code point is U+FEFF —
 * the byte-order mark. A title with a stray BOM was therefore "Arabic", and would have been set in
 * Amiri. Unicode already knows the answer, so it is asked directly. `\p{Script=Arabic}` covers every
 * Arabic block, including any added later, and excludes U+FEFF because a BOM is not a script.
 *
 * `reader-engine/FoliateController.ts` reached the same escape independently, for paragraph
 * direction inside a book. It stays where it is: that is direction, not a face.
 */
export const ARABIC = /\p{Script=Arabic}/u;

export const isArabicText = (s: string | null | undefined): boolean => !!s && ARABIC.test(s);

/**
 * The script of a FIELD, judged from that field.
 *
 * `declaredDir` is the book's own direction, and it is consulted only for text with no strong script
 * of its own — a title that is all digits and punctuation, say. It must never overrule text that
 * plainly states what it is: the copies that tested `dir === "rtl"` FIRST set Latin titles belonging
 * to Arabic books in Amiri, so «Kingdom's Bloodline» was Literata in Grid and Details and Amiri in
 * Covers and Spines. The same string, two faces, decided by a property of the book rather than a
 * property of the string.
 */
export function scriptOf(text: string | null | undefined, declaredDir?: string | null): "arabic" | "latin" {
  if (isArabicText(text)) return "arabic";
  if (text && text.trim()) return "latin"; // strong content of its own; believe it
  return declaredDir === "rtl" ? "arabic" : "latin";
}

/**
 * LABEL SCALE — a caption, a table row, an author, a shelf's name, the wordmark.
 *
 * Arabic takes Amiri; Latin stays in the chrome face, where a book serif would shout.
 */
export const labelFace = (arabic: boolean): string => (arabic ? "var(--ar)" : "var(--ui)");

/**
 * DISPLAY SCALE — a cabinet's name, a heading, the lede, the art on a typeset cover, a quote card.
 *
 * Arabic takes Amiri; Latin takes the Latin book face, because at this size it is being SET rather
 * than labelled. The two book families are unrelated and neither has a `unicode-range` to hand off
 * to the other, so the caller must say which script the text is in — `scriptOf` answers that.
 */
export const displayFace = (arabic: boolean): string => (arabic ? "var(--ar)" : "var(--book)");

/** The face for text at label scale, judged from the text itself. */
export const labelFaceFor = (text: string | null | undefined, dir?: string | null): string =>
  labelFace(scriptOf(text, dir) === "arabic");

/** The face for text at display scale, judged from the text itself. */
export const displayFaceFor = (text: string | null | undefined, dir?: string | null): string =>
  displayFace(scriptOf(text, dir) === "arabic");

/** What the app says: labels, controls, counts, dates — chrome that is not naming anything. */
export const CHROME = "var(--ui)";

/**
 * THE WORDMARK — «Sard · سَرْد», wherever it is drawn.
 *
 * Two halves of one mark, and they must agree in all four places it appears: the library sidebar,
 * the first-run welcome, Settings → About, and the rasterised quote card. The reference sets the
 * Latin half in `--ui` and the Arabic half in `--ar` — label scale, because the mark is a name and
 * not a heading. Welcome and About had drifted to Literata and the chrome sans.
 */
export const BRAND_LATIN = "var(--brand)";
export const BRAND_ARABIC = "var(--brand-ar)";
