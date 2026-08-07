// Does a non-Latin keyboard layout actually break Ctrl+Shift+D?
//
// The chain harness proved the HANDLER rejects an event whose `key` is a layout character while its
// `code` is still "KeyD" — but it supplied that event itself, so it proved a property of our code,
// not a property of Windows. Sard's users read Arabic and many will have the Arabic layout active,
// so what Windows actually delivers is worth measuring rather than assuming.
//
// This activates the Arabic layout, sends a REAL Ctrl+Shift+D through the OS to the focused Sard
// window, records what the page received, and restores the original layout list on every exit path.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();

const PROBE = `(() => {
  window.__keys = [];
  window.addEventListener('keydown', (e) => window.__keys.push(
    { key: e.key, code: e.code, keyCode: e.keyCode, ctrl: e.ctrlKey, shift: e.shiftKey }), true);
  return true;
})()`;

const before = ps("(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag }) -join ','");
console.log(`languages before: ${before}`);
const snap = snapshotDb(REPO, "layout-key");
if (!snap) {
  console.error("FATAL: could not snapshot the profile — refusing to run. NOTHING was verified.");
  process.exit(1);
}

let out = 1;
let s;
let languageChanged = false;
try {
  if (!/(^|,)ar/.test(before)) {
    ps("$l = Get-WinUserLanguageList; $l.Add('ar-SA'); Set-WinUserLanguageList $l -Force");
    languageChanged = true;
    await sleep(2500);
    console.log(`languages now:    ${ps("(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag }) -join ','")}`);
  }

  s = await launchSard({ exe: "test-build/Sard.exe", port: 9343, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);
  await s.evaluate(PROBE);

  // Bring Sard to the foreground and switch the INPUT LANGUAGE of its thread to Arabic, the way a
  // user pressing Win+Space does. LoadKeyboardLayout + ActivateKeyboardLayout act on the foreground
  // thread, so the app must be focused first.
  const activate = `
    Add-Type -AssemblyName Microsoft.VisualBasic, System.Windows.Forms
    $p = Get-Process Sard -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { 'NO SARD PROCESS'; exit }
    [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) | Out-Null
    Start-Sleep -Milliseconds 900
    $sig = '[DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string p, uint f);
            [DllImport("user32.dll")] public static extern IntPtr ActivateKeyboardLayout(IntPtr h, uint f);
            [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint t);'
    $k = Add-Type -MemberDefinition $sig -Name KbdX -Namespace W32 -PassThru
    $h = $k::LoadKeyboardLayout('00000401', 1)      # Arabic (Saudi Arabia)
    $k::ActivateKeyboardLayout($h, 0) | Out-Null
    Start-Sleep -Milliseconds 600
    'active layout: 0x' + ('{0:X}' -f $k::GetKeyboardLayout(0).ToInt32())
    # SendKeys is useless here: with a non-Latin layout it injects Unicode via VK_PACKET, so the page
    # receives code="" and keyCode=231 and NOTHING is translated through the layout. Measured. A real
    # answer needs SCANCODES, which is what a physical keyboard sends and what the layout maps.
    $src = @"
using System;
using System.Runtime.InteropServices;
public class Scan {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type; public KEYBDINPUT ki; public int pad1; public int pad2; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] p, int size);
  static void One(ushort scan, bool up) {
    INPUT[] i = new INPUT[1];
    i[0].type = 1;
    i[0].ki.wVk = 0;
    i[0].ki.wScan = scan;
    i[0].ki.dwFlags = (uint)(8 | (up ? 2 : 0));
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Chord() {
    One(0x1D, false); One(0x2A, false); One(0x20, false);
    System.Threading.Thread.Sleep(120);
    One(0x20, true); One(0x2A, true); One(0x1D, true);
  }
}
"@
    Add-Type -TypeDefinition $src
    [Scan]::Chord()
    Start-Sleep -Milliseconds 800
    'sent (scancodes)'`;
  console.log(ps(activate));
  await sleep(2000);

  const seen = await s.evaluate(`window.__keys`);
  console.log(`\nkeydown events the page received: ${seen.length}`);
  for (const k of seen) console.log(`   ${JSON.stringify(k)}`);

  const dLike = seen.filter((k) => k.code === "KeyD" || k.keyCode === 68);
  if (!dLike.length) {
    console.log("\nUNKNOWN — no D-like key arrived; SendKeys may not have reached the window. No claim made.");
  } else {
    const k = dLike[dLike.length - 1];
    const matchesHandler = k.ctrl && k.shift && (k.key === "D" || k.key === "d");
    console.log(
      `\nMEASURED with the Arabic layout ACTIVE:` +
        `\n   event.key  = ${JSON.stringify(k.key)}` +
        `\n   event.code = ${JSON.stringify(k.code)}` +
        `\n   the shipped condition (key === 'D' || key === 'd') would ${matchesHandler ? "MATCH" : "NOT match"}` +
        `\n   a condition on event.code would ${k.code === "KeyD" ? "MATCH" : "NOT match"}`,
    );
  }
  out = 0;
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
} finally {
  try {
    execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  // Restore the machine exactly as it was — this harness changed a system setting and must undo it.
  if (languageChanged) {
    try {
      ps(`$l = Get-WinUserLanguageList; $keep = $l | Where-Object { $_.LanguageTag -ne 'ar-SA' }; Set-WinUserLanguageList $keep -Force`);
      console.log(`languages restored: ${ps("(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag }) -join ','")}`);
    } catch (e) {
      console.error(`⚠ COULD NOT RESTORE THE LANGUAGE LIST — was '${before}'. Fix manually: ${e.message}`);
      out = 1;
    }
  }
  await sleep(1200);
  const ok = await restoreDb(snap);
  console.log(`profile restored: ${ok ? "OK" : "FAILED — CHECK MANUALLY"}`);
  if (!ok) out = 1;
}
process.exit(out);
