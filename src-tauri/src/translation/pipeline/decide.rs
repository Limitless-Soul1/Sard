//! The decision for one paragraph: which candidates are requested, in which order, which one is accepted, and the
//! status it ends with.

use super::chunk::{quote_units, recovery_spans, splittable};
use super::complete::suspects;
use super::detect::detect;
use super::script::check;
use super::text::{chars, collect, strip, words};
use super::{
    Candidate, ChunkOut, Kind, Outcome, Paragraph, PipelineError, Produced, Profile, Raw, Request, ReviewReason, Sampling, Skip,
    Source, Status, Step,
};
use std::collections::BTreeMap;

/// The reasons that mark a repetition: a second translation carrying one is never selected. A reason belongs to the
/// class when it, or its text after a `chunk N: ` prefix, starts with one of these. (Two of them never match a
/// reason, because those reasons begin with a number; that is the evaluated behaviour and is kept.)
const REPETITION: &[&str] =
    &["collapse", "word repeated", "duplicated", "repeated passages", "one character", "diacritics", "long:", "tokens for", "hit the"];

pub(super) fn is_repetition(reason: &str) -> bool {
    let tail = reason.split_once(": ").map_or(reason, |(_, t)| t);
    REPETITION.iter().any(|p| tail.starts_with(p) || reason.starts_with(p))
}

/// The token budget of a request for a text of `words` words.
pub(super) fn cap(words: usize) -> u32 {
    std::cmp::min(4096, 4 * words + 64) as u32
}

fn judge(src: &str, raw: &Raw, k: f64) -> (Vec<String>, Vec<String>) {
    (detect(src, &raw.out, raw.stop == "limit", raw.tokens.unwrap_or(0), k), check(src, &raw.out))
}

struct Run<'a, S: Source> {
    source: &'a mut S,
    paragraph: &'a Paragraph,
    k: f64,
    limit: u32,
    candidates: BTreeMap<Kind, Candidate>,
    requests: Vec<(Kind, usize)>,
}

impl<S: Source> Run<'_, S> {
    fn ask(&mut self, request: Request) -> Result<Raw, PipelineError<S::Error>> {
        self.requests.push((request.kind, request.index));
        self.source.answer(&request).map_err(|error| PipelineError::Source { kind: request.kind, index: request.index, error })
    }

    fn whole(&mut self, kind: Kind, sampling: Sampling) -> Result<Candidate, PipelineError<S::Error>> {
        let raw = self.ask(Request {
            kind,
            index: 0,
            text: self.paragraph.text.clone(),
            prefill: None,
            sampling,
            limit: self.limit,
        })?;
        let (flags, script) = judge(&self.paragraph.text, &raw, self.k);
        Ok(Candidate::Produced(Produced {
            out: raw.out,
            tokens: raw.tokens,
            stop: raw.stop,
            spans: Vec::new(),
            chunks: Vec::new(),
            units: None,
            flags,
            script,
        }))
    }

    fn chunked(&mut self) -> Result<Candidate, PipelineError<S::Error>> {
        let src = &self.paragraph.text;
        let (spans, ok) = recovery_spans(src, &self.paragraph.sentences).map_err(PipelineError::Input)?;
        if !ok {
            return Ok(Candidate::Skipped(Skip::CoverageFailed));
        }
        if spans.len() < 2 {
            return Ok(Candidate::Skipped(Skip::CannotSplit));
        }
        let para = chars(src);
        let mut chunks: Vec<ChunkOut> = Vec::new();
        for (index, &(a, b)) in spans.iter().enumerate() {
            let (text, prefill) = match chunks.last() {
                None => (collect(&para[a..b]), None),
                Some(prev) => (collect(&para[spans[index - 1].0..b]), Some(prev.raw.out.clone())),
            };
            let raw = self.ask(Request { kind: Kind::Chunked, index, text, prefill, sampling: Sampling::Greedy, limit: self.limit })?;
            chunks.push(ChunkOut { index, src: collect(&para[a..b]), raw });
        }
        let out = chunks.iter().map(|c| strip(&c.raw.out)).collect::<Vec<_>>().join(" ");
        let tokens = chunks.iter().map(|c| c.raw.tokens.unwrap_or(0)).sum::<u64>();
        let stop = if chunks.iter().any(|c| c.raw.stop == "limit") { "limit" } else { "eos" }.to_string();
        let whole = Raw { out: out.clone(), tokens: Some(tokens), stop: stop.clone() };
        let (mut flags, script) = judge(src, &whole, self.k);
        for c in &chunks {
            let chunk_flags = detect(&c.src, &c.raw.out, c.raw.stop == "limit", c.raw.tokens.unwrap_or(0), self.k);
            flags.extend(chunk_flags.into_iter().map(|w| format!("chunk {}: {w}", c.index + 1)));
        }
        Ok(Candidate::Produced(Produced { out, tokens: Some(tokens), stop, spans, chunks, units: None, flags, script }))
    }

    fn sentences(&mut self) -> Result<Candidate, PipelineError<S::Error>> {
        let src = &self.paragraph.text;
        let units = quote_units(src, &self.paragraph.sentences).map_err(PipelineError::Input)?;
        if units.len() < 2 {
            return Ok(Candidate::Skipped(Skip::SingleSentence));
        }
        let limits: Vec<u32> = units.iter().map(|u| cap(words(u))).collect();
        let joined = match self.source.joined_units(&units, &limits) {
            Some(answer) => {
                self.requests.extend((0..units.len()).map(|i| (Kind::Sentences, i)));
                answer.map_err(|error| PipelineError::Source { kind: Kind::Sentences, index: 0, error })?
            }
            None => {
                let mut parts = Vec::new();
                for (index, u) in units.iter().enumerate() {
                    parts.push(self.ask(Request {
                        kind: Kind::Sentences,
                        index,
                        text: u.clone(),
                        prefill: None,
                        sampling: Sampling::Greedy,
                        limit: limits[index],
                    })?);
                }
                Raw {
                    out: parts.iter().map(|p| strip(&p.out)).collect::<Vec<_>>().join(" "),
                    tokens: Some(parts.iter().map(|p| p.tokens.unwrap_or(0)).sum()),
                    stop: if parts.iter().any(|p| p.stop == "limit") { "limit" } else { "eos" }.to_string(),
                }
            }
        };
        let (flags, script) = judge(src, &joined, self.k);
        Ok(Candidate::Produced(Produced {
            out: joined.out,
            tokens: joined.tokens,
            stop: joined.stop,
            spans: Vec::new(),
            chunks: Vec::new(),
            units: Some(units.len()),
            flags,
            script,
        }))
    }

    /// Each candidate is produced at most once per paragraph.
    fn get(&mut self, kind: Kind) -> Result<Candidate, PipelineError<S::Error>> {
        if let Some(c) = self.candidates.get(&kind) {
            return Ok(c.clone());
        }
        let c = match kind {
            Kind::Fast => self.whole(Kind::Fast, Sampling::Greedy)?,
            Kind::Damped => self.whole(Kind::Damped, Sampling::Damped)?,
            Kind::Chunked => self.chunked()?,
            Kind::Sentences => self.sentences()?,
        };
        self.candidates.insert(kind, c.clone());
        Ok(c)
    }
}

/// One candidate alone, through the same code the decision uses (for checking request plans).
#[cfg(test)]
pub(super) fn produce<S: Source>(
    source: &mut S,
    profile: &Profile,
    paragraph: &Paragraph,
    kind: Kind,
) -> Result<Candidate, PipelineError<S::Error>> {
    let limit = cap(words(&paragraph.text));
    let mut run = Run { source, paragraph, k: profile.k, limit, candidates: BTreeMap::new(), requests: Vec::new() };
    run.get(kind)
}

/// Translate one paragraph through the pipeline.
pub fn translate<S: Source>(source: &mut S, profile: &Profile, paragraph: &Paragraph) -> Result<Outcome, PipelineError<S::Error>> {
    let src = &paragraph.text;
    let n = words(src);
    let mut run = Run { source, paragraph, k: profile.k, limit: cap(n), candidates: BTreeMap::new(), requests: Vec::new() };
    let Candidate::Produced(fast) = run.get(Kind::Fast)? else { unreachable!("the first translation is never skipped") };

    let lang_only = fast.flags.is_empty() && !fast.script.is_empty();
    let ladder: Vec<Kind> = if !fast.flags.is_empty() {
        let mut l = if n < 60 { vec![Kind::Damped, Kind::Chunked] } else { vec![Kind::Chunked, Kind::Damped] };
        l.push(Kind::Sentences);
        l
    } else if lang_only {
        vec![Kind::Chunked]
    } else {
        Vec::new()
    };
    let mut steps = Vec::new();
    let mut accepted = if ladder.is_empty() { Some(Kind::Fast) } else { None };
    for kind in ladder {
        let Candidate::Produced(c) = run.get(kind)? else { continue };
        steps.push(Step::Recovery(kind));
        if c.clean() {
            accepted = Some(kind);
            break;
        }
    }

    let (status, final_kind, d1, why_review) = match accepted {
        None if lang_only => (Status::Review, Some(Kind::Fast), None, Some(ReviewReason::ScriptLeak)),
        None => (Status::Failed, None, None, None),
        Some(acc) => {
            let Some(Candidate::Produced(a)) = run.candidates.get(&acc) else { unreachable!("an accepted candidate exists") };
            let out = a.out.clone();
            if !suspects(src, &out, profile.k).suspect() {
                (if acc == Kind::Fast { Status::Ok } else { Status::Recovered }, Some(acc), Some(false), None)
            } else {
                let mut result = (Status::Review, Some(acc), Some(true), Some(ReviewReason::Incomplete));
                let second = if acc != Kind::Chunked && splittable(src, &paragraph.sentences).map_err(PipelineError::Input)? {
                    Some(Kind::Chunked)
                } else if acc != Kind::Damped {
                    Some(Kind::Damped)
                } else {
                    None
                };
                if let Some(kind) = second {
                    if let Candidate::Produced(s) = run.get(kind)? {
                        steps.push(Step::Second(kind));
                        let repetition = s.flags.iter().any(|w| is_repetition(w));
                        if !suspects(src, &s.out, profile.k).suspect() && !repetition && s.script.is_empty() {
                            result = (Status::Second, Some(kind), Some(true), Some(ReviewReason::Incomplete));
                        }
                    }
                }
                result
            }
        }
    };
    let text = final_kind.map(|k| match &run.candidates[&k] {
        Candidate::Produced(p) => p.out.clone(),
        Candidate::Skipped(_) => unreachable!("a final candidate was produced"),
    });
    Ok(Outcome { status, final_kind, text, steps, d1, why_review, candidates: run.candidates, requests: run.requests })
}
