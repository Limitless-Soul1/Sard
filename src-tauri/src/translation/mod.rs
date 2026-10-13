//! Translation — the files a local translation needs, getting them onto disk safely, and running the
//! engine that uses them.
//!
//! Two stages exist so far:
//!
//! * **Delivery:** the catalog of downloadable files (`catalog`), where they live and what state they
//!   are in (`store`), and the verified, resumable download (`download`).
//! * **The engine:** installing it from its verified archive (`install`), and starting, checking and
//!   stopping its process (`engine`). One slot (`slot`) keeps the two apart.
//!
//! Nothing here is reachable from the interface yet. There is no command, so nothing can be
//! downloaded, installed or started until the screens that ask the user — and show each file's licence
//! before it is fetched — exist. A model is never bundled with Sard and never downloaded without the
//! user choosing it.
//!
//! The guarantees the rest of the feature builds on:
//!
//! * **Only the catalog's exact bytes are installed.** Size and SHA-256 are checked over the whole
//!   file before it is moved into place; anything else is deleted.
//! * **An unfinished download waits for the user.** It is kept on disk and continued only on request.
//! * **Nothing outside the translation directory is ever written or deleted.** Every removal is
//!   checked against the resolved translation root. Removing a download deletes only the files the
//!   store itself wrote; the engine's directory is Sard's own and is removed whole.
//! * **Only the pinned engine files are ever run.** Each one is hashed again before every launch, and
//!   the engine is not launched if its directory holds anything else.
//! * **One engine, reachable only by Sard, for only as long as Sard runs.** It listens on 127.0.0.1
//!   with a key made for that session, and the operating system ends it when Sard ends.

pub mod catalog;
pub mod download;
pub mod engine;
pub mod install;
pub mod slot;
pub mod store;

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod test_server;
#[cfg(test)]
mod tests;
