// THE ONE PLACE THAT TURNS A BOOK INTO A COVER URL.
//
// WHY THIS EXISTS AS A FUNCTION RATHER THAN AN INLINE CALL. Every consumer used to build its own URL
// with `convertFileSrc(book.cover_path)`, which meant three copies of a rule — and a rule copied
// three times is a rule that drifts. It also meant every consumer knew that covers are FILES, so
// changing where the bytes live would have meant touching all of them.
//
// Delivery is deliberately the one concern still served by the existing asset protocol. Identity
// (a content hash in the filename) and custody (managed files under app-data) are settled; delivery
// could later become a dedicated `sard-cover://` scheme that sets `Cache-Control: immutable` — which
// is provably correct precisely BECAUSE the URL is content-addressed, and which measurement shows we
// do not have today (the asset protocol sends no cache directives at all). That change would happen
// in this function body and nowhere else. That is the whole point of it.
//
// Cache correctness does NOT depend on any of that: the stored filename carries a hash of the bytes,
// so the URL changes if and only if the image changes. There is no cache-busting here, and there
// must never be — a `?v=` suffix would be a workaround for a problem the naming already solves.
import { convertFileSrc } from "@tauri-apps/api/core";

/** The minimum a caller must supply. Deliberately structural, so any row-like shape fits. */
export interface CoverBearing {
  cover_path?: string | null;
}

/**
 * The URL to render this book's cover, or `null` when it has none and the caller should fall back
 * to `AutoCover`.
 *
 * `cover_path` arrives ABSOLUTE: storage is app-data-relative so a profile survives being restored
 * under another user, platform or phone container, and the Rust boundary resolves it on the way out.
 * The frontend therefore never has to know which form the database holds.
 */
export function coverSrc(book: CoverBearing | null | undefined): string | null {
  const p = book?.cover_path;
  if (!p) return null;
  return convertFileSrc(p);
}
