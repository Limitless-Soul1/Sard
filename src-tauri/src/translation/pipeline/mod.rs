//! The paragraph translation pipeline: one paragraph in, one explained result out.
//!
//! The pipeline is fixed: it is the version whose quality, safety and speed were evaluated, and its behaviour is
//! reproduced here exactly — every rule, threshold, reason text and order — so that the evaluated results carry over.
//! Any change to it is a change to an evaluated system and needs a new evaluation.
//!
//! For one paragraph:
//! 1. **First translation**, with a token budget of `min(4096, 4 × source words + 64)` on every request.
//! 2. **Checks** on it: the suspicion detector (`detect`) and the script check (`script`).
//! 3. **Recovery** when a check fires: a retry with repetition damping, a chunked retry and a per-sentence retry, in an
//!    order set by the paragraph's length; a script-only problem gets the chunked retry alone. The first candidate
//!    that passes both checks is accepted.
//! 4. **Completeness** (`complete`) of the accepted output; when it flags, one second translation is tried and is
//!    taken only if it is complete, free of repetition, and script-clean.
//!
//! Every paragraph ends with a status and its reasons: OK, RECOVERED, SECOND, REVIEW (a translation shown with an
//! unresolved check) or FAILED (no acceptable translation, and no text). Nothing is ever edited by rule.
//!
//! This module is the pure part: it plans requests and judges answers. It makes no request itself — a `Source`
//! answers them — and it keeps no state between paragraphs, so a paragraph interrupted by an error is simply done
//! again from the start.

mod chunk;
mod complete;
mod decide;
mod detect;
mod script;
mod text;
mod unicode_tables;

#[cfg(test)]
mod pipeline_tests;
#[cfg(test)]
mod replay_tests;

pub use chunk::Planner;
pub use decide::translate;

/// The notices of the third-party work this module derives from: the sequence-matching algorithm (Python Software
/// Foundation License Version 2) and the Unicode character data (Unicode License V3). Shipped with the code.
pub const NOTICES: &str = include_str!("NOTICES.txt");

/// One paragraph to translate: its text and its sentences, each an exact substring of the text, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paragraph {
    pub text: String,
    pub sentences: Vec<String>,
}

/// The model's constant: its typical Arabic/English length relative to the first model's (1.0 for that one).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Profile {
    pub k: f64,
}

/// The candidate translations a paragraph can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    /// The first translation.
    Fast,
    /// The retry with repetition damping.
    Damped,
    /// The chunked retry.
    Chunked,
    /// The per-sentence retry.
    Sentences,
}

impl Kind {
    /// The name the evaluation records use.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Fast => "fast",
            Kind::Damped => "A1",
            Kind::Chunked => "B",
            Kind::Sentences => "S",
        }
    }
}

/// How a request decodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sampling {
    /// Greedy.
    Greedy,
    /// Greedy, with the repetition-damping sampler.
    Damped,
}

/// One request the pipeline needs answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub kind: Kind,
    /// The chunk or unit number, from 0 (0 for a whole-paragraph request).
    pub index: usize,
    /// The English text the request translates: the paragraph, a unit, or — for a chunk after the first — the
    /// previous chunk's text through this chunk's end.
    pub text: String,
    /// For a chunk after the first: the previous chunk's raw output, which this request continues. The adapter
    /// applies it only when it is not empty, stripped (and, for the completion route, after one space).
    pub prefill: Option<String>,
    pub sampling: Sampling,
    /// The token budget.
    pub limit: u32,
}

/// One raw answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raw {
    pub out: String,
    /// Tokens generated, when the engine reports them.
    pub tokens: Option<u64>,
    /// Why generation stopped: `eos`, `word`, `limit`, or the engine's own word.
    pub stop: String,
}

/// What answers the pipeline's requests.
pub trait Source {
    type Error;
    /// Answer one request.
    fn answer(&mut self, request: &Request) -> Result<Raw, Self::Error>;
    /// The per-sentence retry's joined output, when the source can only give it whole (a replay of recordings that
    /// keep only the joined text). `None` — the default — means the units are requested one by one.
    fn joined_units(&mut self, _units: &[String], _limits: &[u32]) -> Option<Result<Raw, Self::Error>> {
        None
    }
}

/// Why a candidate was not produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// The chunk plan does not cover the paragraph.
    CoverageFailed,
    /// The paragraph cannot be split into two or more chunks.
    CannotSplit,
    /// The paragraph has fewer than two sentence units.
    SingleSentence,
}

impl Skip {
    /// The reason text the evaluation records use.
    pub fn reason(self) -> &'static str {
        match self {
            Skip::CoverageFailed => "coverage check failed",
            Skip::CannotSplit => "cannot split (single sentence)",
            Skip::SingleSentence => "single sentence",
        }
    }
}

/// One chunk of the chunked retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkOut {
    pub index: usize,
    /// The chunk's own English text.
    pub src: String,
    pub raw: Raw,
}

/// A candidate translation and how the checks judged it.
#[derive(Debug, Clone, PartialEq)]
pub struct Produced {
    pub out: String,
    pub tokens: Option<u64>,
    pub stop: String,
    /// The chunk plan and each chunk's answer (chunked retry only).
    pub spans: Vec<(usize, usize)>,
    pub chunks: Vec<ChunkOut>,
    /// The number of units (per-sentence retry only).
    pub units: Option<usize>,
    /// The detector's reasons, chunk reasons included as `chunk N: …`.
    pub flags: Vec<String>,
    /// The script check's reasons.
    pub script: Vec<String>,
}

impl Produced {
    pub fn clean(&self) -> bool {
        self.flags.is_empty() && self.script.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Candidate {
    Skipped(Skip),
    Produced(Produced),
}

/// One step of the decision, as recorded: a recovery candidate tried, or a second translation tried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Recovery(Kind),
    Second(Kind),
}

impl Step {
    pub fn name(self) -> String {
        match self {
            Step::Recovery(k) => k.name().to_string(),
            Step::Second(k) => format!("2:{}", k.name()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// The first translation was accepted.
    Ok,
    /// A recovery candidate was accepted.
    Recovered,
    /// A second translation replaced an incomplete one.
    Second,
    /// A translation is shown, but a check is unresolved.
    Review,
    /// No acceptable translation; there is no text.
    Failed,
}

impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Status::Ok => "OK",
            Status::Recovered => "RECOVERED",
            Status::Second => "SECOND",
            Status::Review => "REVIEW",
            Status::Failed => "FAILED",
        }
    }
}

/// Why a paragraph is marked for review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewReason {
    /// A script problem no retry repaired; the first translation is shown.
    ScriptLeak,
    /// The completeness check flagged the accepted translation and no second translation was clean. It is also kept
    /// when a second translation was then selected (status SECOND), as the evaluated pipeline records it.
    Incomplete,
}

impl ReviewReason {
    pub fn text(self) -> &'static str {
        match self {
            ReviewReason::ScriptLeak => "script leak not repaired",
            ReviewReason::Incomplete => "D1: no clean second translation",
        }
    }
}

/// The result for one paragraph. A reader-facing text exists only with its status: REVIEW keeps its reason, and
/// FAILED has no text at all.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub status: Status,
    /// The candidate whose text is given (`None` for FAILED).
    pub final_kind: Option<Kind>,
    pub text: Option<String>,
    pub steps: Vec<Step>,
    /// Whether the completeness check flagged the accepted translation (`None` when none was accepted).
    pub d1: Option<bool>,
    pub why_review: Option<ReviewReason>,
    /// Every candidate produced or skipped, with its judgement.
    pub candidates: std::collections::BTreeMap<Kind, Candidate>,
    /// The requests made, in order, as `(kind, index)`.
    pub requests: Vec<(Kind, usize)>,
}

/// A paragraph the planners cannot plan — where the evaluated implementation stops too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputError {
    /// A sentence, unit or chunk is not found in the paragraph at its place.
    Unlocatable { planner: Planner, what: &'static str, index: usize },
    /// A sentence holds no text.
    EmptySentence { planner: Planner, index: usize },
}

impl std::fmt::Display for InputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InputError::Unlocatable { planner, what, index } => write!(f, "{planner:?} planner: {what} {index} is not in the paragraph at its place"),
            InputError::EmptySentence { planner, index } => write!(f, "{planner:?} planner: sentence {index} is empty"),
        }
    }
}

/// Why a paragraph has no result. Neither is ever turned into a translation status, and neither leaves anything
/// behind: the paragraph stays untranslated.
#[derive(Debug, Clone, PartialEq)]
pub enum PipelineError<E> {
    /// The paragraph cannot be planned. Deterministic: the same input fails the same way.
    Input(InputError),
    /// The source failed to answer a request (an engine error, a timeout, a cancellation…), returned unchanged.
    /// Retrying means doing the whole paragraph again.
    Source { kind: Kind, index: usize, error: E },
}
