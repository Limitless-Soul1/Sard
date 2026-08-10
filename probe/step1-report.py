#!/usr/bin/env python3
"""Step 1 runtime verdict — THROWAWAY. Measured only; anything not observed stays UNKNOWN."""
import json, sys, os

p = sys.argv[1]
d = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None
L = []
def say(s=""): L.append(s)

say("# Step 1 runtime probe — WebKitGTK, real Tauri app, real `bookhost` handler")
say()
if not d:
    say("**No result. Every runtime criterion is UNKNOWN.**"); print("\n".join(L)); sys.exit(1)

h = d.get("hostReport") or {}
reach = h.get("reach") or {}
assets = h.get("assets") or {}
viol = h.get("cspViolations") or []
ctl = d.get("controls") or {}
acr = d.get("appCanReadHost") or {}

say("- app origin `%s` · host reported from origin `%s`" % (d.get("appOrigin"), d.get("hostReportOrigin")))
say("- host's own `location.origin`: `%s`" % h.get("origin"))
say("- host report received: **%s** (%s messages)" % (bool(h), d.get("windowMessages")))
if d.get("errors"): say("- probe errors: `%s`" % d["errors"])
say()

say("## Negative controls")
say()
say("| control | result |")
say("|---|---|")
for k, v in ctl.items():
    say("| `%s` | `%s` |" % (k, v))
say()
controls_ok = str(ctl.get("app.fetchOwnOrigin", "")).startswith("OK") and str(ctl.get("app.fetchCorsOrigin", "")).startswith("OK")
say("**Controls %s** — %s" % ("PASS" if controls_ok else "FAIL",
    "both targets are reachable from the app, so a refusal at the host is the host's policy"
    if controls_ok else "a target is unreachable, so the matching host result is UNKNOWN, not a pass"))
say()

say("## CSP violations observed at the host")
say()
if viol:
    for v in viol: say("- `%s` blocked `%s`" % (v.get("directive"), v.get("blocked")))
else:
    say("- none recorded")
say()

say("## Assets served by the handler")
say()
say("| request | result |")
say("|---|---|")
for k in ("fetch.font", "fetch.pdfjsCmap", "fetch.pdfjsWorker", "fontFace.load",
          "fetch.refusedBookPath", "fetch.refusedTraversal", "fetch.crossOrigin"):
    if k in assets: say("| `%s` | `%s` |" % (k, assets[k]))
say()

say("## Boundary, measured from both sides")
say()
say("| attempt | result |")
say("|---|---|")
for k, v in reach.items():
    mark = "🔴 **%s**" % v if str(v).startswith("REACHED") else "🟢 `%s`" % v
    say("| host → `%s` | %s |" % (k, mark))
for k, v in acr.items():
    mark = "🔴 **%s**" % v if str(v) == "READABLE" else "🟢 `%s`" % v
    say("| app → host `%s` | %s |" % (k, mark))
say("| channels on host global | `%s` |" % (h.get("channels") or {}).get("messagePortsOnGlobal"))
say("| host `window.opener` | `%s` |" % (h.get("channels") or {}).get("opener"))
say()

def blocked(v): return str(v).startswith("BLOCKED") or str(v) == "undefined"
def okfetch(v): return str(v).startswith("OK:")
def csp_hit(sub): return any(sub in str(v.get("blocked", "")) or v.get("directive", "").startswith("connect-src") for v in viol)

crit = []
crit.append(("1 host loads from its isolated origin",
             "PASS" if h.get("origin") and h.get("origin") != d.get("appOrigin") else ("UNKNOWN" if not h else "FAIL"),
             "host origin `%s` differs from app origin `%s`" % (h.get("origin"), d.get("appOrigin"))))
crit.append(("2 /fonts/* fetchable", "PASS" if okfetch(assets.get("fetch.font")) else "FAIL", str(assets.get("fetch.font"))))
crit.append(("2b font usable as a FACE (@font-face)",
             "PASS" if assets.get("fontFace.load") == "LOADED" else "FAIL", str(assets.get("fontFace.load"))))
crit.append(("3 pdf.js CMap loads", "PASS" if okfetch(assets.get("fetch.pdfjsCmap")) else "FAIL", str(assets.get("fetch.pdfjsCmap"))))
crit.append(("4 cannot reach __TAURI_INTERNALS__",
             "PASS" if blocked(reach.get("parent.__TAURI_INTERNALS__")) and blocked(reach.get("top.__TAURI_INTERNALS__")) else "FAIL",
             "parent=%s top=%s" % (reach.get("parent.__TAURI_INTERNALS__"), reach.get("top.__TAURI_INTERNALS__"))))
crit.append(("5 cannot reach the app document",
             "PASS" if blocked(reach.get("parent.document")) and blocked(reach.get("top.document")) else "FAIL",
             "parent.document=%s" % reach.get("parent.document")))
crit.append(("6 app secrets inaccessible",
             "PASS" if blocked(reach.get("parent.location.href")) else "FAIL",
             "parent.location.href=%s" % reach.get("parent.location.href")))
crit.append(("7 app cannot read the host",
             "PASS" if acr.get("contentDocument") in ("null",) or str(acr.get("contentDocument")).startswith("BLOCKED") else "FAIL",
             "contentDocument=%s locationHref=%s" % (acr.get("contentDocument"), acr.get("locationHref"))))
cs_app = assets.get("fetch.crossOrigin")
crit.append(("8 CSP enforced (connect-src blocks another origin)",
             "PASS" if (not okfetch(cs_app) and viol) else ("UNKNOWN" if not controls_ok else "FAIL"),
             "crossOrigin=%s · violations=%d" % (cs_app, len(viol))))
crit.append(("9 no book/filesystem path served",
             "PASS" if str(assets.get("fetch.refusedBookPath", "")).startswith("HTTP:404")
                    and not okfetch(assets.get("fetch.refusedTraversal")) else "FAIL",
             "book=%s traversal=%s" % (assets.get("fetch.refusedBookPath"), assets.get("fetch.refusedTraversal"))))
crit.append(("10 no channel on the host global",
             "PASS" if (h.get("channels") or {}).get("messagePortsOnGlobal") == "none" else "FAIL",
             str((h.get("channels") or {}).get("messagePortsOnGlobal"))))

say("## Verdict per Step 1 criterion")
say()
say("| criterion | verdict | evidence |")
say("|---|---|---|")
for name, verdict, ev in crit:
    icon = {"PASS": "✅", "FAIL": "❌", "UNKNOWN": "⚪"}[verdict]
    say("| %s | %s **%s** | `%s` |" % (name, icon, verdict, ev[:110]))
say()
fails = [c for c in crit if c[1] == "FAIL"]
unk = [c for c in crit if c[1] == "UNKNOWN"]
say("**%d PASS · %d FAIL · %d UNKNOWN**" % (len(crit) - len(fails) - len(unk), len(fails), len(unk)))
say()
say("> Scope: **WebKitGTK only**, this build, this handler. WKWebView and WebView2 remain UNKNOWN.")
print("\n".join(L))
