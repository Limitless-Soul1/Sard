#!/usr/bin/env python3
"""Reader-host runtime gate verdict — THROWAWAY.

Measured only. Anything not observed stays UNKNOWN, and UNKNOWN is never rendered as a pass or as a
failure: an earlier report classified absent data as FAIL and printed nine failures for a run that
had measured nothing at all.
"""
import json
import os
import sys

p = sys.argv[1]
d = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None
L = []


def say(s=""):
    L.append(s)


say("# Reader-host runtime gate — WebKitGTK, real Tauri app, real EPUB, real X11 click")
say()
if not d:
    say("**No result. Every criterion is UNKNOWN.**")
    print("\n".join(L))
    sys.exit(1)

host = d.get("hostReport") or {}
inp = host.get("input") or {}
hostinp = host.get("hostInput") or {}
clicked = len(sys.argv) > 2 and os.path.exists(sys.argv[2])
reach = host.get("reach") or {}
assets = host.get("assets") or {}
viol = host.get("cspViolations") or []
cmd = d.get("cmd") or {}
state = d.get("state") or {}
acr = d.get("appCanReadHost") or {}


def val(x):
    return "—" if x is None else f"`{x}`"


say(f"- app origin {val(d.get('appOrigin'))} · host reported from {val(d.get('hostReportOrigin'))}")
say(f"- host's own origin {val(host.get('origin'))} · ready signal {val(d.get('hostReady'))}")
say(f"- handshake: {val(d.get('handshake'))}")
say(f"- subject: {val((d.get('book') or {}).get('bytes'))} bytes")
say(f"- last stage reached: {val(d.get('stage'))}")
if d.get("errors"):
    say(f"- errors: `{d['errors']}`")
say()

say("## Transport")
say()
say("| command | result |")
say("|---|---|")
for k, v in cmd.items():
    say(f"| `{k}` | `{json.dumps(v)[:120]}` |")
say()

say("## Engine state")
say()
say("| moment | section | toc entries | at chapter start |")
say("|---|---|---|---|")
for moment in ("afterOpen", "afterNav", "afterClick"):
    s = state.get(moment)
    if isinstance(s, dict):
        say(f"| {moment} | `{s.get('section')}` | `{s.get('toc')}` | `{s.get('atChapterStart')}` |")
    elif s is not None:
        say(f"| {moment} | `{str(s)[:60]}` | | |")
say()

say("## Real input delivery — the measurement the architecture exists for")
say()
say(f"- section iframe sandbox actually set: {val(inp.get('sandbox'))}")
say(f"- section documents instrumented: {val(inp.get('docsInstrumented'))}")
say(f"- a real X11 click was delivered by the harness: {val(clicked)}")
say(f"- CONTROL — events on the host's own document: "
    f"pointerdown {val(hostinp.get('pointerdown'))}, mousedown {val(hostinp.get('mousedown'))}, "
    f"click {val(hostinp.get('click'))}")
say("")
say("| event | count |")
say("|---|---|")
for k in ("pointerdown", "mousedown", "click", "selectionchange"):
    say(f"| `{k}` | `{inp.get(k)}` |")
say()

say("## Boundary, measured from inside the host after mounting")
say()
say("| attempt | result |")
say("|---|---|")
for k, v in reach.items():
    mark = f"🔴 **{v}**" if str(v).startswith("REACHED") else f"🟢 `{v}`"
    say(f"| host → `{k}` | {mark} |")
for k, v in acr.items():
    mark = f"🔴 **{v}**" if str(v) == "READABLE" else f"🟢 `{v}`"
    say(f"| app → host `{k}` | {mark} |")
say(f"| refused book path | `{assets.get('fetch.refusedBookPath')}` |")
say(f"| refused traversal | `{assets.get('fetch.refusedTraversal')}` |")
say(f"| cross-origin fetch | `{assets.get('fetch.crossOrigin')}` |")
say(f"| MessagePort on host global | `{(host.get('channels') or {}).get('messagePortsOnGlobal')}` |")
say(f"| CSP violations seen | `{[v.get('directive') for v in viol]}` |")
say()


def blocked(v):
    return str(v).startswith("BLOCKED") or str(v) == "undefined"


def opened():
    return isinstance(cmd.get("open"), dict) and cmd["open"].get("opened") is True


def sect(m):
    s = state.get(m)
    return s.get("section") if isinstance(s, dict) else None


UNKNOWN = "UNKNOWN"
crit = []

crit.append(("1 host loads from its isolated origin",
             "PASS" if host.get("origin") and host.get("origin") != d.get("appOrigin")
             else (UNKNOWN if not host else "FAIL"),
             f"host {host.get('origin')} vs app {d.get('appOrigin')}"))

crit.append(("2 MessagePort handshake acknowledged",
             "PASS" if str(d.get("handshake", "")).startswith("acked") else
             (UNKNOWN if not d.get("hostReady") else "FAIL"),
             str(d.get("handshake"))))

crit.append(("3 a real EPUB opened inside the host",
             "PASS" if opened() else (UNKNOWN if "open" not in cmd else "FAIL"),
             json.dumps(cmd.get("open"))[:100]))

crit.append(("4 the engine reports real structure (a TOC it parsed)",
             "PASS" if isinstance(state.get("afterOpen"), dict) and (state["afterOpen"].get("toc") or 0) > 0
             else (UNKNOWN if not isinstance(state.get("afterOpen"), dict) else "FAIL"),
             json.dumps(state.get("afterOpen"))[:100]))

nav_ok = isinstance(cmd.get("navKey.1"), dict) and cmd["navKey.1"].get("handled") is True
crit.append(("5 pagination: the engine handled a navigation key",
             "PASS" if nav_ok else (UNKNOWN if "navKey.1" not in cmd else "FAIL"),
             json.dumps(cmd.get("navKey.1"))[:100]))

sandbox = inp.get("sandbox")
crit.append(("6 the section iframe carries allow-scripts (patch 1b took effect)",
             "PASS" if sandbox and "allow-scripts" in sandbox else (UNKNOWN if sandbox is None else "FAIL"),
             str(sandbox)))

instrumented = inp.get("docsInstrumented") or 0
delivered = sum(int(inp.get(k) or 0) for k in ("pointerdown", "mousedown", "click"))
control = sum(int(hostinp.get(k) or 0) for k in ("pointerdown", "mousedown", "click"))
if not clicked:
    v = UNKNOWN
    why = "the harness never delivered a click, so a count of zero measures nothing"
elif not instrumented:
    v = UNKNOWN
    why = "no section document was readable, so nothing could be listening"
elif control == 0:
    v = UNKNOWN
    why = (f"CONTROL FAILED: the host's own document saw 0 events either, so the click missed the "
           f"window — the section count of {delivered} says nothing about event delivery")
else:
    v = "PASS" if delivered > 0 else "FAIL"
    why = (f"{delivered} event(s) in the section vs {control} on the host document "
           f"({instrumented} instrumented)")
crit.append(("7 REAL X11 input reaches the section document", v, why))

crit.append(("8 book/app boundary: no Tauri internals from the host",
             "PASS" if blocked(reach.get("parent.__TAURI_INTERNALS__")) and blocked(reach.get("top.__TAURI_INTERNALS__"))
             else (UNKNOWN if not reach else "FAIL"),
             f"parent={reach.get('parent.__TAURI_INTERNALS__')} top={reach.get('top.__TAURI_INTERNALS__')}"))

crit.append(("9 no application document, no application secret",
             "PASS" if blocked(reach.get("parent.document")) and blocked(reach.get("parent.location.href"))
             else (UNKNOWN if not reach else "FAIL"),
             f"doc={reach.get('parent.document')} href={reach.get('parent.location.href')}"))

crit.append(("10 no filesystem / library / database route",
             "PASS" if str(assets.get("fetch.refusedBookPath", "")).startswith("HTTP:404")
             and not str(assets.get("fetch.refusedTraversal", "")).startswith("OK:")
             else (UNKNOWN if "fetch.refusedBookPath" not in assets else "FAIL"),
             f"book={assets.get('fetch.refusedBookPath')} traversal={assets.get('fetch.refusedTraversal')}"))

cs = assets.get("fetch.crossOrigin")
crit.append(("11 no unintended remote access (connect-src enforced)",
             "PASS" if cs is not None and not str(cs).startswith("OK:") and viol
             else (UNKNOWN if cs is None else "FAIL"),
             f"crossOrigin={cs} violations={len(viol)}"))

crit.append(("12 the application cannot read into the host",
             "PASS" if acr.get("contentDocument") == "null" or str(acr.get("contentDocument")).startswith("BLOCKED")
             else (UNKNOWN if not acr else "FAIL"),
             f"contentDocument={acr.get('contentDocument')}"))

crit.append(("13 no MessagePort published on the host global",
             "PASS" if (host.get("channels") or {}).get("messagePortsOnGlobal") == "none"
             else (UNKNOWN if not host.get("channels") else "FAIL"),
             str((host.get("channels") or {}).get("messagePortsOnGlobal"))))

say("## Verdict")
say()
say("| criterion | verdict | evidence |")
say("|---|---|---|")
for name, verdict, ev in crit:
    icon = {"PASS": "✅", "FAIL": "❌", UNKNOWN: "⚪"}[verdict]
    say(f"| {name} | {icon} **{verdict}** | `{str(ev)[:110]}` |")
say()
n_fail = sum(1 for c in crit if c[1] == "FAIL")
n_unk = sum(1 for c in crit if c[1] == UNKNOWN)
say(f"**{len(crit) - n_fail - n_unk} PASS · {n_fail} FAIL · {n_unk} UNKNOWN**")
say()
say("> Scope: **WebKitGTK only**, this build. WKWebView and WebView2 are untested and remain UNKNOWN.")
print("\n".join(L))
sys.exit(1 if n_fail else 0)
