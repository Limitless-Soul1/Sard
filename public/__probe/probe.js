// PROBE-ONLY — throwaway branch. Never merged.
//
// The runtime gate for the mounted reader host. This page is the PRIVILEGED application origin; it
// mounts the real `sardhost:` origin, hands it a real EPUB, and measures from both sides at once.
//
// Extraction is redundant on purpose. An earlier iteration reported nothing at all and left no way
// to tell a dead renderer from a silent script, so every stage is posted to an HTTP collector as it
// happens and the first one is emitted before any check can hang.
(function () {
  "use strict";

  var COLLECT = "http://127.0.0.1:8792/report";

  window.__SARD_SECRET__ = "library-database-handle";

  var R = {
    stage: "boot",
    appOrigin: location.origin,
    hostUrl: "sardhost://localhost/?selfcheck=1",
    hostReady: false,
    handshake: "untried",
    book: { bytes: 0 },
    cmd: {},          // what the transport answered
    state: {},        // engine state, before and after input
    hostReport: null, // what the host measured about itself
    appCanReadHost: {},
    errors: []
  };

  var seq = 0;
  function emit(stage) {
    R.stage = stage;
    R.seq = ++seq;
    var body = JSON.stringify(R);
    try {
      fetch(COLLECT, { method: "POST", body: body, headers: { "Content-Type": "text/plain" } })
        .then(function () { R.collector = "ok"; }, function (e) { R.collector = "FAIL:" + e.name; });
    } catch (e) { R.collector = "THREW:" + e.name; }
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (inv) Promise.resolve(inv("probe_write", { payload: body })).then(null, function () {});
    } catch (e) { /* the collector already has it */ }
  }

  window.addEventListener("error", function (e) {
    R.errors.push("jserror: " + (e.message || "") + " @" + (e.filename || "") + ":" + (e.lineno || ""));
    emit("jserror");
  });
  window.addEventListener("unhandledrejection", function (e) {
    R.errors.push("unhandled: " + String(e.reason).slice(0, 160));
    emit("unhandled");
  });

  emit("boot");

  // The host's own self-check reports by postMessage: its origin holds no Tauri API, by design.
  addEventListener("message", function (e) {
    var d = e.data;
    if (!d) return;
    if (d.__sardProbeHost) {
      try { R.hostReport = JSON.parse(d.report); } catch (x) { R.hostReport = d.report; }
      R.hostReportOrigin = e.origin;
      return; // too frequent to emit on; the final write carries it
    }
    if (d.__sardHostReady) {
      R.hostReady = true;
      R.hostReadyOrigin = e.origin;
      emit("host-ready");
      handshake();
    }
  });

  var ifr = document.getElementById("host");
  ifr.addEventListener("load", function () { emit("host-frame-load"); });
  ifr.addEventListener("error", function () { R.errors.push("host frame error"); emit("host-frame-error"); });
  ifr.src = R.hostUrl;
  emit("host-frame-src-set");

  // ---------------------------------------------------------------------------------------------
  // The transport: a MessagePort the host keeps in a closure and never publishes.
  // ---------------------------------------------------------------------------------------------
  var port = null;
  var nextId = 1;
  var pending = {};

  function send(msg, transfer) {
    return new Promise(function (resolve, reject) {
      if (!port) return reject(new Error("no port"));
      msg.id = nextId++;
      pending[msg.id] = { resolve: resolve, reject: reject };
      port.postMessage(msg, transfer || []);
      setTimeout(function () {
        if (pending[msg.id]) { delete pending[msg.id]; reject(new Error("timeout: " + msg.cmd)); }
      }, 60000);
    });
  }

  function handshake() {
    var ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = function (e) {
      var d = e.data;
      if (d && d.id === 0) { R.handshake = "acked:" + JSON.stringify(d.value); emit("handshake-ack"); return; }
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.ok) p.resolve(d.value); else p.reject(new Error(d.error));
    };
    port.start();
    ifr.contentWindow.postMessage({ __sardHostInit: true }, "*", [ch.port2]);
    R.handshake = "sent";
    emit("handshake-sent");
    void drive();
  }

  function step(name, p) {
    return p.then(
      function (v) { R.cmd[name] = v; emit("cmd-" + name); return v; },
      function (e) { R.cmd[name] = "FAIL:" + e.message; emit("cmd-" + name); throw e; }
    );
  }

  async function drive() {
    try {
      // A REAL book, bundled into the application origin. `connect-src 'self'` allows this fetch
      // here; the host could not perform it, which is the point of transferring the bytes instead.
      var res = await fetch("/__probe/book.epub");
      var buf = await res.arrayBuffer();
      R.book.bytes = buf.byteLength;
      emit("book-fetched");

      await step("open", send({ cmd: "open", bytes: buf, opts: {
        style: { fontSizePx: 20, lineHeight: 1.8, marginPct: 6, fontFamily: "serif", justify: true },
        flow: "paged"
      } }, [buf]));

      R.state.afterOpen = await step("state.afterOpen", send({ cmd: "state" }));

      // Pagination through the engine's own navigation entry point.
      await step("navKey.1", send({ cmd: "navKey", key: "ArrowLeft" }));
      await step("navKey.2", send({ cmd: "navKey", key: "ArrowLeft" }));
      R.state.afterNav = await step("state.afterNav", send({ cmd: "state" }));

      // Ready for the harness to deliver a genuine X11 click. The title is how the shell knows the
      // book is on screen and the counters are armed; nothing else in this run depends on it.
      R.readyForClick = true;
      emit("ready-for-click");

      setTimeout(async function () {
        try { R.state.afterClick = await send({ cmd: "state" }); } catch (e) { R.state.afterClick = "FAIL:" + e.message; }
        try { R.appCanReadHost.contentDocument = ifr.contentDocument ? "READABLE" : "null"; }
        catch (e) { R.appCanReadHost.contentDocument = "BLOCKED:" + e.name; }
        try { R.appCanReadHost.locationHref = ifr.contentWindow.location.href; }
        catch (e) { R.appCanReadHost.locationHref = "BLOCKED:" + e.name; }
        emit("final");
        try {
          var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
          if (inv) inv("probe_finish", { payload: JSON.stringify(R) });
        } catch (e) { /* the collector has it */ }
      }, 22000);
    } catch (e) {
      R.errors.push("drive: " + String(e && e.message ? e.message : e));
      emit("drive-failed");
    }
  }
})();
