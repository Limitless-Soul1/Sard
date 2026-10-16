//! The script check: letters that do not belong in Modern Standard Arabic output, and output that is still English.
//!
//! Model-neutral; applied to every candidate translation of both models. An empty list means the output passes.

use super::text::percent0;

/// Persian and Urdu letters that no correct Arabic output contains.
const PERSIAN: &[char] = &['\u{067E}', '\u{0686}', '\u{0698}', '\u{06AF}', '\u{06A9}', '\u{06CC}', '\u{06C0}'];

/// Letters of other writing systems: Greek, Cyrillic, Hebrew, the Indic scripts, Thai, Hangul jamo, kana, the CJK
/// ideographs and the Hangul syllables.
const OTHER: &[(u32, u32)] = &[
    (0x0370, 0x03FF),
    (0x0400, 0x04FF),
    (0x0590, 0x05FF),
    (0x0900, 0x0DFF),
    (0x0E00, 0x0E7F),
    (0x1100, 0x11FF),
    (0x3040, 0x30FF),
    (0x3400, 0x9FFF),
    (0xAC00, 0xD7AF),
];

fn is_other(c: char) -> bool {
    OTHER.iter().any(|&(lo, hi)| (lo..=hi).contains(&(c as u32)))
}

/// The reasons the output fails the script check, in this order: Persian letters, letters of another script, an
/// output that is still in English.
pub fn check(src: &str, out: &str) -> Vec<String> {
    let mut why = Vec::new();
    let mut persian: Vec<char> = out.chars().filter(|c| PERSIAN.contains(c)).collect();
    if !persian.is_empty() {
        persian.sort_unstable();
        persian.dedup();
        why.push(format!("persian letters: {}", persian.iter().collect::<String>()));
    }
    let mut other: Vec<char> = out.chars().filter(|&c| is_other(c)).collect();
    if !other.is_empty() {
        other.sort_unstable();
        other.dedup();
        why.push(format!("other script: {}", other.iter().take(10).collect::<String>()));
    }
    let latin = out.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let arabic = out.chars().filter(|&c| ('\u{0600}'..='\u{06FF}').contains(&c)).count();
    let share = latin as f64 / std::cmp::max(1, latin + arabic) as f64;
    if latin_words(src) >= 3 && share >= 0.5 {
        why.push(format!("untranslated: {} Latin letters", percent0(share)));
    }
    why
}

/// Runs of two or more ASCII letters.
fn latin_words(src: &str) -> usize {
    let (mut n, mut run) = (0usize, 0usize);
    for c in src.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_alphabetic() {
            run += 1;
        } else {
            if run >= 2 {
                n += 1;
            }
            run = 0;
        }
    }
    n
}
