//! Where an imported mark stands in *this* reader's copy.
//!
//! A deposit bound to a different edition carries cfis that mean nothing here. The reader's own engine
//! is the only thing that can say where such a mark belongs — so this module does no searching at all.
//! It hands the reader what is still unplaced, and writes back the verdicts the reader reaches.
//!
//! # The rule this module exists to enforce
//!
//! **A verdict may only ever touch a row the deposit itself created.** Every write is joined to
//! `mark_origin`, so a mark the reader made — which has no origin row — is invisible here and cannot be
//! reached by any code path, however the frontend is called. That is the structural form of "never
//! overwrite the recipient's annotations".
//!
//! A terminal verdict is never revisited, so re-running the pass is a no-op; and a pass that is
//! interrupted leaves its marks `pending`, so the next open simply resumes.

use rusqlite::{Connection, OptionalExtension};

/// A mark that still has to find its place, with everything the reader needs to look for it.
#[derive(serde::Serialize)]
pub struct PendingMark {
    pub kind: String,
    pub id: String,
    /// The sender's cfi, verbatim. Tried first: an identical edition that was merely re-packaged will
    /// resolve it, and no searching is needed at all.
    pub cfi: Option<String>,
    /// The needle. Without it a mark cannot be searched for, and is never placed.
    pub excerpt: Option<String>,
    /// The sender's own chapter label — the strongest cross-edition hint there is, because a chapter
    /// keeps its name across editions far more reliably than its position.
    pub chapter_label: Option<String>,
    pub state: Option<String>,
    /// Set once the count pass has settled on a section and is waiting for it to render.
    pub target_section: Option<i64>,
    /// For a note: the highlight it belongs to. A note is never searched for on its own — its body is
    /// the reader's words, not the book's — so it follows its highlight or stays unplaced.
    pub of_highlight: Option<String>,
}

/// One verdict from the reader.
#[derive(serde::Deserialize)]
pub struct Verdict {
    pub kind: String,
    pub id: String,
    /// `located` · `placed` · `already_yours` · `ambiguous` · `absent` · `unanchorable`
    pub state: String,
    pub target_section: Option<i64>,
    /// Only for `placed`: the cfi minted in the rendered section.
    pub cfi: Option<String>,
}

const NON_TERMINAL: &str = "(mo.state IS NULL OR mo.state IN ('pending','located'))";

/// What is still unplaced in this book. Cheap and indexed; the answer is almost always empty.
pub fn pending(conn: &Connection, book_id: &str) -> Result<Vec<PendingMark>, String> {
    let mut out = Vec::new();

    let sql_h = format!(
        "SELECT mo.kind, h.id, h.start_cfi, h.text_excerpt, h.chapter_label, mo.state, mo.target_section \
         FROM mark_origin mo JOIN highlights h ON h.id = mo.mark_id AND mo.kind = 'highlight' \
         WHERE h.book_id = ?1 AND {NON_TERMINAL}"
    );
    let mut st = conn.prepare(&sql_h).map_err(|e| e.to_string())?;
    let rows = st
        .query_map([book_id], |r| {
            Ok(PendingMark {
                kind: r.get(0)?,
                id: r.get(1)?,
                cfi: r.get(2)?,
                excerpt: r.get(3)?,
                chapter_label: r.get(4)?,
                state: r.get(5)?,
                target_section: r.get(6)?,
                of_highlight: None,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }

    let sql_n = format!(
        "SELECT mo.kind, n.id, n.locator_cfi, NULL, n.chapter_label, mo.state, mo.target_section, n.highlight_id \
         FROM mark_origin mo JOIN notes n ON n.id = mo.mark_id AND mo.kind = 'note' \
         WHERE n.book_id = ?1 AND {NON_TERMINAL}"
    );
    let mut st = conn.prepare(&sql_n).map_err(|e| e.to_string())?;
    let rows = st
        .query_map([book_id], |r| {
            Ok(PendingMark {
                kind: r.get(0)?,
                id: r.get(1)?,
                cfi: r.get(2)?,
                // A NOTE IS NEVER SEARCHED FOR BY ITS BODY, so it is not offered one. It follows the
                // highlight it belongs to, or it stays where it is.
                excerpt: None,
                chapter_label: r.get(4)?,
                state: r.get(5)?,
                target_section: r.get(6)?,
                of_highlight: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Record what the reader decided, in one transaction.
///
/// A `placed` verdict is the only one that writes a cfi, and it writes it ONLY to a highlight or note
/// the deposit created. Everything else records a state and nothing more.
pub fn record(conn: &mut Connection, verdicts: &[Verdict]) -> Result<u32, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut written = 0u32;

    for v in verdicts {
        if v.kind != "highlight" && v.kind != "note" {
            continue;
        }
        // THE GATE. Only a mark this deposit created, and only one that has not already reached a
        // terminal verdict. A row the reader made has no `mark_origin` and cannot be selected here.
        let owned: Option<String> = tx
            .query_row(
                &format!(
                    "SELECT mo.mark_id FROM mark_origin mo \
                     WHERE mo.kind = ?1 AND mo.mark_id = ?2 AND {NON_TERMINAL}"
                ),
                rusqlite::params![v.kind, v.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if owned.is_none() {
            continue;
        }

        if v.state == "placed" {
            let Some(cfi) = v.cfi.as_deref() else { continue };
            if cfi.trim().is_empty() {
                continue;
            }
            let sql = if v.kind == "highlight" {
                "UPDATE highlights SET start_cfi = ?1 WHERE id = ?2"
            } else {
                "UPDATE notes SET locator_cfi = ?1 WHERE id = ?2"
            };
            tx.execute(sql, rusqlite::params![cfi, v.id]).map_err(|e| e.to_string())?;
        }

        tx.execute(
            "UPDATE mark_origin SET state = ?1, target_section = ?2, decided_at = ?3 \
             WHERE kind = ?4 AND mark_id = ?5",
            rusqlite::params![v.state, v.target_section, now, v.kind, v.id],
        )
        .map_err(|e| e.to_string())?;
        written += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(written)
}
