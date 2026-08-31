/**
 * ORDERING KEYS — the total order inside a container, as text that sorts itself.
 *
 * A shelf used to be numbered 0..n-1, and every insertion renumbered the whole shelf. Two costs
 * came out of that and both were paid repeatedly: an insert wrote every row, so a refresh landing
 * mid-write could read a half-renumbered shelf; and the index a view drew was a PRE-removal index
 * while the command wanted a POST-removal one, so every release had to be bridged by hand. That
 * bridge is where the off-by-ones lived.
 *
 * A rank is a string compared with ordinary `<`. Any two ranks have room between them, so an
 * insertion writes ONE row and never disturbs a neighbour, and «put it between these two» becomes a
 * value rather than a renumbering.
 *
 * ── THE SHAPE OF A KEY ──────────────────────────────────────────────────────────────────────
 *
 *     marker  integer digits   fraction
 *       5      4C1z0            V
 *       │      └─ base 62, as many digits as the marker says
 *       └─ how many integer digits follow, so a longer number always sorts after a shorter one
 *
 * The first attempt at this had no integer part — a key was a pure fraction, and appending meant
 * bisecting the space left between the last key and 1.0. Correct, and unusable: measured, ten
 * thousand appends drove one key to 1,667 characters, because each append can only ever take half
 * of what remains. Appending is the commonest operation there is, so it is the one that must stay
 * cheap. With an integer part it simply counts: ten thousand appends move a five-digit number and
 * the key stays six characters long.
 *
 * The fraction is what makes room BETWEEN two neighbours that have no whole number between them.
 * It can grow, and that is fine — it only grows when the reader repeatedly drops books into the
 * same gap, and it grows by about one character per six such drops, without limit and without ever
 * needing a renumber. That is the property a float cannot offer: 53 bits of mantissa run out after
 * roughly fifty bisections of one interval and then demand an emergency rewrite of the container.
 *
 * ── WHY LEXICOGRAPHIC ORDER IS NUMERIC ORDER ────────────────────────────────────────────────
 *
 * Every character is ASCII and the digit alphabet is in ASCII order, so a byte comparison, a
 * JavaScript `<`, and SQLite's default TEXT collation cannot disagree. The database, the model and
 * the screen therefore produce the same sequence without anyone re-sorting — which is what lets
 * «what was written» and «what is drawn» be the same thing by construction.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length; // 62
const MAX_INT_DIGITS = BASE - 1; // the marker is one digit, so this is the ceiling

/**
 * Where a container's first book sits.
 *
 * Not zero: a book can be dropped in front of the first one as easily as after the last, and a key
 * of zero would leave nowhere below to put it. Starting in the middle of a four-digit number gives
 * about fourteen million whole numbers in each direction before the fraction has to do any work.
 */
const START = BASE ** 4; // 14,776,336

/** A rank is an ordering key. Compare with `<`; never parse it anywhere but here. */
export type Rank = string;

const digitAt = (s: string, i: number): number => (i < s.length ? DIGITS.indexOf(s[i]) : 0);

// ── the integer part ────────────────────────────────────────────────────────────────────────

function encodeInt(n: number): string {
  if (n < 0) throw new RangeError(`rank integer below zero: ${n}`);
  let digits = "";
  let left = n;
  do {
    digits = DIGITS[left % BASE] + digits;
    left = Math.floor(left / BASE);
  } while (left > 0);
  if (digits.length > MAX_INT_DIGITS) throw new RangeError(`rank integer too large: ${n}`);
  return DIGITS[digits.length] + digits;
}

interface Parts {
  /** The marker and integer digits together, so a key can be rebuilt without re-encoding. */
  head: string;
  int: number;
  frac: string;
}

function parse(rank: Rank): Parts {
  const len = DIGITS.indexOf(rank[0]);
  if (len <= 0 || rank.length < 1 + len) throw new RangeError(`not a rank: ${JSON.stringify(rank)}`);
  const digits = rank.slice(1, 1 + len);
  let n = 0;
  for (const ch of digits) {
    const d = DIGITS.indexOf(ch);
    if (d < 0) throw new RangeError(`not a rank: ${JSON.stringify(rank)}`);
    n = n * BASE + d;
  }
  return { head: rank.slice(0, 1 + len), int: n, frac: rank.slice(1 + len) };
}

// ── the fraction ────────────────────────────────────────────────────────────────────────────

/**
 * A fraction strictly between two fractions, where `""` is zero and `null` is one.
 *
 * Never ends in the digit `0`, so a value has exactly one spelling and two calls with the same
 * bounds always give the same answer. That determinism is what makes a reload show the order the
 * write produced rather than an equivalent-but-different one.
 */
function fracBetween(lower: string, upper: string | null): string {
  let out = "";
  let top = upper;
  for (let i = 0; ; i++) {
    const da = digitAt(lower, i);
    const db = top === null ? BASE : digitAt(top, i);
    if (da === db) {
      out += DIGITS[da];
      continue;
    }
    if (db - da >= 2) {
      // `da + 1` at least, so the last digit is never `0`.
      return out + DIGITS[da + Math.floor((db - da) / 2)];
    }
    // Adjacent digits: nothing fits between them here. Keep the lower one and look in the next
    // place, where the only bound left is the top of the range.
    out += DIGITS[da];
    top = null;
  }
}

// ── the operations everything else uses ─────────────────────────────────────────────────────

/**
 * A rank strictly between `lower` and `upper`.
 *
 * `null` means «no bound»: `between(null, null)` is the first book of an empty container,
 * `between(last, null)` appends, `between(null, first)` puts one in front of everything.
 */
export function between(lower: Rank | null, upper: Rank | null): Rank {
  if (lower === null && upper === null) return encodeInt(START);

  if (upper === null) {
    // Appending: the next whole number is always greater, whatever fraction the last key carries.
    return encodeInt(parse(lower!).int + 1);
  }

  const hi = parse(upper);
  if (lower === null) {
    if (hi.int > 0) return encodeInt(hi.int - 1);
    // Already at the bottom of the whole numbers — go below inside the fraction instead.
    if (hi.frac === "") {
      throw new RangeError("no room below the first rank; the container needs renumbering");
    }
    return hi.head + fracBetween("", hi.frac);
  }

  const lo = parse(lower);
  if (lower >= upper) {
    throw new RangeError(`ranks out of order: ${JSON.stringify(lower)} is not before ${JSON.stringify(upper)}`);
  }

  // Whole numbers to spare: take one and keep the key short.
  if (hi.int - lo.int >= 2) return encodeInt(lo.int + Math.floor((hi.int - lo.int) / 2));

  // Same number, or two adjacent ones. Either way the answer carries the LOWER key's whole part;
  // for adjacent numbers anything above its fraction is also below the higher key.
  return lo.head + fracBetween(lo.frac, hi.int === lo.int ? hi.frac : null);
}

/** The rank for the only book in an empty container. */
export const first = (): Rank => between(null, null);

/** Ranks for a whole container at once, in order — used by the migration and by tests. */
export function spread(count: number): Rank[] {
  const out: Rank[] = [];
  for (let i = 0; i < count; i++) out.push(encodeInt(START + i));
  return out;
}

/** Sort a container by rank. The one comparator; nothing else may order a container. */
export const byRank = <T extends { rank: Rank }>(a: T, b: T): number =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;

/**
 * Where a book lands when it is released in front of `before` — or at the end, when that is null.
 *
 * The moving book is taken out of the reckoning first, which is what makes «move it one place
 * forward» land where the hand let go instead of one short of it. That correction used to be
 * arithmetic on indices; here it is a fact about neighbours, which is the same thing said in a way
 * that cannot be off by one.
 */
export function rankForDrop(
  order: readonly { id: string; rank: Rank }[],
  movingId: string,
  before: string | null,
): Rank {
  const without = order.filter((x) => x.id !== movingId);
  const found = before === null ? -1 : without.findIndex((x) => x.id === before);
  // A target that is no longer there — a list drawn before the last change — means the end of the
  // container rather than a refusal the reader would experience as a dead drop.
  const index = before === null || found < 0 ? without.length : found;
  return between(index > 0 ? without[index - 1].rank : null, index < without.length ? without[index].rank : null);
}

/**
 * Whether a release would leave the arrangement exactly as it is.
 *
 * Asked about NEIGHBOURS rather than indices: a book released in front of the book that already
 * follows it has not moved, and neither has the last book released at the end. Measured, that case
 * wrote a row, changed nothing, and told the reader «وُضع على …» over an unchanged shelf.
 */
export function dropChangesNothing(
  order: readonly { id: string; rank: Rank }[],
  movingId: string,
  fromContainer: string,
  toContainer: string,
  before: string | null,
): boolean {
  if (fromContainer !== toContainer) return false;
  const at = order.findIndex((x) => x.id === movingId);
  if (at < 0) return false;
  if (before === movingId) return true;
  const next = at + 1 < order.length ? order[at + 1].id : null;
  return before === next;
}
