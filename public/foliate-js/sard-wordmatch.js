// SARD'S OWN FILE (not vendored foliate-js code) — the whole-word test for in-book search.
// Listed in VENDOR.txt, LOCAL MODIFICATIONS 15, because a re-vendor of search.js must keep importing it.
//
// WHAT IT IS FOR. Sard's search is a SUBSTRING search: «أودر» finds «أودري», and that is the default and
// stays the default. With "whole word" on, a hit only counts when the query stands as a word of its own,
// so «أودر» finds «أودر» and not «أودري», «أودرت» or «أودرون».
//
// WHY NOT THE ENGINE'S OWN `matchWholeWords`. search.js already carries one: it switches the matcher to
// `Intl.Segmenter` at word granularity. MEASURED against the same 34 cases this file is tested on, it was
// right on 33 and wrong on one that matters here — a word followed by U+200F RIGHT-TO-LEFT MARK, which is
// ordinary in Arabic EPUB text, was not found at all. It also replaces the whole matching algorithm, and
// with it the character-folding contract every existing search result depends on. This file changes
// neither: the SAME matcher runs, with the same collator and the same sensitivity, and its hits are
// filtered. Whole-word mode therefore differs from the default in exactly one way — where a match may
// begin and end — and never in what counts as the same letter.
//
// WHY THE TEST NEEDS THE SECTION'S STRINGS, not the hit's excerpt. The excerpt's `pre`/`post` are built
// from the matched text node alone, so a word split across inline markup (`<em>bob</em>cat`) arrives with
// both sides empty and would read as a word standing on its own. MEASURED: `["bob","cat"]` searching
// «cat» yields pre="" post="". The strings around the hit are the only honest context, and they are what
// the matcher itself searched.

/**
 * A word character — any letter, number or combining mark in ANY script, so Arabic is correct without
 * being special-cased and shaping is never inspected. This is the SAME class `src/lib/references.ts`
 * uses to decide that «Klein» is not inside "Klein's", and a unit test holds the two together. The
 * apostrophes are in it for that reason: they are otherwise punctuation, which would read as a boundary
 * and let a possessive match.
 *
 * Search asks ONE more question of them than the reference rule does — see `isBoundary`: an apostrophe
 * counts as a word character only where it JOINS two, so a quoted word ('cat', 'أودر') is still a word.
 * Everything else in the class behaves identically in both places.
 */
export const SEARCH_WORD_CHAR = /[\p{L}\p{N}\p{M}'’]/u

/** A combining mark: it belongs to the letter before it and can never begin a word. */
const MARK = /\p{M}/u

/** Is this code point (a whole one, surrogate pair included) part of a word? "" is the text's edge. */
export const isWordChar = cp => cp !== '' && SEARCH_WORD_CHAR.test(cp)

/** An apostrophe: a word character only when it JOINS two of them (see `isBoundary`). */
const APOSTROPHE = /['’]/u

/**
 * Step back one code point from (index, offset), through earlier strings; `cp` is "" at the start of
 * the text. A combining mark is NOT skipped here: it hangs off a letter, so that letter is what sits
 * before the hit, and a hit beginning mid-word is exactly what whole-word mode rejects.
 */
const stepBack = (strs, index, offset) => {
    let i = index
    let o = offset
    while (i >= 0) {
        const s = strs[i] ?? ''
        if (o > 0) {
            const lo = s.charCodeAt(o - 1)
            if (lo >= 0xDC00 && lo <= 0xDFFF && o >= 2) {
                const hi = s.charCodeAt(o - 2)
                if (hi >= 0xD800 && hi <= 0xDBFF) return { cp: s.slice(o - 2, o), index: i, offset: o - 2 }
            }
            return { cp: s[o - 1], index: i, offset: o - 1 }
        }
        i--
        o = i >= 0 ? (strs[i] ?? '').length : 0
    }
    return { cp: '', index: -1, offset: 0 }
}

/**
 * Step forward to the first code point at or after (index, offset) that could begin a word; `cp` is ""
 * at the end of the text. Combining marks ARE skipped: a tashkīl mark on the match's last letter (the
 * tanwīn in «أودرٌ») belongs to that word, not to the next one, and the search is diacritic-insensitive,
 * so the mark may fall on either side of the match.
 */
const stepForward = (strs, index, offset) => {
    let i = index
    let o = offset
    while (i < strs.length) {
        const s = strs[i] ?? ''
        if (o < s.length) {
            const cp = String.fromCodePoint(s.codePointAt(o))
            if (MARK.test(cp)) { o += cp.length; continue }
            return { cp, index: i, offset: o + cp.length }
        }
        i++
        o = 0
    }
    return { cp: '', index: strs.length, offset: 0 }
}

/**
 * Is what lies on this side of the hit a boundary?
 *
 * THE APOSTROPHE IS THE ONE CHARACTER THAT DEPENDS ON ITS NEIGHBOUR. It is a word character when it
 * JOINS two of them — "cat's", "don't" — which is what keeps «cat» out of "cat's", the rule
 * `src/lib/references.ts` states for «Klein» and "Klein's". Used as a quotation mark it joins nothing,
 * so 'أودر' and 'cat' are quoted words and the quote is a boundary like any other. Both the ASCII
 * apostrophe and the typographic one (U+2019) behave this way; real prose uses the latter for both jobs,
 * which is exactly why the character alone cannot answer the question.
 */
const isBoundary = (step, strs, index, offset) => {
    const { cp, index: i, offset: o } = step(strs, index, offset)
    if (cp === '') return true
    if (APOSTROPHE.test(cp)) return !isWordChar(step(strs, i, o).cp)
    return !isWordChar(cp)
}

/**
 * Does this hit stand as a whole word? Both sides must be a boundary: the text's edge, or anything that
 * is not a word character — a space of any kind, a line break, Arabic or Latin punctuation, a quotation
 * mark, a bracket, a dash, or a formatting character such as U+200F.
 *
 * `range` is the matcher's own {startIndex, startOffset, endIndex, endOffset} into `strs`, before it is
 * turned into a DOM Range — so this costs a couple of character reads per hit and never rescans anything.
 *
 * KNOWN AND DELIBERATE: the strings are tested exactly as the matcher searched them, joined end to end.
 * Markup between them is not visible here, so in minified XHTML where one block ends and the next begins
 * with no whitespace at all («…cat</p><p>alog…»), those two words are adjacent in the searched text and
 * whole-word mode reads them as one. The substring matcher has always seen that text the same way — it
 * will equally find «catalog» spanning that boundary — so the two modes agree about what the text is.
 */
export function isWholeWordHit(strs, { startIndex, startOffset, endIndex, endOffset }) {
    return isBoundary(stepBack, strs, startIndex, startOffset)
        && isBoundary(stepForward, strs, endIndex, endOffset)
}
