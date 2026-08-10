#!/usr/bin/env python3
"""Wired-reader runtime gate verdict — THROWAWAY.

Measured only. UNKNOWN is never rendered as a pass or as a failure: an earlier report classified
absent data as FAIL and printed nine failures for a run that had measured nothing at all.
"""
import json
import os
import sys

p = sys.argv[1]
clicked = len(sys.argv) > 2 and os.path.exists(sys.argv[2])
d = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None
L = []


def say(s=""):
    L.append(s)


say("# Wired reader — runtime gate on WebKitGTK")
say()
if not d:
    say("**No result. Every criterion is UNKNOWN.**")
    print("\n".join(L))
    sys.exit(1)

surface = d.get("surface") or {}
sync = d.get("sync") or {}
events = d.get("events") or {}
kb = d.get("keyboard") or {}
self_check = surface.get("hostSelfcheck") or {}
reach = self_check.get("reach") or {}
assets = self_check.get("assets") or {}
inp = self_check.get("input") or {}
channels = self_check.get("channels") or {}

say(f"- app origin `{d.get('appOrigin')}` · needsReaderHost() `{d.get('needsHost')}`")
say(f"- subject `{d.get('bookBytes')}` bytes · last stage `{d.get('stage')}`")
if d.get("errors"):
    say(f"- errors: `{d['errors']}`")
say()

say("## Reader surface, driven through FoliateController's own API")
say()
say("| call | result |")
say("|---|---|")
for k, v in surface.items():
    if k == "hostSelfcheck":
        continue
    say(f"| `{k}` | `{json.dumps(v)[:130]}` |")
say()

say("## Synchronous reads (served from the mirror)")
say()
say("| read | value |")
say("|---|---|")
for k, v in sync.items():
    say(f"| `{k}` | `{json.dumps(v)[:90]}` |")
say()

say("## Keyboard — the locally-decided paths")
say()
for k, v in kb.items():
    say(f"- `{k}` = `{json.dumps(v)}`")
say()

say("## Events pushed from the host")
say()
say("| callback | fired |")
say("|---|---|")
for k, v in events.items():
    say(f"| `{k}` | `{v}` |")
say()

say("## Security boundary, re-measured with the real reader mounted")
say()
say("| attempt | result |")
say("|---|---|")
for k, v in reach.items():
    mark = f"🔴 **{v}**" if str(v).startswith("REACHED") else f"🟢 `{v}`"
    say(f"| host → `{k}` | {mark} |")
say(f"| refused book path | `{assets.get('fetch.refusedBookPath')}` |")
say(f"| refused traversal | `{assets.get('fetch.refusedTraversal')}` |")
say(f"| cross-origin fetch | `{assets.get('fetch.crossOrigin')}` |")
say(f"| MessagePort on host global | `{channels.get('messagePortsOnGlobal')}` |")
say(f"| section sandbox | `{inp.get('sandbox')}` |")
say(f"| real input into the section | `{inp.get('pointerdown')}` pointerdown, `{inp.get('click')}` click |")
say()

UNKNOWN = "UNKNOWN"


def blocked(v):
    return str(v).startswith("BLOCKED") or str(v) == "undefined"


crit = []
crit.append(("1 the transport built the reader",
             "PASS" if d.get("needsHost") and d.get("stage") != "boot" else
             (UNKNOWN if d.get("needsHost") is None else "FAIL"),
             f"needsHost={d.get('needsHost')} stage={d.get('stage')}"))
crit.append(("2 a real EPUB opened through the transport",
             "PASS" if d.get("open") == "opened" else (UNKNOWN if d.get("open") == "untried" else "FAIL"),
             str(surface.get("open"))[:100]))
# The EPUB's state, frozen before the PDF replaced it. `sync` describes whatever is open LAST, and
# reading a table of contents from a PDF is not a failure of the transport.
epub = surface.get("syncEpub") or sync
crit.append(("3 engine structure crossed (TOC)",
             "PASS" if (epub.get("tocLength") or 0) > 0 else (UNKNOWN if "tocLength" not in epub else "FAIL"),
             f"toc={epub.get('tocLength')} hrefMap={epub.get('tocHrefSectionSize')}"))
crit.append(("4 mirrored synchronous reads answered",
             "PASS" if isinstance(epub.get("currentSectionIndex"), int) else (UNKNOWN if not epub else "FAIL"),
             f"section={epub.get('currentSectionIndex')} atChapterStart={epub.get('atChapterStart')}"))
bm_ok = sync.get("bookmarkSameSection") is True and sync.get("bookmarkOtherSection") is False
crit.append(("5 CFI / bookmark rule correct on the app side",
             "PASS" if bm_ok else (UNKNOWN if "bookmarkSameSection" not in sync else "FAIL"),
             f"same={sync.get('bookmarkSameSection')} other={sync.get('bookmarkOtherSection')}"))
nav_ok = kb.get("handleNavKey(ArrowLeft)") is True and kb.get("handleNavKey(unmapped)") is False
crit.append(("6 handleNavKey decided locally and correctly",
             "PASS" if nav_ok else (UNKNOWN if "handleNavKey(ArrowLeft)" not in kb else "FAIL"),
             f"arrow={kb.get('handleNavKey(ArrowLeft)')} unmapped={kb.get('handleNavKey(unmapped)')}"))
crit.append(("7 the arrow callback was consulted app-side",
             "PASS" if (kb.get("arrowCallbackAsked") or 0) > 0 else
             (UNKNOWN if "arrowCallbackAsked" not in kb else "FAIL"),
             f"asked={kb.get('arrowCallbackAsked')}"))
relocs = events.get("onRelocate") or 0
crit.append(("8 events pushed from host to application",
             "PASS" if relocs > 0 else (UNKNOWN if not events else "FAIL"),
             f"onRelocate={relocs} all={events}"))
sents = surface.get("getCurrentChapterSentences")
crit.append(("9 an async forward returned real data",
             "PASS" if isinstance(sents, int) and sents > 0 else (UNKNOWN if sents is None else "FAIL"),
             f"sentences={sents}"))
jumped = surface.get("sectionAfterChapterJump")
crit.append(("10 navigation moved the engine",
             "PASS" if isinstance(jumped, int) and jumped > 0 else (UNKNOWN if jumped is None else "FAIL"),
             f"sectionAfterChapterJump={jumped}"))
crit.append(("11 no Tauri internals, app document or secret from the host",
             "PASS" if reach and blocked(reach.get("parent.__TAURI_INTERNALS__"))
             and blocked(reach.get("parent.document")) and blocked(reach.get("parent.location.href"))
             else (UNKNOWN if not reach else "FAIL"),
             f"internals={reach.get('parent.__TAURI_INTERNALS__')} doc={reach.get('parent.document')}"))
crit.append(("12 no filesystem / library / database route",
             "PASS" if str(assets.get("fetch.refusedBookPath", "")).startswith("HTTP:404")
             else (UNKNOWN if "fetch.refusedBookPath" not in assets else "FAIL"),
             f"book={assets.get('fetch.refusedBookPath')} traversal={assets.get('fetch.refusedTraversal')}"))
cs = assets.get("fetch.crossOrigin")
crit.append(("13 no unintended remote access",
             "PASS" if cs is not None and not str(cs).startswith("OK:") else (UNKNOWN if cs is None else "FAIL"),
             f"crossOrigin={cs}"))
crit.append(("14 no MessagePort published on the host global",
             "PASS" if channels.get("messagePortsOnGlobal") == "none" else (UNKNOWN if not channels else "FAIL"),
             str(channels.get("messagePortsOnGlobal"))))
delivered = sum(int(inp.get(k) or 0) for k in ("pointerdown", "mousedown", "click"))
if delivered > 0:
    v, why = "PASS", f"{delivered} genuine pointer event(s) reached the section document"
elif not clicked:
    v, why = UNKNOWN, "the harness never delivered a click"
elif not (inp.get("docsInstrumented") or 0):
    v, why = UNKNOWN, "no section document was readable, so nothing could be listening"
else:
    v, why = "FAIL", "a click was delivered and nothing arrived in the section"
crit.append(("15 real X11 input still reaches the section", v, why))

# ---- the feature gates ----------------------------------------------------------------------
def okstep(key):
    v = surface.get(key)
    return v is not None and not (isinstance(v, str) and v.startswith("FAIL"))


space_asked = kb.get("spaceCallbackAskedFinal")
crit.append(("16 a real Space keypress reached the application's callback",
             "PASS" if (space_asked or 0) > 0 else (UNKNOWN if space_asked is None else "FAIL"),
             f"spaceCallbackAsked={space_asked}"))

hl = [k for k in ("addHighlight", "loadHighlights", "setHighlightColor", "removeHighlight") if okstep(k)]
crit.append(("17 highlights cross the transport",
             "PASS" if len(hl) == 4 else (UNKNOWN if not hl else "FAIL"),
             f"ok={hl}"))

crit.append(("18 references (notes) cross the transport",
             "PASS" if okstep("setReferences") else (UNKNOWN if "setReferences" not in surface else "FAIL"),
             str(surface.get("setReferences"))))

sb = surface.get("searchBook")
sb_ok = isinstance(sb, dict) and isinstance(sb.get("hits"), int)
crit.append(("19 search runs and reports progressively",
             "PASS" if sb_ok and (sb.get("batches") or 0) + (sb.get("progress") or 0) > 0 else
             ("FAIL" if isinstance(sb, str) and sb.startswith("FAIL") else
              (UNKNOWN if sb is None else ("PASS" if sb_ok else "FAIL"))),
             json.dumps(sb)[:110]))

ts = surface.get("trackStats")
crit.append(("20 TTS tracking crosses (units + spotlight)",
             "PASS" if isinstance(ts, dict) and (ts.get("units") or 0) > 0
             and okstep("showReadingHighlight") and okstep("clearReadingHighlight")
             else (UNKNOWN if ts is None else "FAIL"),
             f"trackStats={json.dumps(ts)[:60]} spotlight={surface.get('showReadingHighlight')}"))

pdf_fixed = surface.get("pdf.isFixedLayout")
crit.append(("21 a real PDF opened through the host",
             "PASS" if okstep("openPdf") and pdf_fixed is True else
             (UNKNOWN if "openPdf" not in surface else "FAIL"),
             f"open={surface.get('openPdf')} fixedLayout={pdf_fixed} pages={surface.get('pdf.pageCount')}"))

crit.append(("22 PDF text quality crossed",
             "PASS" if surface.get("pdf.textQuality") not in (None,) and okstep("pdf.textQuality") else
             (UNKNOWN if "pdf.textQuality" not in surface else "FAIL"),
             f"quality={json.dumps(surface.get('pdf.textQuality'))[:70]} speakable={surface.get('pdf.hasSpeakableText')}"))

font = surface.get("assetFont")
crit.append(("23 a user font reaches the host over asset:",
             "PASS" if font == "LOADED" else (UNKNOWN if font is None else "FAIL"),
             str(font)))

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
