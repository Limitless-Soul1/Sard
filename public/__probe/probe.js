// PROBE-ONLY — throwaway branch. Never merged.
//
// Extraction is deliberately redundant. The previous iteration reported nothing at all and left no
// way to tell whether the page had run, so this one reports through TWO independent channels and
// reports EARLY:
//
//   • an HTTP collector the harness runs, which persists every stage as it happens and survives the
//     window dying afterwards;
//   • the Tauri command, which only works if the window is inside the capability scope.
//
// A partial result is emitted on boot, before any check runs, so "the page never executed" and "a
// check hung" can never again be the same observation.
(function () {
  "use strict";

  var COLLECT = "http://127.0.0.1:8792/report";
  var CORS = "http://127.0.0.1:8791";

  window.__SARD_SECRET__ = "library-database-handle";

  var R = {
    stage: "boot",
    appOrigin: location.origin,
    hostUrl: "sardhost://localhost/?selfcheck=1",
    appCanReadHost: {},
    hostReport: null,
    controls: {},
    windowMessages: 0,
    ipc: "untried",
    errors: []
  };

  var seq = 0;
  function emit(stage) {
    R.stage = stage;
    R.seq = ++seq;
    var body = JSON.stringify(R);
    try { document.getElementById("log").textContent = body; } catch (e) { /* ignore */ }
    // Channel 1 — the collector. Fire and forget; failures are recorded but never fatal.
    try {
      fetch(COLLECT, { method: "POST", body: body, headers: { "Content-Type": "text/plain" } })
        .then(function () { R.collector = "ok"; }, function (e) { R.collector = "FAIL:" + e.name; });
    } catch (e) { R.collector = "THREW:" + e.name; }
    // Channel 2 — the Tauri command, if this window is in scope at all.
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv) { R.ipc = "no invoke api"; return; }
      Promise.resolve(inv("probe_write", { payload: body }))
        .then(function () { R.ipc = "ok"; }, function (e) { R.ipc = "rejected:" + String(e).slice(0, 60); });
    } catch (e) { R.ipc = "threw:" + String(e).slice(0, 60); }
  }

  window.addEventListener("error", function (e) {
    R.errors.push("jserror: " + (e.message || "") + " @" + (e.filename || "") + ":" + (e.lineno || ""));
    emit("jserror");
  });
  window.addEventListener("unhandledrejection", function (e) {
    R.errors.push("unhandled: " + String(e.reason).slice(0, 120));
    emit("unhandled");
  });

  emit("boot");                      // proves the page executed, before anything can hang

  // The host reports through postMessage: its origin holds no Tauri API, by design.
  addEventListener("message", function (e) {
    var d = e.data;
    if (!d || !d.__sardProbeHost) return;
    R.windowMessages++;
    try { R.hostReport = JSON.parse(d.report); } catch (x) { R.hostReport = d.report; }
    R.hostReportOrigin = e.origin;
    emit("host-report-" + R.windowMessages);
  });

  var ifr = document.getElementById("host");
  ifr.addEventListener("load", function () { emit("host-frame-load"); });
  ifr.addEventListener("error", function () { R.errors.push("host frame error"); emit("host-frame-error"); });
  ifr.src = R.hostUrl;
  emit("host-frame-src-set");

  function control(key, p) {
    return p.then(function (v) { R.controls[key] = v; }, function (e) { R.controls[key] = "FAIL:" + e.name; })
            .then(function () { emit("control-" + key); });
  }

  // Negative controls: if the app itself cannot reach these, a refusal at the host proves nothing.
  Promise.all([
    control("app.fetchOwnOrigin", fetch("/__probe/probe.js").then(function (r) { return "OK:" + r.status; })),
    control("app.fetchCorsOrigin", fetch(CORS + "/ping").then(function (r) { return "OK:" + r.status; }))
  ]).then(function () {
    setTimeout(function () {
      try { R.appCanReadHost.contentDocument = ifr.contentDocument ? "READABLE" : "null"; }
      catch (e) { R.appCanReadHost.contentDocument = "BLOCKED:" + e.name; }
      try { R.appCanReadHost.locationHref = ifr.contentWindow.location.href; }
      catch (e) { R.appCanReadHost.locationHref = "BLOCKED:" + e.name; }
      emit("app-read-host");
    }, 3000);
  });

  // Final write happens regardless of what did or did not complete above.
  setTimeout(function () {
    emit("final");
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (inv) inv("probe_finish", { payload: JSON.stringify(R) });
    } catch (e) { /* the collector already has it */ }
  }, 16000);
})();
