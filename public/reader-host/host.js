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

  function write() {
    document.getElementById("report").textContent = JSON.stringify(R, null, 1);
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
})();

// ---------------------------------------------------------------------------------------------
// PROBE-ONLY REPORTER — exists only on the throwaway probe branch and is never merged.
//
// The host origin holds no Tauri API by design, so an embedded host has no way to report except
// postMessage. This block is that reporter and nothing else: it sends, it never listens, and it is
// the reason criterion 10 is verified against the PRODUCTION file rather than this copy.
// ---------------------------------------------------------------------------------------------
(function () {
  "use strict";
  if (new URLSearchParams(location.search).get("selfcheck") !== "1") return;
  if (window.parent === window) return;                       // top-level: nothing to report to
  var sent = 0;
  setInterval(function () {
    var el = document.getElementById("report");
    if (!el || !el.textContent) return;
    if (sent++ > 60) return;
    window.parent.postMessage({ __sardProbeHost: true, report: el.textContent }, "*");
  }, 300);
})();
