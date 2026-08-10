// The reader host, step 1.
//
// The origin exists and carries its policy; nothing reads a book here yet. The engine, the byte
// transfer, the section sandbox change and the message channel are later steps, each with its own
// evidence gate, and none of them is present.
//
// `?selfcheck=1` runs the acceptance checks for this step and writes them into #report. Without it
// the document is inert, so the checks are a deliberate act rather than something that runs behind
// a reader every time a book opens.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  if (params.get("selfcheck") !== "1") return;

  var R = {
    origin: location.origin,
    href: location.href,
    // A book section will eventually live here; right now the only thing to record is that this
    // document itself cannot see the application.
    reach: {},
    assets: {},
    cspViolations: [],
    channels: {}
  };

  // A CSP refusal raises this; a CORS or same-origin-policy refusal does not. It is the only way to
  // name which layer said no, and the previous study was retracted for guessing.
  addEventListener("securitypolicyviolation", function (e) {
    R.cspViolations.push({
      directive: e.violatedDirective,
      blocked: String(e.blockedURI).slice(0, 120)
    });
    write();
  });

  // The report element is created here and hung off documentElement, not body. The engine owns the
  // body — `FoliateController.open` calls `container.replaceChildren` and the host hands it a
  // container it just put there — so a node parked in the body would vanish the moment a book
  // opened, taking the evidence with it. Kept 1px and pointer-events:none because an earlier probe
  // used a large off-screen element and it silently swallowed the very clicks being measured.
  function report() {
    var el = document.getElementById("report");
    if (!el || !el.isConnected) {
      el = document.createElement("pre");
      el.id = "report";
      el.setAttribute(
        "style",
        "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;" +
          "pointer-events:none;opacity:0;white-space:pre;margin:0;z-index:-1",
      );
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function write() {
    report().textContent = JSON.stringify(R, null, 1);
  }

  function attempt(name, fn) {
    try {
      var v = fn();
      R.reach[name] = v === undefined ? "undefined" : "REACHED:" + (typeof v);
    } catch (e) {
      R.reach[name] = "BLOCKED:" + (e && e.name ? e.name : "Error");
    }
  }

  // What can this origin see of the application that embeds it? Everything here must be refused.
  attempt("parent.__TAURI_INTERNALS__", function () { return window.parent.__TAURI_INTERNALS__; });
  attempt("top.__TAURI_INTERNALS__", function () { return window.top.__TAURI_INTERNALS__; });
  attempt("parent.document", function () { return window.parent.document; });
  attempt("top.document", function () { return window.top.document; });
  attempt("parent.location.href", function () { return window.parent.location.href; });
  attempt("window.__TAURI_INTERNALS__ (own)", function () { return window.__TAURI_INTERNALS__; });
  attempt("window.__TAURI__ (own)", function () { return window.__TAURI__; });

  // No channel is created in this step, and none should exist. Recorded so that the absence is a
  // measured fact rather than an assumption, and so a later step cannot quietly introduce one.
  R.channels.messagePortsOnGlobal = (function () {
    var hits = [];
    for (var k in window) {
      try { if (window[k] instanceof MessagePort) hits.push(k); } catch (e) { /* ignore */ }
    }
    return hits.length ? hits.join(",") : "none";
  })();
  R.channels.opener = window.opener ? "PRESENT" : "null";

  write();

  function record(key, promise) {
    return promise.then(
      function (v) { R.assets[key] = v; },
      function (e) { R.assets[key] = "FAIL:" + (e && e.name ? e.name : "Error"); }
    ).then(write);
  }

  // The assets this origin must be able to serve, checked against the real handler.
  var font = "/fonts/Amiri-Regular.ttf";
  var cmap = "/pdfjs/cmaps/UniJIS-UCS2-H.bcmap";

  Promise.all([
    record("fetch.font", fetch(font).then(function (r) {
      return r.ok ? r.arrayBuffer().then(function (b) { return "OK:" + r.status + " bytes=" + b.byteLength; })
                  : "HTTP:" + r.status;
    })),
    record("fetch.pdfjsCmap", fetch(cmap).then(function (r) {
      return r.ok ? r.arrayBuffer().then(function (b) { return "OK:" + r.status + " bytes=" + b.byteLength; })
                  : "HTTP:" + r.status;
    })),
    record("fetch.pdfjsWorker", fetch("/pdfjs/pdf.worker.mjs").then(function (r) { return "OK:" + r.status; })),
    // Must be refused: this origin has no route to a book, by construction.
    record("fetch.refusedBookPath", fetch("/library/book.epub").then(function (r) { return "HTTP:" + r.status; })),
    record("fetch.refusedTraversal", fetch("/fonts/../../sard.db").then(function (r) { return "HTTP:" + r.status; })),
    // Must be refused by connect-src: a different origin.
    record("fetch.crossOrigin", fetch("http://127.0.0.1:9/none").then(function (r) { return "OK:" + r.status; })),

    // Whether the font is merely FETCHABLE or actually USABLE as a face are different questions.
    // `connect-src 'self'` governs the first; `font-src` governs the second, and this policy sets
    // no `font-src`, so it falls back to `default-src 'none'`. Measured rather than predicted.
    (function () {
      if (!("FontFace" in window)) { R.assets["fontFace.load"] = "UNKNOWN:no FontFace API"; return Promise.resolve(); }
      var face = new FontFace("SardHostProbe", "url(" + font + ")");
      return face.load().then(
        function () { R.assets["fontFace.load"] = "LOADED"; },
        function (e) { R.assets["fontFace.load"] = "FAIL:" + (e && e.name ? e.name : "Error"); }
      ).then(write);
    })()
  ]).then(function () {
    R.done = true;
    write();
  });

  // -------------------------------------------------------------------------------------------
  // THE MEASUREMENT THIS WHOLE ARCHITECTURE EXISTS FOR.
  // -------------------------------------------------------------------------------------------
  // The defect: on WebKitGTK an iframe sandboxed `allow-same-origin` WITHOUT `allow-scripts` never
  // delivers pointer events to listeners the parent attached across the frame boundary. That is the
  // exact shape of every listener the engine uses, so the book renders and nothing responds.
  //
  // This listens the same way the engine does — `iframe.contentDocument.addEventListener` from the
  // parent document — and counts what arrives. It proves nothing on its own: a count only means
  // something when something real was clicked, so the harness drives a genuine X11 click with
  // xdotool and reads these counters afterwards. A synthetic dispatchEvent would prove nothing at
  // all, because the bug is in DELIVERY, not in dispatch.
  R.input = { sandbox: null, docsInstrumented: 0, pointerdown: 0, mousedown: 0, click: 0, selectionchange: 0 };

  var seen = new WeakSet();
  function instrument(doc) {
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    R.input.docsInstrumented++;
    ["pointerdown", "mousedown", "click"].forEach(function (type) {
      doc.addEventListener(type, function () { R.input[type]++; write(); }, true);
    });
    doc.addEventListener("selectionchange", function () { R.input.selectionchange++; write(); }, true);
    write();
  }

  // Every section gets its own iframe and the engine replaces them as the reader moves, so this
  // re-scans rather than instrumenting once. An earlier probe attached to the first document only
  // and then measured a different one.
  setInterval(function () {
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (R.input.sandbox === null && f.getAttribute("sandbox") !== null) {
        R.input.sandbox = f.getAttribute("sandbox"); // what patch 1b actually produced here
        write();
      }
      try { instrument(f.contentDocument); } catch (e) { /* not readable yet */ }
    }
  }, 250);
})();
