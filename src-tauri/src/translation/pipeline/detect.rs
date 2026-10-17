//! The suspicion detector: deterministic, explainable checks of one raw translation against its English source.
//!
//! An output is suspicious when any rule fires; each rule reports a reason, and the reasons are kept in rule order.
//! The texts matter beyond display: the second-translation rule decides by them (see `decide`).
//!
//! Three forms exist, as they were validated:
//! * the base detector (`detect_base`), whose thresholds were set just outside the first model's healthy range;
//! * variant b (`detect_b`): ellipses of two to four periods count as one character for the character-run rule, and
//!   the three length thresholds are scaled by the model's factor `k`;
//! * the pipeline's detector (`detect`): variant b, where "ends mid-sentence" is dropped for a source under 20 words
//!   unless the output is also short.

use super::text::{
    chars, count_letters, is_harakat, is_letter, is_space, last_char, lower, norm, percent0, round3, rstrip, similarity,
    split_after, split_ws, strip, strip_harakat,
};
use std::collections::HashMap;

/// Thresholds, each just outside the healthy development range.
const COLLAPSE_TOP_SHARE: f64 = 0.25;
const COLLAPSE_WORD_RUN: i64 = 4;
const DUP_SENTS: i64 = 1;
const REP8: f64 = 0.15;
const CHAR_RUN: usize = 8;
const HARAKAT_SHARE: f64 = 0.35;
const SHORT_LONG: f64 = 0.66;
const SHORT_MID: f64 = 0.55;
const TOO_LONG: f64 = 1.6;
const TOKENS_PER_WORD: f64 = 5.0;
const LATIN_EN_STOP: usize = 2;
const LATIN_RUN: usize = 8;
const Q_DEFICIT: i64 = 1;
const EXCL_DEFICIT: i64 = 2;

/// English function words, for spotting untranslated English inside the output.
const EN_STOP: &[&str] = &[
    "the", "and", "of", "to", "was", "that", "with", "for", "his", "her", "it", "is", "he", "she", "you", "i", "my", "had",
    "have", "not", "but", "as", "at", "on", "be", "by", "this", "which", "from", "were", "been", "they", "them", "their",
    "there", "would", "could", "will", "an", "or", "we", "me", "him", "so", "if", "all", "what", "when", "no",
];
/// Characters a complete sentence may end on.
const TERMINAL: &[char] = &['.', '!', '?', '\u{061F}', '\u{2026}', '\u{201D}', '\u{2019}', '"', '\u{00BB}', ')', '\''];
/// Characters an output may legitimately end on when the source ends on a closing quote.
const OPEN_OK: &[char] = &['\u{201C}', '\u{00AB}', '\u{2014}', '\u{2013}', '-', ':', ';', ','];

fn is_arabic_letter(c: char) -> bool {
    matches!(c, '\u{0621}'..='\u{063A}' | '\u{0641}'..='\u{064A}' | '\u{0671}'..='\u{06D3}')
}

fn is_latin_letter(c: char) -> bool {
    c.is_ascii_alphabetic() || ('\u{00C0}'..='\u{024F}').contains(&c)
}

/// The output's sentences: split after `. ! ? ؟ …` and on line breaks.
pub fn ar_sents(out: &str) -> Vec<String> {
    split_after(out, &['.', '!', '?', '\u{061F}', '\u{2026}'], &[], true)
}

/// The source's sentences: split after `. ! ? …`, a closing quote right after the terminator included in the break.
pub fn en_sents(src: &str) -> Vec<String> {
    split_after(src, &['.', '!', '?', '\u{2026}'], &['\u{201D}', '\u{2019}', '"'], false)
}

/// How many sentences (normalised, at least 20 letters) nearly repeat an earlier one (similarity ≥ 0.85).
pub fn near_dupes(sents: &[String]) -> i64 {
    let ss: Vec<Vec<char>> = sents
        .iter()
        .map(|s| norm(s))
        .filter(|s| s.chars().filter(|&c| c != ' ').count() >= 20)
        .map(|s| chars(&s))
        .collect();
    let mut n = 0;
    for i in 1..ss.len() {
        if (0..i).any(|j| similarity(&ss[i], &ss[j]) >= 0.85) {
            n += 1;
        }
    }
    n
}

/// The longest run of equal neighbours (1 for a one-element sequence, 0 for an empty one).
pub fn max_run<T: PartialEq>(seq: &[T]) -> usize {
    let mut best = usize::from(!seq.is_empty());
    let mut run = 1;
    for w in seq.windows(2) {
        run = if w[0] == w[1] { run + 1 } else { 1 };
        best = best.max(run);
    }
    best
}

/// The share of tokens inside an 8-token sequence that occurs more than once (0 below 16 tokens).
pub fn repeated_ngram_cover(toks: &[String]) -> f64 {
    const N: usize = 8;
    if toks.len() < 2 * N {
        return 0.0;
    }
    let mut grams: HashMap<&[String], usize> = HashMap::new();
    for i in 0..=toks.len() - N {
        *grams.entry(&toks[i..i + N]).or_insert(0) += 1;
    }
    let mut cov = vec![false; toks.len()];
    for i in 0..=toks.len() - N {
        if grams[&toks[i..i + N]] > 1 {
            cov[i..i + N].iter_mut().for_each(|c| *c = true);
        }
    }
    cov.iter().filter(|&&c| c).count() as f64 / toks.len() as f64
}

/// The longest run of consecutive Latin-script words, and the most English function words in any one run.
pub fn latin_run(out: &str) -> (usize, usize) {
    let (mut best, mut run, mut hits, mut cur) = (0usize, 0usize, 0usize, 0usize);
    for t in split_ws(out) {
        let w: String = t.chars().filter(|&c| super::text::is_word(c) || c == '\'' || c == '\u{2019}' || c == '-').collect();
        if !w.is_empty() && w.chars().any(is_latin_letter) && !w.chars().any(is_arabic_letter) {
            run += 1;
            let lw = lower(&w);
            if EN_STOP.contains(&lw.trim_matches(|c| c == '\'' || c == '\u{2019}')) {
                cur += 1;
            }
        } else {
            if run > best {
                best = run;
            }
            if run > 0 {
                hits = hits.max(cur);
            }
            run = 0;
            cur = 0;
        }
    }
    if run > best {
        best = run;
    }
    hits = hits.max(cur);
    (best, hits)
}

/// Character runs with every run of two to four periods read as one ellipsis (variant b's R1).
pub fn runs_b(text: &str) -> usize {
    let cs = chars(text);
    let mut t: Vec<char> = Vec::with_capacity(cs.len());
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '.' {
            let mut e = i;
            while e < cs.len() && cs[e] == '.' {
                e += 1;
            }
            if (2..=4).contains(&(e - i)) {
                t.push('\u{2026}');
            } else {
                t.extend_from_slice(&cs[i..e]);
            }
            i = e;
        } else {
            t.push(cs[i]);
            i += 1;
        }
    }
    let nonspace: Vec<char> = t.into_iter().filter(|&c| !is_space(c)).collect();
    max_run(&nonspace)
}

/// The measured properties of one output.
#[derive(Debug, Clone, PartialEq)]
pub struct Features {
    pub src_words: usize,
    pub out_words: usize,
    pub src_letters: usize,
    pub out_letters: usize,
    pub r_char: Option<f64>,
    pub en_sents: usize,
    pub ar_sents: usize,
    pub word_run: usize,
    pub src_word_run: usize,
    pub top_word: String,
    pub top_share: f64,
    pub rep8: f64,
    pub src_rep8: f64,
    pub dup_sents: i64,
    pub char_run: usize,
    pub src_char_run: usize,
    pub harakat_share: f64,
    pub latin_run: usize,
    pub latin_en_stop: usize,
    pub limit: bool,
    pub tokens: u64,
    pub src_terminal: bool,
    pub out_terminal: bool,
    pub src_q: usize,
    pub out_q: usize,
}

fn tokens_of(s: &str, lowercase: bool) -> Vec<String> {
    split_ws(s).into_iter().map(|t| if lowercase { lower(&norm(t)) } else { norm(t) }).filter(|t| !t.is_empty()).collect()
}

fn top(toks: &[String]) -> (String, usize) {
    let mut order: Vec<&String> = Vec::new();
    let mut count: HashMap<&String, usize> = HashMap::new();
    for t in toks {
        let e = count.entry(t).or_insert(0);
        if *e == 0 {
            order.push(t);
        }
        *e += 1;
    }
    let mut best: Option<(&String, usize)> = None;
    for t in order {
        let c = count[t];
        if best.is_none_or(|(_, b)| c > b) {
            best = Some((t, c));
        }
    }
    best.map(|(t, c)| (t.clone(), c)).unwrap_or_default()
}

/// The base detector's features.
pub fn features_base(src: &str, out: &str, limit: bool, tokens: u64) -> Features {
    let o_clean = strip_harakat(out);
    let s_letters = count_letters(src);
    let o_letters = count_letters(&o_clean);
    let s_toks = tokens_of(src, true);
    let o_toks = tokens_of(out, false);
    let (top_word, top_n) = top(&o_toks);
    let nonspace = |s: &str| s.chars().filter(|&c| !is_space(c)).collect::<Vec<char>>();
    let ar_letters = o_clean.chars().filter(|&c| is_arabic_letter(c)).count();
    let (lr, lr_hits) = latin_run(out);
    let tail = if strip(out).is_empty() { None } else { last_char(out) };
    Features {
        src_words: split_ws(src).len(),
        out_words: split_ws(out).len(),
        src_letters: s_letters,
        out_letters: o_letters,
        r_char: (s_letters > 0).then(|| round3(o_letters as f64 / s_letters as f64)),
        en_sents: en_sents(src).len(),
        ar_sents: ar_sents(out).len(),
        word_run: max_run(&o_toks),
        src_word_run: max_run(&s_toks),
        top_word,
        top_share: if o_toks.is_empty() { 0.0 } else { round3(top_n as f64 / o_toks.len() as f64) },
        rep8: round3(repeated_ngram_cover(&o_toks)),
        src_rep8: round3(repeated_ngram_cover(&s_toks)),
        dup_sents: near_dupes(&ar_sents(out)) - near_dupes(&en_sents(src)),
        char_run: max_run(&nonspace(out)),
        src_char_run: max_run(&nonspace(src)),
        harakat_share: if ar_letters > 0 {
            round3(out.chars().filter(|&c| is_harakat(c)).count() as f64 / ar_letters as f64)
        } else {
            0.0
        },
        latin_run: lr,
        latin_en_stop: lr_hits,
        limit,
        tokens,
        src_terminal: last_char(src).is_some_and(|c| TERMINAL.contains(&c)),
        out_terminal: tail.is_none_or(|c| TERMINAL.contains(&c)),
        src_q: src.matches('?').count(),
        out_q: out.matches('?').count() + out.matches('\u{061F}').count(),
    }
}

/// Variant b's features: the base features with R1's character runs.
pub fn features_b(src: &str, out: &str, limit: bool, tokens: u64) -> Features {
    let mut f = features_base(src, out, limit, tokens);
    f.char_run = runs_b(out);
    f.src_char_run = runs_b(src);
    f
}

/// The three length thresholds, as a factor of the first model's (`k` = 1 for it).
#[derive(Debug, Clone, Copy)]
struct Lengths {
    short_long: f64,
    short_mid: f64,
    too_long: f64,
}

fn rules(f: &Features, src: &str, out: &str, tokens: u64, t: Lengths) -> Vec<String> {
    let mut why = Vec::new();
    if f.src_letters > 0 && f.out_letters == 0 {
        why.push("empty output".to_string());
    }
    if f.limit {
        why.push("hit the n_predict limit".to_string());
    }
    if f.out_words >= 40 && f.top_share >= COLLAPSE_TOP_SHARE {
        why.push(format!("collapse: «{}» is {} of the output", f.top_word, percent0(f.top_share)));
    }
    if f.word_run as i64 - f.src_word_run as i64 >= COLLAPSE_WORD_RUN {
        why.push(format!("word repeated {}x in a row", f.word_run));
    }
    if f.dup_sents >= DUP_SENTS {
        why.push(format!("{} duplicated sentence(s)", f.dup_sents));
    }
    if f.rep8 - f.src_rep8 >= REP8 {
        why.push(format!("repeated passages cover {} of the output", percent0(f.rep8)));
    }
    if f.char_run >= CHAR_RUN && f.char_run > f.src_char_run + 3 {
        why.push(format!("one character repeated {}x", f.char_run));
    }
    if f.out_letters >= 100 && f.harakat_share >= HARAKAT_SHARE {
        why.push(format!("diacritics {} of letters", percent0(f.harakat_share)));
    }
    let sw = f.src_words;
    if let Some(r) = f.r_char {
        if (sw >= 60 && r < t.short_long) || ((20..60).contains(&sw) && r < t.short_mid) {
            why.push(format!("short: {} of the expected length", super::text::fixed(r, 2)));
        }
        if sw >= 20 && r > t.too_long {
            why.push(format!("long: {}x the source length", super::text::fixed(r, 2)));
        }
    }
    if sw >= 10 && tokens > 0 && tokens as f64 / sw as f64 > TOKENS_PER_WORD {
        why.push(format!("{tokens} tokens for {sw} source words"));
    }
    if f.latin_en_stop >= LATIN_EN_STOP || f.latin_run >= LATIN_RUN {
        why.push(format!(
            "untranslated Latin-script run ({} words, {} English function words)",
            f.latin_run, f.latin_en_stop
        ));
    }
    if f.src_terminal && !strip(out).is_empty() {
        let last = rstrip(out).chars().next_back().expect("a non-blank output has a last character");
        if !TERMINAL.contains(&last) && !OPEN_OK.contains(&last) && is_letter(last) {
            why.push("ends mid-sentence".to_string());
        }
    }
    if sw >= 20 && f.src_q as i64 - f.out_q as i64 >= Q_DEFICIT {
        why.push(format!("{} source question(s) without a counterpart", f.src_q as i64 - f.out_q as i64));
    }
    let excl = src.matches('!').count() as i64 - out.matches('!').count() as i64;
    if sw >= 20 && excl >= EXCL_DEFICIT {
        why.push(format!("{excl} source exclamation(s) without a counterpart"));
    }
    why
}

/// The base detector (the first model's thresholds, plain character runs). The pipeline uses variant b; the base
/// form is kept for checking against the recordings that carry its verdicts.
#[cfg(test)]
pub fn detect_base(src: &str, out: &str, limit: bool, tokens: u64) -> Vec<String> {
    let f = features_base(src, out, limit, tokens);
    rules(&f, src, out, tokens, Lengths { short_long: SHORT_LONG, short_mid: SHORT_MID, too_long: TOO_LONG })
}

/// Variant b, for a model whose length factor is `k`.
pub fn detect_b(src: &str, out: &str, limit: bool, tokens: u64, k: f64) -> Vec<String> {
    let f = features_b(src, out, limit, tokens);
    rules(&f, src, out, tokens, Lengths { short_long: SHORT_LONG * k, short_mid: SHORT_MID * k, too_long: TOO_LONG * k })
}

/// The pipeline's detector: variant b, then the short-line rule — for a source under 20 words, "ends mid-sentence"
/// counts only when the output is also short (letters ratio below 0.55 × `k`).
pub fn detect(src: &str, out: &str, limit: bool, tokens: u64, k: f64) -> Vec<String> {
    let mut why = detect_b(src, out, limit, tokens, k);
    if why.iter().any(|w| w == "ends mid-sentence") && split_ws(src).len() < 20 {
        let r = features_base(src, out, limit, tokens).r_char;
        if r.is_none_or(|r| r >= SHORT_MID * k) {
            why.retain(|w| w != "ends mid-sentence");
        }
    }
    why
}
