//! RAWY-270A — the Windows audio-session IDENTITY. **METADATA ONLY.**
//!
//! # What this fixes
//!
//! Sard produces no audio itself: read-aloud is Web Audio inside the WebView, so the WASAPI session
//! is opened by Chromium's audio service — a process inside the WebView2 runtime, not Sard. Windows
//! identifies a session by its OWNING PROCESS's executable when the session carries no metadata of
//! its own, and Chromium sets none (MEASURED: `GetDisplayName()` and `GetIconPath()` are both empty,
//! and the same is true of Brave/Discord/CEF sessions — they merely LOOK right because their audio
//! process is their own exe). Sard hosts a SHARED Microsoft binary, so the identical fallback lands
//! on Microsoft's icon and the name "Microsoft Edge WebView2" in the Volume Mixer.
//!
//! # Why this is metadata and nothing more
//!
//! RAWY-270's investigation established that session OWNERSHIP cannot be moved. The complete
//! `IAudioSessionControl`/`IAudioSessionControl2` surface offers `SetDisplayName`, `SetIconPath`,
//! `SetGroupingParam` and `SetDuckingPreference` — and `GetSessionIdentifier`, `GetProcessId` and
//! `GetSessionInstanceIdentifier` are READ-ONLY. There is no supported way to say "this stream is
//! mine". So this module changes what Windows DISPLAYS and touches nothing else.
//!
//! **KNOWN LIMIT, on the record.** `SetDisplayName`/`SetIconPath` do NOT change the session
//! IDENTIFIER, which is the WebView2 executable path with no app component. Windows persists per-app
//! volume against that identifier, so the mixer's slider and mute for Sard are still shared with
//! every other WebView2-hosted app of the same runtime version. That is not fixable here and is not
//! what this ticket claims to fix.
//!
//! # Design
//!
//! One dedicated thread, COM-initialised MTA, that BLOCKS on an event and does nothing at all until
//! Windows wakes it. No polling, no timer, no idle CPU. It is woken by exactly two supported
//! notifications:
//!   * `IAudioSessionNotification::OnSessionCreated` — a new session on an endpoint we watch. This is
//!     what covers a renderer or audio-service restart: Chromium tears its stream down when idle and
//!     builds a fresh session on the next play, and a fresh session has fresh (empty) metadata.
//!   * `IMMNotificationClient` — a device added/removed/re-stated, or the default device changed.
//!     A new endpoint means new sessions on a manager we have never seen.
//!
//! Both callbacks arrive on RPC threads and do ONE thing: `SetEvent`. No COM work happens inside a
//! callback (`OnSessionCreated` hands over a session that may not be fully initialised yet, and
//! blocking an RPC thread inside the audio stack is a deadlock waiting to happen). The worker
//! re-scans instead, which is a handful of sessions and idempotent.
//!
//! # Which sessions we touch
//!
//! ONLY processes that descend from THIS process, resolved through a live process snapshot. Never by
//! executable name — that is not a hypothetical concern: a second WebView2 host (`MSPCManager.exe`)
//! was observed running alongside Sard on the owner's own machine, and a name-based filter would have
//! renamed its audio session too.
//!
//! Every failure is swallowed. A mislabelled mixer entry is a cosmetic defect; anything this module
//! does to make it louder than that would be worse than the defect.

#![cfg(target_os = "windows")]

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;

use windows::core::{implement, Interface, PCWSTR, Ref, Result as WinResult};
use windows::Win32::Foundation::{CloseHandle, HANDLE, PROPERTYKEY, S_OK};
use windows::Win32::Media::Audio::{
    eRender, EDataFlow, ERole, IAudioSessionControl, IAudioSessionControl2, IAudioSessionManager2,
    IAudioSessionNotification, IAudioSessionNotification_Impl, IMMDeviceEnumerator,
    IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject, INFINITE,
};

/// What the Volume Mixer will show. Deliberately the product name, untranslated: it is the app's
/// identity, the same string the executable's own `ProductName` resource carries.
const SESSION_NAME: &str = "Sard";

/// After a wake, wait this long before re-scanning. Chromium can create and drop streams in bursts
/// (a chapter change is one), and one scan after the burst beats one scan per event. Purely a
/// coalescing window — correctness does not depend on its value, only the number of scans does.
const DEBOUNCE_MS: u64 = 250;

/// How far up a parent chain we are willing to walk. The real chain is
/// `audio service -> WebView2 browser -> sard.exe` (depth 2), so this is generous; its job is to
/// bound the walk if a snapshot ever contains a cycle from PID reuse.
const MAX_ANCESTRY_DEPTH: usize = 16;

/// A raw event HANDLE that the COM callbacks can signal from any thread.
///
/// `SetEvent` is a single lock-free syscall, which is exactly what belongs inside an audio-stack
/// callback — a Mutex there could block an RPC thread that the audio engine is waiting on.
#[derive(Clone, Copy)]
struct Signal(HANDLE);
// SAFETY: a Win32 event HANDLE is just a kernel object reference. `SetEvent` is documented as safe
// to call concurrently from any thread, and this wrapper exposes nothing else.
unsafe impl Send for Signal {}
unsafe impl Sync for Signal {}

impl Signal {
    fn raise(&self) {
        // A failed SetEvent means the worker will simply not re-scan until the next notification.
        unsafe {
            let _ = SetEvent(self.0);
        }
    }
}

// ---- the two notification sinks: both only ever raise the signal --------------------------------

#[implement(IAudioSessionNotification)]
struct SessionSink(Signal);

impl IAudioSessionNotification_Impl for SessionSink_Impl {
    fn OnSessionCreated(&self, _new_session: Ref<'_, IAudioSessionControl>) -> WinResult<()> {
        // Deliberately does NOT touch `_new_session`: the object handed to this callback is not
        // guaranteed to be ready, and the worker re-scan will find it a moment later anyway.
        self.0.raise();
        Ok(())
    }
}

#[implement(IMMNotificationClient)]
struct DeviceSink(Signal);

impl IMMNotificationClient_Impl for DeviceSink_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> WinResult<()> {
        self.0.raise();
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> WinResult<()> {
        self.0.raise();
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> WinResult<()> {
        self.0.raise();
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, _f: EDataFlow, _r: ERole, _id: &PCWSTR) -> WinResult<()> {
        self.0.raise();
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> WinResult<()> {
        // Property churn is frequent and almost never interesting; the debounce absorbs it.
        self.0.raise();
        Ok(())
    }
}

// ---- process ancestry ---------------------------------------------------------------------------

/// child PID -> parent PID, from ONE live snapshot.
///
/// Taken fresh per scan so the parent links are current. The residual risk is PID reuse of a middle
/// link, which would need a dead PID to be recycled into a process that is itself an ancestor of an
/// unrelated audio producer — accepted, and bounded by `MAX_ANCESTRY_DEPTH`.
fn parent_map() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    map
}

/// Is `pid` a DESCENDANT of `ours`? Our own process is deliberately excluded: Sard opens no stream
/// of its own, so a session attributed to `sard.exe` would not be one of ours to relabel.
fn descends_from(pid: u32, ours: u32, parents: &HashMap<u32, u32>) -> bool {
    if pid == 0 || pid == ours {
        return false;
    }
    let mut cur = pid;
    for _ in 0..MAX_ANCESTRY_DEPTH {
        match parents.get(&cur) {
            Some(&parent) if parent == ours => return true,
            Some(&parent) if parent == 0 || parent == cur => return false,
            Some(&parent) => cur = parent,
            None => return false,
        }
    }
    false
}

// ---- the scan -----------------------------------------------------------------------------------

/// Stamp our name and icon on every session owned by one of our descendants.
///
/// Idempotent: re-writing the same strings on an already-labelled session is a no-op to the user, so
/// the worker never has to track which sessions it has already seen.
unsafe fn label_sessions(manager: &IAudioSessionManager2, ours: u32, icon: &PCWSTR) {
    let Ok(sessions) = manager.GetSessionEnumerator() else {
        return;
    };
    let Ok(count) = sessions.GetCount() else {
        return;
    };
    if count <= 0 {
        return;
    }
    let parents = parent_map();
    let name: Vec<u16> = SESSION_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    for index in 0..count {
        let Ok(control) = sessions.GetSession(index) else {
            continue;
        };
        let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
            continue;
        };
        // A system-sounds session has no owning process worth attributing.
        //
        // ⚠ This MUST compare against S_OK, not use `is_ok()`. `IsSystemSoundsSession` returns a RAW
        // HRESULT: `S_OK` when it IS the system-sounds session and `S_FALSE` when it is not — and
        // `S_FALSE` is a SUCCESS code, so `is_ok()` is true for BOTH and would skip every session,
        // turning this whole module into a silent no-op that still compiles and still runs.
        if control2.IsSystemSoundsSession() == S_OK {
            continue;
        }
        let Ok(pid) = control2.GetProcessId() else {
            continue;
        };
        if !descends_from(pid, ours, &parents) {
            continue;
        }
        // A NULL event context: we register no per-session change client of our own, so there is no
        // callback that would need to recognise (and skip) its own write.
        let _ = control2.SetDisplayName(PCWSTR(name.as_ptr()), std::ptr::null());
        let _ = control2.SetIconPath(*icon, std::ptr::null());
    }
}

// ---- the worker ---------------------------------------------------------------------------------

/// Discover any endpoint we have not armed yet, arm it, and label everything we own.
///
/// `GetSessionEnumerator` is called BEFORE `RegisterSessionNotification` deliberately: a session
/// manager does not deliver creation notifications until its session list has been materialised once.
unsafe fn arm_and_label(
    enumerator: &IMMDeviceEnumerator,
    signal: Signal,
    armed: &mut HashSet<String>,
    managers: &mut Vec<IAudioSessionManager2>,
    sinks: &mut Vec<IAudioSessionNotification>,
    ours: u32,
    icon: &PCWSTR,
) {
    if let Ok(devices) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
        if let Ok(n) = devices.GetCount() {
            for i in 0..n {
                let Ok(device) = devices.Item(i) else { continue };
                let Ok(id) = device.GetId() else { continue };
                let key = id.to_string().unwrap_or_default();
                let _ = windows::Win32::System::Com::CoTaskMemFree(Some(id.0 as *const c_void));
                if key.is_empty() || armed.contains(&key) {
                    continue;
                }
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                    continue;
                };
                // Materialise the list first (see above), then subscribe.
                let _ = manager.GetSessionEnumerator();
                let sink: IAudioSessionNotification = SessionSink(signal).into();
                if manager.RegisterSessionNotification(&sink).is_ok() {
                    sinks.push(sink);
                }
                managers.push(manager);
                armed.insert(key);
            }
        }
    }
    // Label across every manager we hold. A manager whose device has gone away simply fails here.
    for manager in managers.iter() {
        label_sessions(manager, ours, icon);
    }
}

fn worker() {
    unsafe {
        // MTA on our own thread: the audio session managers must not live on the UI's STA, and
        // notifications are delivered on RPC threads, which MTA handles without a message pump.
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return;
        }
        let Ok(event) = CreateEventW(None, false, false, PCWSTR::null()) else {
            return;
        };
        let signal = Signal(event);

        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return;
        };
        // Held for the life of the thread; dropping it would unsubscribe.
        let device_sink: IMMNotificationClient = DeviceSink(signal).into();
        let _ = enumerator.RegisterEndpointNotificationCallback(&device_sink);

        // The icon Windows should draw: our own executable's first icon resource.
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let icon_utf16: Vec<u16> = format!("{},0", exe.display())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let icon = PCWSTR(icon_utf16.as_ptr());

        let ours = GetCurrentProcessId();
        let mut armed: HashSet<String> = HashSet::new();
        let mut managers: Vec<IAudioSessionManager2> = Vec::new();
        let mut sinks: Vec<IAudioSessionNotification> = Vec::new();

        loop {
            arm_and_label(
                &enumerator,
                signal,
                &mut armed,
                &mut managers,
                &mut sinks,
                ours,
                &icon,
            );
            // Blocks with ZERO cost until Windows has something to tell us.
            WaitForSingleObject(event, INFINITE);
            // Label IMMEDIATELY on the wake, THEN coalesce — never the other way round.
            //
            // MEASURED (RAWY-270A): mixer clients snapshot a session's icon when they first SEE it.
            // EarTrumpet's `AudioDeviceSession` constructor calls `ChooseIconPath(GetIconPath())`
            // once, and if the path is empty at that instant it falls back to the owning process's
            // executable — permanently, for that session object. Sleeping the debounce BEFORE the
            // first write handed every such client a 250 ms window in which our session still looked
            // like the WebView2 runtime, and we lost that race essentially every time.
            arm_and_label(&enumerator, signal, &mut armed, &mut managers, &mut sinks, ours, &icon);
            // ...then coalesce the rest of the burst (a chapter change can create and drop several
            // streams in quick succession) with one more pass at the top of the loop.
            std::thread::sleep(std::time::Duration::from_millis(DEBOUNCE_MS));
        }
    }
}

/// Start the audio-session identity worker. Call once at startup.
///
/// Returns immediately: everything happens on a dedicated thread, so no part of this can delay or
/// block the UI thread. If the thread cannot be spawned, the mixer keeps its default labelling and
/// nothing else changes.
pub fn start() {
    let _ = std::thread::Builder::new()
        .name("sard-audio-identity".into())
        .spawn(worker);
}
