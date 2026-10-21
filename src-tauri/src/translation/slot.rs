//! The one engine slot of this process.
//!
//! At most one thing may hold the inference engine at a time: an installation (which replaces its files) or a
//! running engine (which has those files loaded). The slot is process-wide rather than per manager, so two
//! managers cannot start two engines, and an engine can never be running while its files are being replaced.

use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    Install,
    Engine,
}

static SLOT: Mutex<Option<Holder>> = Mutex::new(None);

/// Held while the slot is taken; dropping it frees the slot.
#[derive(Debug)]
pub struct SlotGuard(Holder);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        // A poisoned lock still holds the state; recover it rather than leave the slot taken for ever.
        let mut slot = SLOT.lock().unwrap_or_else(|p| p.into_inner());
        if *slot == Some(self.0) {
            *slot = None;
        }
    }
}

/// Tests that take the slot run one at a time: the slot is process-wide, and the test harness runs tests in
/// parallel threads of one process.
#[cfg(test)]
pub(crate) fn serial_for_tests() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

/// Free a slot a test deliberately left taken (a stop that was made to fail keeps it). Only the engine's
/// process tests do that, and those exist only on Windows.
#[cfg(all(test, windows))]
pub(crate) fn release_for_tests() {
    *SLOT.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Who holds the slot now, if anyone: a reading only, which may be stale by the time it is used. A caller that must
/// keep the answer true takes the slot with `claim` instead.
pub fn holder() -> Option<Holder> {
    *SLOT.lock().unwrap_or_else(|p| p.into_inner())
}

/// Take the slot for `holder`, or report who has it.
pub fn claim(holder: Holder) -> Result<SlotGuard, Holder> {
    let mut slot = SLOT.lock().unwrap_or_else(|p| p.into_inner());
    match *slot {
        Some(current) => Err(current),
        None => {
            *slot = Some(holder);
            Ok(SlotGuard(holder))
        }
    }
}
