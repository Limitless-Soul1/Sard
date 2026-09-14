// The reader host's boundary self-check.
//
// It measures, from INSIDE this origin, what this origin can actually reach — the one thing no
// outside observer can establish, because every interesting answer here is a SecurityError that only
// the code holding the reference can raise.
//
// It exists as shipped code, rather than as something a throwaway branch bolts on, because these
// properties have to stay re-measurable against the REAL host after every change. A boundary proven
// once against a special build is a boundary nobody can re-check.
//
// Inert without `?selfcheck=1`: a normal reader open runs none of it. It is absent from Windows
// entirely — `scripts/build-reader-host.mjs` deletes this whole directory for that target, because
// no origin is registered there to serve it.
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
  R.overlay = null;
  R.rendered = null;
  R.input = { sandbox: null, docsInstrumented: 0, pointerdown: 0, mousedown: 0, click: 0, selectionchange: 0 };

  // THE POSITIVE CONTROL, and the run that lacked it is why it is here.
  //
  // A count of zero in the section has two completely different meanings: the engine difference this
  // architecture exists to fix, or a click that never landed on the window at all. Only a second
  // counter can separate them. This one is on the HOST's own document — the same window, the same
  // click, one frame boundary nearer. If this is zero too, the harness missed and the section result
  // says nothing; if this is non-zero and the section is zero, the gap is real and it is between
  // these two documents.
  R.hostInput = { pointerdown: 0, mousedown: 0, click: 0 };
  ["pointerdown", "mousedown", "click"].forEach(function (type) {
    document.addEventListener(type, function () { R.hostInput[type]++; write(); }, true);
  });

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

  // FINDING THE SECTION DOCUMENT.
  //
  // Not with `document.querySelectorAll("iframe")`. The paginator builds its iframe inside a CLOSED
  // shadow root (`attachShadow({mode:'closed'})`), so from this document that iframe does not exist
  // — a scan finds nothing and reports zero instrumented documents, which reads exactly like "input
  // never arrived" while actually meaning "nobody was listening".
  //
  // The engine's own API is the way in: `foliate-view` → `renderer.getContents()` → `.doc`, which is
  // how anything outside the shadow root reaches a rendered section. From the document,
  // `defaultView.frameElement` reaches back out to the iframe element, which is how the sandbox
  // attribute that patch 1b produced can be read at all.
  //
  // Re-scanned rather than instrumented once: every section gets its own iframe and the engine
  // replaces them as the reader moves. An earlier probe attached to the first document only and then
  // measured a different one.
  setInterval(function () {
    var view = document.querySelector("foliate-view");
    if (!view || !view.renderer || typeof view.renderer.getContents !== "function") return;
    var contents;
    try { contents = view.renderer.getContents() || []; } catch (e) { return; }
    for (var i = 0; i < contents.length; i++) {
      var doc = contents[i] && contents[i].doc;
      if (!doc) continue;
      if (R.input.sandbox === null) {
        try {
          var fe = doc.defaultView && doc.defaultView.frameElement;
          if (fe) { R.input.sandbox = fe.getAttribute("sandbox"); write(); }
        } catch (e) { /* frameElement across the boundary */ }
      }
      instrument(doc);

      // WHAT IS ACTUALLY DRAWN.
      //
      // A highlight crossing the transport and a highlight APPEARING are different claims, and only
      // the second one is what a reader sees. foliate draws marks as SVG in the overlayer, so the
      // shapes are countable and measurable: a mark that resolved to no geometry produces no rect,
      // and a CFI that pointed nowhere would look exactly like a working transport.
      try {
        var ov = contents[i] && contents[i].overlayer;
        var svg = ov && ov.element;
        if (svg) {
          var shapes = svg.querySelectorAll("rect, path, polygon");
          var painted = 0;
          var area = 0;
          for (var s = 0; s < shapes.length; s++) {
            var box = shapes[s].getBoundingClientRect();
            if (box.width > 0 && box.height > 0) { painted++; area += box.width * box.height; }
          }
          R.overlay = {
            shapes: shapes.length,
            painted: painted,
            areaPx: Math.round(area),
            fills: (function () {
              var out = [];
              for (var f = 0; f < shapes.length && f < 6; f++) {
                out.push(shapes[f].getAttribute("fill") || shapes[f].style.fill || "none");
              }
              return out.join(",");
            })(),
          };
          write();
        }
      } catch (e) { /* no overlayer yet */ }

      // The PDF page is drawn to a canvas and copied to an <img> (VENDOR patch 4). Its presence and
      // size are the only proof the fixed-layout path rendered anything at all.
      try {
        var imgs = doc.querySelectorAll("img, canvas");
        var big = 0;
        for (var k = 0; k < imgs.length; k++) {
          var r = imgs[k].getBoundingClientRect();
          if (r.width > 50 && r.height > 50) big++;
        }
        if (imgs.length) { R.rendered = { imgOrCanvas: imgs.length, sized: big }; write(); }
      } catch (e) { /* ignore */ }
    }
  }, 250);
})();
