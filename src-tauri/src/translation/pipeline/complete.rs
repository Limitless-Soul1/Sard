//! The completeness check (D1): a length alignment of the English sentences to the Arabic segments, in the manner of
//! Gale and Church, allowing the merges and splits literary Arabic makes. An output is suspicious when the English
//! sentences left without a counterpart hold five or more words.
//!
//! The expected Arabic/English letter ratio is 0.82 for the first model, scaled by the model's factor `k`.

use super::text::{count_letters, rstrip, split_after, split_ws, strip_harakat};
use std::collections::BTreeSet;

/// Title abbreviations: a sentence ending on one continues with the next.
pub const TITLES: &[&str] = &["Mr.", "Mrs.", "Ms.", "Dr.", "St.", "Ste.", "Messrs."];
const RATIO: f64 = 0.82;
const S2: f64 = 0.35;
const DEL_PEN: f64 = 2.0;
const MIN_WORDS: usize = 5;
/// The alignment moves `(English sentences, Arabic segments, penalty)`, in the order they are tried; a deletion
/// (1, 0) is priced by its own rule. Ties keep the earlier move.
const MOVES: &[(usize, usize, f64)] =
    &[(1, 1, 0.0), (2, 1, 3.0), (1, 2, 3.0), (3, 1, 5.25), (1, 3, 5.25), (2, 2, 4.5), (1, 0, f64::NAN), (0, 1, 4.5)];

/// The English sentences: split after `. ! ? …` (a closing quote included in the break), a piece after a title
/// abbreviation joined back to it.
pub fn en_sents(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in split_after(src, &['.', '!', '?', '\u{2026}'], &['\u{201D}', '\u{2019}', '"'], false) {
        match out.last_mut() {
            Some(prev) if TITLES.iter().any(|t| rstrip(prev).ends_with(t)) => {
                prev.push(' ');
                prev.push_str(&s);
            }
            _ => out.push(s),
        }
    }
    out
}

/// The Arabic segments: split after `. ! ? ؟ …` (a closing quote included in the break) and on line breaks.
pub fn ar_segs(out: &str) -> Vec<String> {
    split_after(out, &['.', '!', '?', '\u{061F}', '\u{2026}'], &['\u{201D}', '\u{00BB}', '"'], true)
}

/// Letters, after the vowel marks are removed.
pub fn letters(s: &str) -> usize {
    count_letters(&strip_harakat(s))
}

/// One matched group of the alignment.
#[derive(Debug, Clone, PartialEq)]
pub struct Bead {
    pub en: usize,
    pub ar: usize,
    pub l1: usize,
    pub l2: usize,
    pub deficit: i64,
    pub words: usize,
}

/// The alignment: the English sentences left without a counterpart (with their word counts), and the matched groups.
pub fn align(src: &str, out: &str, c: f64) -> (Vec<(String, usize)>, Vec<Bead>) {
    let e = en_sents(src);
    let a = ar_segs(out);
    let le: Vec<usize> = e.iter().map(|x| letters(x)).collect();
    let la: Vec<usize> = a.iter().map(|x| letters(x)).collect();
    let (n, m) = (e.len(), a.len());
    let mut d = vec![vec![f64::INFINITY; m + 1]; n + 1];
    let mut back: Vec<Vec<Option<(usize, usize, usize, usize)>>> = vec![vec![None; m + 1]; n + 1];
    d[0][0] = 0.0;
    for i in 0..=n {
        for j in 0..=m {
            if d[i][j] == f64::INFINITY {
                continue;
            }
            for &(di, dj, pen) in MOVES {
                let (ii, jj) = (i + di, j + dj);
                if ii > n || jj > m {
                    continue;
                }
                let cost = if di == 0 {
                    pen + 0.01 * la[j..jj].iter().sum::<usize>() as f64
                } else if dj == 0 {
                    DEL_PEN + 0.02 * le[i..ii].iter().sum::<usize>() as f64
                } else {
                    let l1 = le[i..ii].iter().sum::<usize>();
                    let l2 = la[j..jj].iter().sum::<usize>();
                    let z = (l2 as f64 - c * l1 as f64) / ((l1.max(1) as f64 * S2) * 10.0).sqrt();
                    pen + z * z
                };
                if d[i][j] + cost < d[ii][jj] {
                    d[ii][jj] = d[i][j] + cost;
                    back[ii][jj] = Some((i, j, di, dj));
                }
            }
        }
    }
    let (mut i, mut j) = (n, m);
    let mut unmatched: Vec<String> = Vec::new();
    let mut beads = Vec::new();
    while (i, j) != (0, 0) {
        let Some((pi, pj, di, dj)) = back[i][j] else { break };
        if dj == 0 {
            unmatched.extend((pi..i).map(|k| e[k].clone()));
        } else if di > 0 {
            let l1: usize = le[pi..i].iter().sum();
            let l2: usize = la[pj..j].iter().sum();
            beads.push(Bead {
                en: di,
                ar: dj,
                l1,
                l2,
                deficit: super::text::round_int(c * l1 as f64 - l2 as f64),
                words: (pi..i).map(|k| split_ws(&e[k]).len()).sum(),
            });
        }
        (i, j) = (pi, pj);
    }
    beads.reverse();
    let unmatched = unmatched.into_iter().rev().map(|s| {
        let w = split_ws(&s).len();
        (s, w)
    });
    (unmatched.collect(), beads)
}

/// The check's verdict on one output.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// The English sentences without a counterpart, when they hold enough words to count; empty otherwise.
    pub sentences: BTreeSet<String>,
    pub why: Vec<String>,
}

impl Verdict {
    pub fn suspect(&self) -> bool {
        !self.sentences.is_empty()
    }
}

/// D1 for a model whose factor is `k`.
pub fn suspects(src: &str, out: &str, k: f64) -> Verdict {
    let (un, _) = align(src, out, RATIO * k);
    let n: usize = un.iter().map(|(_, w)| w).sum();
    if n >= MIN_WORDS {
        Verdict { sentences: un.into_iter().map(|(s, _)| s).collect(), why: vec![format!("align: {n} source words without a counterpart")] }
    } else {
        Verdict { sentences: BTreeSet::new(), why: Vec::new() }
    }
}
