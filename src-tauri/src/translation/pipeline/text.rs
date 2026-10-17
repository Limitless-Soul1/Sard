//! Text primitives with the exact semantics the translation checks were defined with.
//!
//! The checks were designed and measured as Python code, and their results depend on details where Rust's own
//! defaults differ: what counts as whitespace, a word character or a letter (Rust counts combining marks as word
//! characters, for example, and the Arabic vowel marks as alphabetic; the checks do not), how a string is split and
//! stripped, how lowercase is formed, how a ratio is rounded to three decimals and how it is printed. Everything
//! here reproduces those definitions exactly, from the character tables in `unicode_tables` and from exact decimal
//! arithmetic, so that every reason and every decision is the one the checks were validated with.
//!
//! All indices are character indices, never byte offsets.

use super::unicode_tables as tables;
use std::collections::HashMap;

fn in_ranges(c: char, ranges: &[(u32, u32)]) -> bool {
    let cp = c as u32;
    ranges
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Whitespace, as the checks split, strip and match `\s`.
pub fn is_space(c: char) -> bool {
    in_ranges(c, tables::WHITESPACE)
}

/// A word character (`\w`): a letter or digit in the broad sense, or `_`.
pub fn is_word(c: char) -> bool {
    in_ranges(c, tables::WORD)
}

/// A letter as the checks count letters: a word character that is not a decimal digit and not `_`.
pub fn is_letter(c: char) -> bool {
    in_ranges(c, tables::LETTER)
}

/// A lowercase character.
pub fn is_lower(c: char) -> bool {
    in_ranges(c, tables::LOWERCASE)
}

/// The string's characters.
pub fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

/// Split on runs of whitespace, dropping empty pieces (`str.split()`).
pub fn split_ws(s: &str) -> Vec<&str> {
    s.split(is_space).filter(|p| !p.is_empty()).collect()
}

/// The number of whitespace-separated words.
pub fn words(s: &str) -> usize {
    split_ws(s).len()
}

/// Remove whitespace from both ends.
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// Remove whitespace from the end.
pub fn rstrip(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// The last character after `rstrip`, if any.
pub fn last_char(s: &str) -> Option<char> {
    rstrip(s).chars().next_back()
}

/// Lowercase, with full mappings and the final-sigma rule (`str.lower()`).
pub fn lower(s: &str) -> String {
    let cs = chars(s);
    let mut out = String::with_capacity(s.len());
    for (i, &c) in cs.iter().enumerate() {
        if c == '\u{03A3}' {
            out.push(if final_sigma(&cs, i) { '\u{03C2}' } else { '\u{03C3}' });
            continue;
        }
        match tables::LOWER_MAP.binary_search_by_key(&(c as u32), |&(cp, _)| cp) {
            Ok(k) => out.extend(tables::LOWER_MAP[k].1.iter().map(|&x| char::from_u32(x).expect("a mapped code point"))),
            Err(_) => out.push(c),
        }
    }
    out
}

/// Capital sigma lowercases to final sigma when it follows a cased character (skipping case-ignorable ones) and is
/// not followed by one (skipping case-ignorable ones).
fn final_sigma(cs: &[char], i: usize) -> bool {
    let ignorable = |c: char| in_ranges(c, tables::CASE_IGNORABLE);
    let cased = |c: char| in_ranges(c, tables::CASED_NOT_IGNORABLE);
    let before = cs[..i].iter().rev().find(|&&c| !ignorable(c));
    if !matches!(before, Some(&c) if cased(c)) {
        return false;
    }
    match cs[i + 1..].iter().find(|&&c| !ignorable(c)) {
        None => true,
        Some(&c) => !cased(c),
    }
}

/// `x` rounded to `digits` decimals, half to even on its exact binary value, as a decimal integer and the sign.
fn exact_round(x: f64, digits: u32) -> (bool, u128) {
    assert!(x.is_finite(), "only finite values are rounded");
    let negative = x.is_sign_negative();
    let bits = x.abs().to_bits();
    let exp_bits = ((bits >> 52) & 0x7FF) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (mantissa, exp) = if exp_bits == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp_bits - 1075) };
    let scaled = mantissa as u128 * 10u128.pow(digits);
    let n = if exp >= 0 {
        scaled.checked_shl(exp as u32).filter(|v| v >> (exp as u32) == scaled).expect("value within the formatted range")
    } else {
        let k = (-exp) as u32;
        if k >= 128 {
            0
        } else {
            let q = scaled >> k;
            let r = scaled - (q << k);
            let half = 1u128 << (k - 1);
            if r > half || (r == half && q & 1 == 1) {
                q + 1
            } else {
                q
            }
        }
    };
    (negative, n)
}

/// `format(x, ".{digits}f")`: fixed notation, correctly rounded half to even.
pub fn fixed(x: f64, digits: u32) -> String {
    let (negative, n) = exact_round(x, digits);
    let p = 10u128.pow(digits);
    let sign = if negative { "-" } else { "" };
    if digits == 0 {
        format!("{sign}{n}")
    } else {
        format!("{sign}{}.{:0width$}", n / p, n % p, width = digits as usize)
    }
}

/// `round(x, digits)` for a float: the correctly rounded decimal, read back as the nearest float.
pub fn round_to(x: f64, digits: u32) -> f64 {
    fixed(x, digits).parse::<f64>().expect("a decimal literal")
}

/// `round(x, 3)`.
pub fn round3(x: f64) -> f64 {
    round_to(x, 3)
}

/// `format(x, ".0%")`: the value times 100 (in floating point), with no decimals, and a percent sign.
pub fn percent0(x: f64) -> String {
    format!("{}%", fixed(x * 100.0, 0))
}

/// `round(x)` to an integer, half to even.
pub fn round_int(x: f64) -> i64 {
    x.round_ties_even() as i64
}

/// The characters of `s` with the Arabic short vowels, superscript alef and tatweel removed.
pub fn strip_harakat(s: &str) -> String {
    s.chars().filter(|&c| !is_harakat(c)).collect()
}

/// The Arabic short vowels, the superscript alef and the tatweel.
pub fn is_harakat(c: char) -> bool {
    matches!(c, '\u{064B}'..='\u{0652}' | '\u{0670}' | '\u{0640}')
}

/// The number of letters.
pub fn count_letters(s: &str) -> usize {
    s.chars().filter(|&c| is_letter(c)).count()
}

/// Find `needle` in `hay` at or after `from` (`str.index`), in characters.
pub fn find_from(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return if from <= hay.len() { Some(from) } else { None };
    }
    if needle.len() > hay.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

/// Collect a character slice into a string.
pub fn collect(cs: &[char]) -> String {
    cs.iter().collect()
}

/// Split after a terminator, as `re.split(r"(?<=[T])[Q]?\s+|\n+", s)` does (the second alternative only when
/// `newlines`), keeping only the pieces that are not blank. A closing quote right after the terminator belongs to the
/// separator and is dropped with it.
pub fn split_after(s: &str, terminators: &[char], quotes: &[char], newlines: bool) -> Vec<String> {
    let cs = chars(s);
    let n = cs.len();
    let mut pieces = Vec::new();
    let (mut start, mut p) = (0usize, 0usize);
    while p < n {
        if p > 0 && terminators.contains(&cs[p - 1]) {
            let mut q = p;
            if quotes.contains(&cs[q]) && q + 1 < n && is_space(cs[q + 1]) {
                q += 1;
            }
            if is_space(cs[q]) {
                let mut e = q;
                while e < n && is_space(cs[e]) {
                    e += 1;
                }
                pieces.push(collect(&cs[start..p]));
                start = e;
                p = e;
                continue;
            }
        }
        if newlines && cs[p] == '\n' {
            let mut e = p;
            while e < n && cs[e] == '\n' {
                e += 1;
            }
            pieces.push(collect(&cs[start..p]));
            start = e;
            p = e;
            continue;
        }
        p += 1;
    }
    pieces.push(collect(&cs[start..n]));
    pieces.into_iter().filter(|x| !strip(x).is_empty()).collect()
}

/// A token reduced to its word characters: the vowel marks removed, every run of other characters turned into one
/// space, and the ends stripped.
pub fn norm(s: &str) -> String {
    let mut out = String::new();
    let mut in_gap = false;
    for c in s.chars().filter(|&c| !is_harakat(c)) {
        if is_word(c) {
            out.push(c);
            in_gap = false;
        } else if !in_gap {
            out.push(' ');
            in_gap = true;
        }
    }
    strip(&out).to_string()
}

// The three functions below reimplement difflib.SequenceMatcher from CPython 3.12.0 (Copyright (c) 2001-2023 Python
// Software Foundation; All Rights Reserved), under the Python Software Foundation License Version 2. The licence and
// a summary of the changes made are in NOTICES.txt.

/// The similarity ratio of two sequences, by the longest-matching-block method, with no junk heuristic: twice the
/// number of matched elements over the total length (1.0 for two empty sequences). Blocks are chosen exactly as the
/// reference implementation chooses them — the earliest longest match in `a`, then in `b` — because the ratio, not
/// only its threshold, depends on that choice.
pub fn similarity(a: &[char], b: &[char]) -> f64 {
    let matched: usize = matching_blocks(a, b).iter().map(|&(_, _, k)| k).sum();
    let total = a.len() + b.len();
    if total == 0 {
        1.0
    } else {
        2.0 * matched as f64 / total as f64
    }
}

/// The matching blocks `(i, j, size)` of `a` and `b`, adjacent blocks merged, ending with `(len a, len b, 0)`.
pub fn matching_blocks(a: &[char], b: &[char]) -> Vec<(usize, usize, usize)> {
    let mut b2j: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, &c) in b.iter().enumerate() {
        b2j.entry(c).or_default().push(j);
    }
    let (la, lb) = (a.len(), b.len());
    let mut queue = vec![(0usize, la, 0usize, lb)];
    let mut blocks = Vec::new();
    while let Some((alo, ahi, blo, bhi)) = queue.pop() {
        let (i, j, k) = longest_match(a, b, &b2j, alo, ahi, blo, bhi);
        if k > 0 {
            blocks.push((i, j, k));
            if alo < i && blo < j {
                queue.push((alo, i, blo, j));
            }
            if i + k < ahi && j + k < bhi {
                queue.push((i + k, ahi, j + k, bhi));
            }
        }
    }
    blocks.sort();
    let (mut i1, mut j1, mut k1) = (0usize, 0usize, 0usize);
    let mut merged = Vec::new();
    for (i2, j2, k2) in blocks {
        if i1 + k1 == i2 && j1 + k1 == j2 {
            k1 += k2;
        } else {
            if k1 > 0 {
                merged.push((i1, j1, k1));
            }
            (i1, j1, k1) = (i2, j2, k2);
        }
    }
    if k1 > 0 {
        merged.push((i1, j1, k1));
    }
    merged.push((la, lb, 0));
    merged
}

#[allow(clippy::too_many_arguments)]
fn longest_match(
    a: &[char],
    b: &[char],
    b2j: &HashMap<char, Vec<usize>>,
    alo: usize,
    ahi: usize,
    blo: usize,
    bhi: usize,
) -> (usize, usize, usize) {
    let (mut besti, mut bestj, mut bestsize) = (alo, blo, 0usize);
    let mut j2len: HashMap<usize, usize> = HashMap::new();
    let nothing: Vec<usize> = Vec::new();
    for (i, &c) in a.iter().enumerate().take(ahi).skip(alo) {
        let mut next: HashMap<usize, usize> = HashMap::new();
        for &j in b2j.get(&c).unwrap_or(&nothing) {
            if j < blo {
                continue;
            }
            if j >= bhi {
                break;
            }
            let k = j.checked_sub(1).and_then(|p| j2len.get(&p)).copied().unwrap_or(0) + 1;
            next.insert(j, k);
            if k > bestsize {
                (besti, bestj, bestsize) = (i + 1 - k, j + 1 - k, k);
            }
        }
        j2len = next;
    }
    // Extend by equal neighbours (no element is junk here, so only these two extensions can apply).
    while besti > alo && bestj > blo && a[besti - 1] == b[bestj - 1] {
        (besti, bestj, bestsize) = (besti - 1, bestj - 1, bestsize + 1);
    }
    while besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] == b[bestj + bestsize] {
        bestsize += 1;
    }
    (besti, bestj, bestsize)
}
