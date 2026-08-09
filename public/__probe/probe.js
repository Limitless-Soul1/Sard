// PROBE-ONLY — throwaway branch. Never merged.
(function () {
  "use strict";
  var CORS = new URLSearchParams(location.search).get("cors") || "http://127.0.0.1:8791";

  // Canaries. If the host could reach these, the boundary would have failed.
  window.__SARD_SECRET__ = "library-database-handle";

  var R = {
    appOrigin: location.origin,
    hostUrl: "sardhost://localhost/?selfcheck=1",
    appCanReadHost: {},
    hostReport: null,
    controls: {},
    windowMessages: 0,
    errors: []
  };

  function log() { document.getElementById("log").textContent = JSON.stringify(R, null, 1); }

  function finish() {
    log();
    try {
      window.__TAURI_INTERNALS__.invoke("probe_finish", { payload: JSON.stringify(R) });
    } catch (e) {
      R.errors.push("invoke failed: " + e);
      log();
    }
  }

  // The host reports through postMessage because its origin holds no Tauri API — that is the design,
  // not an oversight. Recorded, not trusted: nothing here acts on it.
  addEventListener("message", function (e) {
    var d = e.data;
    if (!d || !d.__sardProbeHost) return;
    R.windowMessages++;
    try { R.hostReport = JSON.parse(d.report); } catch (x) { R.hostReport = d.report; }
    R.hostReportOrigin = e.origin;
    log();
  });

  var ifr = document.getElementById("host");
  ifr.src = R.hostUrl;

  // ---- NEGATIVE CONTROLS -------------------------------------------------------------------
  // Each mirrors something the host is expected to be refused. If the control also fails, the
  // host's failure says nothing about policy and the corresponding result must read UNKNOWN.
  function control(key, p) {
    return p.then(function (v) { R.controls[key] = v; }, function (e) { R.controls[key] = "FAIL:" + e.name; }).then(log);
  }

  Promise.all([
    // the app can reach its own origin
    control("app.fetchOwnOrigin", fetch("/__probe/probe.js").then(function (r) { return "OK:" + r.status; })),
    // the app can reach the permissive third origin — so if the HOST cannot, that is the host's policy
    control("app.fetchCorsOrigin", fetch(CORS + "/ping").then(function (r) { return "OK:" + r.status; })),
    // can the privileged app read into the host frame? it must not be able to
    new Promise(function (res) {
      setTimeout(function () {
        try { R.appCanReadHost.contentDocument = ifr.contentDocument ? "READABLE" : "null"; }
        catch (e) { R.appCanReadHost.contentDocument = "BLOCKED:" + e.name; }
        try { R.appCanReadHost.locationHref = ifr.contentWindow.location.href; }
        catch (e) { R.appCanReadHost.locationHref = "BLOCKED:" + e.name; }
        try { R.appCanReadHost.contentWindowIsObject = typeof ifr.contentWindow; }
        catch (e) { R.appCanReadHost.contentWindowIsObject = "BLOCKED:" + e.name; }
        res();
      }, 4000);
    })
  ]).then(function () {
    // give the host time to finish its own async checks and report
    setTimeout(finish, 9000);
  });

  log();
})();
