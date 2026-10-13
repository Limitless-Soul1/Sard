//! Translation — the files a local translation needs, and getting them onto disk safely.
//!
//! So far this module covers DELIVERY only: the catalog of downloadable files (`catalog`), where they
//! live and what state they are in (`store`), and the verified, resumable download (`download`).
//!
//! Nothing here is reachable from the interface yet. There is no command, so nothing can be
//! downloaded until the screens that ask the user — and show each file's licence before it is fetched
//! — exist. A model is never bundled with Sard and never downloaded without the user choosing it.
//!
//! Three guarantees the rest of the feature builds on:
//!
//! * **Only the catalog's exact bytes are installed.** Size and SHA-256 are checked over the whole
//!   file before it is moved into place; anything else is deleted.
//! * **An unfinished download waits for the user.** It is kept on disk and continued only on request.
//! * **Nothing outside the translation directory is ever written or deleted.** Every removal is
//!   checked against the resolved translation root, and removal deletes only the files the store
//!   itself wrote.

pub mod catalog;
pub mod download;
pub mod store;

#[cfg(test)]
mod test_server;
#[cfg(test)]
mod tests;
