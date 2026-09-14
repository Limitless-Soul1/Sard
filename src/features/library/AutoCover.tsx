
import { CHROME, displayFace, scriptOf } from "../../lib/typography";
// Auto-generated cover for books with no embedded cover (band E · E8). A deterministic
// colour is drawn from the title (so a book always regenerates the same cover); title &
// author are set in the Sard type system — Literata for Latin, Amiri for Arabic — with
// script-aware line breaking. Diacritics are preserved (the title renders verbatim). A
// small س / S marks an auto cover. Colours are literal cover paints (not theme tokens):
// a generated jacket is the book's own object, not app chrome.

const PALETTE = [
  { bg: "#2C3A42", ink: "#EFE3CC" },
  { bg: "#B5727B", ink: "#FBEEE8" },
  { bg: "#2E5A55", ink: "#EAE0C9" },
  { bg: "#16140F", ink: "#C98A5E" },
  { bg: "#9C5A3C", ink: "#F6EAD7" },
  { bg: "#5E6B49", ink: "#F1EAD6" },
  { bg: "#3E4C45", ink: "#F1EAD6" },
  { bg: "#7A4B2E", ink: "#F1EAD6" },
  { bg: "#F1E4C8", ink: "#7A4B2E" },
  { bg: "#D8C29A", ink: "#4A3B2A" },
] as const;


function hashIndex(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** rgba() from a #RRGGBB paint + alpha — for the faint mark / author tint. */
function tint(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function titleSize(len: number, arabic: boolean): number {
  if (arabic) return len <= 6 ? 30 : len <= 12 ? 25 : len <= 20 ? 20 : 16;
  return len <= 8 ? 29 : len <= 16 ? 23 : len <= 26 ? 18 : 15;
}

/**
 * The paints this title resolves to — the SAME deterministic choice the component draws with.
 *
 * Exported so surfaces that show a book as something other than a full cover (the Spines
 * view's spine, the Details row's thumbnail) can carry the book's own colour instead of
 * inventing a second palette that would drift from this one.
 */
export function autoCoverPaint(title: string): { bg: string; ink: string } {
  return PALETTE[hashIndex(title, PALETTE.length)];
}

interface Props {
  title: string;
  author?: string | null;
  /** Book direction hint; falls back to script detection on the title. */
  dir?: string | null;
  /** "mini" = the bare colour chip used as a list thumbnail. */
  variant?: "full" | "mini";
}

export function AutoCover({ title, author, dir, variant = "full" }: Props) {
  // The TITLE's own script, not the book's direction: a Latin title on an Arabic book is still
  // Latin, and setting it in Amiri is how the same string came out in two faces across formats.
  const arabic = scriptOf(title, dir) === "arabic";
  const c = PALETTE[hashIndex(title, PALETTE.length)];

  if (variant === "mini") {
    return <div className="ac-mini" style={{ background: c.bg }} />;
  }

  return (
    <div className="auto-cover" style={{ background: c.bg }} dir={arabic ? "rtl" : "ltr"}>
      <span className="ac-mark" style={{ color: tint(c.ink, 0.3) }}>
        {arabic ? "س" : "S"}
      </span>
      <div
        className="ac-title"
        style={{
          color: c.ink,
          fontFamily: displayFace(arabic),
          fontWeight: arabic ? 700 : 600,
          fontSize: titleSize(title.length, arabic),
        }}
      >
        {title}
      </div>
      {author ? (
        <div
          className="ac-author"
          // The reference sets a typeset cover's author line in the chrome face for BOTH
          // scripts — `font:400 .5rem var(--ui)`. Only the TITLE is art.
          style={{ color: tint(c.ink, 0.82), fontFamily: CHROME }}
        >
          {author}
        </div>
      ) : null}
    </div>
  );
}
