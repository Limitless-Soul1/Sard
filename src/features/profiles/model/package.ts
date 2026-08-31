// THE PACKAGE — what leaves Sard when a profile is shared, and what is let back in.
//
// A package is one file the reader sends however they like. No account, no server, no gallery. This
// module is the whole of the format's TRUST BOUNDARY, and it is deliberately PURE: no IPC, no
// filesystem, no stores. A validator that cannot be called in a unit test is a validator nobody
// proves, and this one is the only thing standing between a file from a stranger and the reader's
// settings.
//
// WHAT IT REFUSES AND WHY. `parseProfileData` is already total — it never throws and defaults every
// absent field — so a hostile blob cannot crash the reader. That is not enough on its own: total
// parsing turns nonsense into a PLAUSIBLE profile, and silently accepting a file that says it was
// written by a newer Sard, or that carries a reading-layout field it has no business carrying, would
// be importing something nobody inspected. So this refuses in words before parsing forgives.
//
// ASSETS TRAVEL, AND THEIR CLAIMS ARE ONLY CLAIMS. A package carries the pictures and faces a
// profile is made of, and the manifest lists them so the preview can say what is arriving. This
// module reads that list; it does not believe it. The archive holds the bytes, and Rust checks the
// two agree before anything is unpacked — so a manifest that lies costs a row in a list, never a
// file on disk.

import { PROFILE_DATA_VERSION, parseProfileData, type Profile, type ProfileData } from "./profile";

/** The format's own version, independent of `ProfileData`'s. Bumped only on a breaking change. */
export const PACKAGE_VERSION = 2;

/** The one name inside the archive that must exist. */
export const MANIFEST_NAME = "profile.json";

export interface PackageManifest {
  /** The PACKAGE format version — what this validator understands. */
  package: number;
  /** The Sard that wrote it, for a human reading the file. Never trusted for a decision. */
  app: string;
  name: string | null;
  description: string | null;
  author: string | null;
  /** `ProfileData`, verbatim. Validated structurally here, then parsed totally. */
  data: unknown;
  /**
   * What travels beside the settings — the pictures and faces the profile is made of.
   *
   * ABSENT IS LEGAL, and means a settings-only package: version 1 had no such field, and a reader
   * who switched every asset off produces the same thing. A claim here is exactly that — a claim;
   * the archive is what actually holds the bytes, and Rust checks the two agree before believing
   * either.
   */
  assets?: PackageAsset[];
}

/** One asset's claim in the manifest. Mirrors `PlannedAsset`, minus the sender's own file path. */
export interface PackageAsset {
  kind: "background" | "icon" | "font";
  id: string;
  member: string;
  name: string;
  bytes: number;
  family?: string | null;
  surfaces?: string[];
}

/**
 * Everything the reader's own layout owns. A package may not carry any of it, and a package that
 * tries is refused rather than quietly stripped — silently dropping a field is how a sender comes to
 * believe they sent something they did not.
 */
const FORBIDDEN_DATA_KEYS = [
  "lineHeight", "pageWidth", "measure", "margin", "margins", "marginPx", "paragraphSpacing",
  "tracking", "letterSpacing", "align", "textAlign", "diacritics", "zoom", "fontWeight",
  "firstLineIndent", "flowMode", "reading_style", "book_style",
] as const;

export type Refusal =
  | { code: "pkg.err.unreadable" }
  | { code: "pkg.err.notSard" }
  | { code: "pkg.err.newer"; found: number }
  | { code: "pkg.err.noData" }
  | { code: "pkg.err.carriesReadingSettings"; field: string }
  | { code: "pkg.err.tooLarge"; bytes: number };

export type Inspection =
  | { ok: true; manifest: PackageManifest; data: ProfileData }
  | { ok: false; refusal: Refusal };

/** A manifest larger than this is not a profile. 1 MiB is ~40x the largest plausible one. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Serialise a profile into the manifest that goes in the archive. */
export function serialiseProfile(
  p: Profile,
  appVersion: string,
  /** What the reader chose to include. Omitted = a settings-only package. */
  assets: PackageAsset[] = [],
): PackageManifest {
  return {
    package: PACKAGE_VERSION,
    app: appVersion,
    name: p.name,
    description: p.description,
    // The sender's own name travels; the RECIPIENT's copy is theirs to rename, and `derived_from`
    // is deliberately not sent — provenance is local, and a stranger's row id means nothing here.
    author: p.author,
    data: exportable(p.data),
    // Omitted entirely when nothing travels, so a settings-only package stays byte-identical to what
    // version 1 wrote rather than carrying an empty list that says the same thing at more length.
    ...(assets.length ? { assets } : {}),
  };
}

/**
 * A profile's data as it may cross the border — which is everything EXCEPT its typography.
 *
 * THE FIREWALL BELOW IS THE REASON. `forbiddenIn` refuses any package carrying a reading-layout key
 * at any depth, and it names the key rather than stripping it, because a package that claims to
 * reshape how the recipient reads is malformed by definition. A profile may now hold a typography
 * opinion locally — but shipping it would produce a package Sard itself refuses to import, and
 * shipping it successfully would be worse: importing a stranger's look would change how you read.
 *
 * So the measure stays HOME. The whole `reading` object is omitted rather than emptied, because the
 * firewall matches on key NAMES: a `reading: { lineHeight: null }` would trip it exactly as a real
 * value would. Absent is read back as "no opinion" by `parseTypography`, which is the same thing
 * every profile written before typography existed already says.
 */
function exportable(d: ProfileData): ProfileData {
  const { reading: _local, ...type } = d.type;
  return { ...d, type: type as ProfileData["type"] };
}

export const manifestText = (m: PackageManifest): string => JSON.stringify(m, null, 2);

/**
 * Read a manifest and decide whether it may enter. Pure and total: every path returns, nothing
 * throws, and the refusal says which rule was broken so the UI can name it in the reader's language.
 */
export function inspectPackage(text: string): Inspection {
  if (text.length > MAX_MANIFEST_BYTES) {
    return { ok: false, refusal: { code: "pkg.err.tooLarge", bytes: text.length } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, refusal: { code: "pkg.err.unreadable" } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, refusal: { code: "pkg.err.unreadable" } };
  }
  const o = raw as Record<string, unknown>;

  // A file that does not claim to be a Sard profile is not one. Checked before the version, so a
  // random JSON document is refused as foreign rather than as "from a newer Sard".
  if (typeof o.package !== "number" || !Number.isFinite(o.package)) {
    return { ok: false, refusal: { code: "pkg.err.notSard" } };
  }
  // NEWER IS REFUSED, OLDER IS NOT. A package from a future Sard may carry meaning this version
  // cannot see, and importing it would silently discard it. An older one is safe by construction —
  // absence is how every field of `ProfileData` spells "the default".
  if (o.package > PACKAGE_VERSION) {
    return { ok: false, refusal: { code: "pkg.err.newer", found: o.package } };
  }
  if (!o.data || typeof o.data !== "object" || Array.isArray(o.data)) {
    return { ok: false, refusal: { code: "pkg.err.noData" } };
  }

  // THE FIREWALL, ENFORCED AT THE BORDER. A profile never carries the reader's layout, so a package
  // claiming to is malformed by definition — refused by name rather than stripped in silence.
  const found = forbiddenIn(o.data);
  if (found) {
    return { ok: false, refusal: { code: "pkg.err.carriesReadingSettings", field: found } };
  }

  return {
    ok: true,
    manifest: {
      package: o.package,
      app: typeof o.app === "string" ? o.app : "",
      name: typeof o.name === "string" && o.name.trim() ? o.name : null,
      description: typeof o.description === "string" ? o.description : null,
      author: typeof o.author === "string" ? o.author : null,
      data: o.data,
      // The asset CLAIMS, kept only where they are shaped like claims. This list is a stranger's
      // text: it says what the archive is supposed to hold, and the preview reads it so the reader
      // can see what is arriving. Rust checks the claims against the archive before believing any of
      // them, so a lie here costs a row in a list, never an unpacked file.
      assets: Array.isArray(o.assets) ? o.assets.filter(isAssetClaim) : undefined,
    },
    // Total by construction: whatever survived the rules above is defaulted field by field.
    data: parseProfileData(JSON.stringify(o.data)),
  };
}

/** Any forbidden key, at any depth. Returns the first one found, for a message that names it. */
function forbiddenIn(v: unknown, depth = 0): string | null {
  if (depth > 8 || !v || typeof v !== "object") return null;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    if ((FORBIDDEN_DATA_KEYS as readonly string[]).includes(k)) return k;
    const deeper = forbiddenIn(child, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/** A claim shaped like a claim. Anything else in the list is dropped rather than drawn. */
function isAssetClaim(v: unknown): v is PackageAsset {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    (a.kind === "background" || a.kind === "icon" || a.kind === "font") &&
    typeof a.member === "string" &&
    typeof a.name === "string" &&
    typeof a.bytes === "number" &&
    Number.isFinite(a.bytes)
  );
}

/**
 * What the reader sees before deciding: the preview's own summary of the package.
 *
 * `PROFILE_DATA_VERSION` is reported rather than enforced — a data version this build does not know
 * is still importable, because absence-defaulting means the unknown parts simply do not apply.
 */
export function summarise(i: Extract<Inspection, { ok: true }>): {
  name: string | null;
  author: string | null;
  themeBase: string | null;
  arabic: string;
  latin: string;
  texture: string;
  dataVersion: number;
  knownDataVersion: boolean;
} {
  return {
    name: i.manifest.name,
    author: i.manifest.author,
    themeBase: i.data.theme.library.base,
    arabic: i.data.type.arabic,
    latin: i.data.type.latin,
    texture: i.data.texture,
    dataVersion: i.data.v,
    knownDataVersion: i.data.v <= PROFILE_DATA_VERSION,
  };
}
