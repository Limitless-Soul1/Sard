//! The two recovery planners: the chunk plan of the chunked retry, and the quotation-aware sentence units of the
//! per-sentence retry. Both work on the paragraph's sentences as exact substrings, by character index.
//!
//! Where a sentence, a part of one, a unit or a chunk cannot be found in the paragraph, planning stops with an
//! `InputError` — at exactly the points the frozen implementation stops. Every other input is planned as it plans it.

use super::text::{chars, collect, find_from, is_lower, rstrip, split_after, strip, words};
use super::InputError;

/// Which planner met the input it could not plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Planner {
    /// The chunk plan (the chunked retry, and the test whether a paragraph can be split).
    Chunks,
    /// The sentence units (the per-sentence retry).
    Units,
}

const TITLES: &[&str] = super::complete::TITLES;

/// Sentences ending on a title abbreviation, or on "etc." before a lowercase start, joined to the next.
pub fn fix_abbrev(sents: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in sents {
        match out.last_mut() {
            Some(prev)
                if TITLES.iter().any(|t| rstrip(prev).ends_with(t))
                    || (rstrip(prev).ends_with("etc.") && s.chars().next().is_some_and(is_lower)) =>
            {
                prev.push(' ');
                prev.push_str(s);
            }
            _ => out.push(s.clone()),
        }
    }
    out
}

/// The joined sentences rebuilt as exact substrings of the paragraph: each from its first space-separated part to the
/// end of its last, located in order.
fn exact_sentences(para: &[char], sents: &[String], planner: Planner) -> Result<Vec<Vec<char>>, InputError> {
    let mut exact = Vec::new();
    let mut pos = 0;
    for (index, m) in fix_abbrev(sents).iter().enumerate() {
        let parts: Vec<Vec<char>> = m.split(' ').filter(|x| !x.is_empty()).map(chars).collect();
        let Some(first) = parts.first() else {
            return Err(InputError::EmptySentence { planner, index });
        };
        let a = find_from(para, first, pos).ok_or(InputError::Unlocatable { planner, what: "sentence", index })?;
        let mut b = a;
        for x in &parts {
            b = find_from(para, x, b).ok_or(InputError::Unlocatable { planner, what: "sentence", index })? + x.len();
        }
        exact.push(para[a..b].to_vec());
        pos = b;
    }
    Ok(exact)
}

/// The sentences as exact substrings, after the abbreviation rule.
pub fn sentence_units(src: &str, sents: &[String]) -> Result<Vec<String>, InputError> {
    Ok(exact_sentences(&chars(src), sents, Planner::Units)?.iter().map(|u| collect(u)).collect())
}

fn quote_depths(units: &[String]) -> Vec<i64> {
    let mut d = 0i64;
    units
        .iter()
        .map(|u| {
            d += u.matches('\u{201C}').count() as i64 - u.matches('\u{201D}').count() as i64;
            d
        })
        .collect()
}

/// Units outside a quotation: boundary `j` is outside when the depth there is no higher than anywhere after it (a
/// quotation running on into the next paragraph never blocks a boundary).
fn outside(depth: &[i64]) -> Vec<bool> {
    (0..depth.len()).map(|j| depth[j] <= *depth[j..].iter().min().expect("a non-empty tail")).collect()
}

/// The sentence units grouped so that no boundary falls inside a quotation that closes later in the paragraph.
pub fn quote_units(src: &str, sents: &[String]) -> Result<Vec<String>, InputError> {
    let para = chars(src);
    let units = sentence_units(src, sents)?;
    let mut locs = Vec::new();
    let mut pos = 0;
    for (index, u) in units.iter().enumerate() {
        let uc = chars(u);
        let a = find_from(&para, &uc, pos).ok_or(InputError::Unlocatable { planner: Planner::Units, what: "unit", index })?;
        locs.push((a, a + uc.len()));
        pos = a + uc.len();
    }
    let depth = quote_depths(&units);
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for j in 0..units.len() {
        let s = *start.get_or_insert(locs[j].0);
        if depth[j] <= *depth[j..].iter().min().expect("a non-empty tail") {
            spans.push(collect(&para[s..locs[j].1]));
            start = None;
        }
    }
    if let Some(s) = start {
        spans.push(collect(&para[s..locs.last().expect("units exist").1]));
    }
    Ok(spans)
}

/// A sentence longer than the hard limit, split after `; : —` and re-joined while the pieces stay within it.
pub fn split_long_sentence(s: &str, hard: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for p in split_after(s, &[';', ':', '\u{2014}'], &[], false) {
        if !cur.is_empty() && words(&cur) + words(&p) > hard {
            out.push(std::mem::replace(&mut cur, p));
        } else {
            cur = strip(&format!("{cur} {p}")).to_string();
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Chunk sizes, in words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sizes {
    /// A paragraph of at most this many words is one chunk.
    pub long: usize,
    /// The size a chunk aims at.
    pub target: usize,
    /// The size a chunk exceeds only when one sentence is longer.
    pub hard: usize,
    /// A last chunk under this size joins the one before it.
    pub tail: usize,
}

fn joined_words(units: &[Vec<char>]) -> usize {
    words(&units.iter().map(|u| collect(u)).collect::<Vec<_>>().join(" "))
}

/// The chunk plan: spans `(start, end)` of the paragraph, in characters.
pub fn plan_spans(para: &[char], sents: &[Vec<char>], z: Sizes) -> Result<Vec<(usize, usize)>, InputError> {
    if words(&collect(para)) <= z.long {
        return Ok(vec![(0, para.len())]);
    }
    let mut units: Vec<Vec<char>> = Vec::new();
    for s in sents {
        let st = collect(s);
        if words(&st) > z.hard {
            units.extend(split_long_sentence(&st, z.hard).iter().map(|x| chars(x)));
        } else {
            units.push(s.clone());
        }
    }
    let unit_strings: Vec<String> = units.iter().map(|u| collect(u)).collect();
    let out = outside(&quote_depths(&unit_strings));
    let reachable = |cur: &[Vec<char>], j: usize| -> bool {
        let mut n = joined_words(cur);
        for m in j..units.len().saturating_sub(1) {
            n += words(&unit_strings[m]);
            if n > z.hard {
                return false;
            }
            if out[m] {
                return true;
            }
        }
        false
    };
    let mut chunks: Vec<Vec<Vec<char>>> = Vec::new();
    let mut cur: Vec<Vec<char>> = Vec::new();
    for (j, u) in units.iter().enumerate() {
        let mut cand = cur.clone();
        cand.push(u.clone());
        if !cur.is_empty() && joined_words(&cand) > z.target && (out[j - 1] || !reachable(&cur, j)) {
            chunks.push(std::mem::replace(&mut cur, vec![u.clone()]));
        } else {
            cur = cand;
        }
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    if chunks.len() > 1 && joined_words(chunks.last().expect("chunks exist")) < z.tail {
        let tail = chunks.pop().expect("chunks exist");
        chunks.last_mut().expect("chunks exist").extend(tail);
    }
    let mut spans = Vec::new();
    let mut cur_pos = 0;
    for (index, c) in chunks.iter().enumerate() {
        let err = InputError::Unlocatable { planner: Planner::Chunks, what: "chunk", index };
        let a = find_from(para, &c[0], cur_pos).ok_or(err.clone())?;
        let mut b = a;
        for u in c {
            b = find_from(para, u, b).ok_or(err.clone())? + u.len();
        }
        spans.push((a, b));
        cur_pos = b;
    }
    Ok(spans)
}

/// The chunked retry's plan for this paragraph, and whether the chunks cover it with only whitespace between them.
pub fn recovery_spans(src: &str, sents: &[String]) -> Result<(Vec<(usize, usize)>, bool), InputError> {
    let para = chars(src);
    let n = words(src);
    let target = 80.min(20.max(n / 2));
    let z = Sizes { long: 0, target, hard: 150, tail: 25.min(target / 2) };
    let exact = exact_sentences(&para, sents, Planner::Chunks)?;
    let spans = plan_spans(&para, &exact, z)?;
    let mut ok = true;
    let mut prev_end = 0;
    for &(a, b) in spans.iter().chain(std::iter::once(&(para.len(), para.len()))) {
        let gap = if a > prev_end { collect(&para[prev_end..a]) } else { String::new() };
        if !strip(&gap).is_empty() {
            ok = false;
        }
        prev_end = b;
    }
    Ok((spans, ok))
}

/// Whether the chunked retry applies: the plan covers the paragraph and has at least two chunks.
pub fn splittable(src: &str, sents: &[String]) -> Result<bool, InputError> {
    let (spans, ok) = recovery_spans(src, sents)?;
    Ok(ok && spans.len() >= 2)
}
