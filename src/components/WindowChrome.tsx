// THE WINDOW'S OWN FRAME — the title bar Sard draws in place of the operating system's.
//
// WHAT IT REPLACES. On Windows the native caption was painted black by `window_chrome.rs` so it would
// not clash with the paper below it; it never belonged to the application, and its three controls were
// the system's. The window is now created undecorated (`decorations: false`, tauri.conf.json), the OS
// keeps drawing the shadow and answering the resize borders, and this component draws the strip at the
// top: the three window controls at the right — where every window on the desktop keeps them,
// whichever way the interface reads — and nothing else. It is the same material as the surface under
// it (global.css, "the window's own frame"): the Library runs up under it, so the frame is the top of
// the Library's own picture seen through the sidebar's tint and frost, one mat with the sidebar
// rather than a strip above it; no mark, because the sidebar's brand row sits directly beneath.
//
// THE NATIVE WINDOW STAYS THE SOURCE OF TRUTH. Nothing here decides whether the window is maximized;
// the button asks the window to toggle and the icon follows what the window reports. The report is
// refreshed on every `resize` event the window emits — which a maximize, a restore, a double-click on
// the bar, a taskbar action and a Win+Arrow all produce — so there is no polling and no state of our
// own that could drift from the window's. Dragging and the double-click are Tauri's own drag-region
// behaviour (`data-tauri-drag-region="deep"`): every element in the bar drags the window except the
// buttons, which the drag script excludes because they are buttons.
//
// The bar is 32 CSS px tall and the surfaces that fill the window start below it (`--sard-titlebar`,
// global.css); on a window the OS decorates it renders nothing and sets nothing, so every other
// platform is exactly as it was. In fullscreen the bar withdraws, as a native caption would.
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "./Icon";
import { frameShown } from "./windowChromeState";
import { useI18n } from "../i18n";
import { showWindowMenu } from "../lib/ipc";

const win = () => getCurrentWindow();

export function WindowChrome() {
  const { t } = useI18n();
  // null until the window has answered: nothing is drawn and nothing is offset before then
  const [decorated, setDecorated] = useState<boolean | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const w = win();
    let alive = true;
    const unlisteners: Array<() => void> = [];
    // the window's report, taken whenever its geometry changes and once at the start
    const refresh = () =>
      Promise.all([w.isMaximized(), w.isFullscreen()])
        .then(([m, f]) => { if (alive) { setMaximized(m); setFullscreen(f); } })
        .catch(() => {});
    w.isDecorated()
      .then((decorated) => {
        if (!alive) return;
        setDecorated(decorated);
        if (decorated) return;
        void refresh();
        return Promise.all([
          w.onResized(() => { void refresh(); }),
          w.onFocusChanged(({ payload }) => { if (alive) setFocused(payload); }),
          // A fullscreen exit that lands on a maximized window changes no client size and so emits
          // no resize; the command that made the change says so instead (window_chrome.rs).
          listen("sard://window-state", () => { void refresh(); }),
        ]).then((us) => { if (alive) unlisteners.push(...us); else us.forEach((u) => u()); });
      })
      .catch(() => { if (alive) setDecorated(true); });
    return () => { alive = false; unlisteners.forEach((u) => u()); };
  }, []);

  // The surfaces below read this attribute to start under the bar; it is withdrawn in fullscreen, when
  // there is no bar, so that they fill the screen exactly as they did before this existed.
  const shown = frameShown({ decorated, fullscreen });
  useEffect(() => {
    const el = document.documentElement;
    if (shown) el.setAttribute("data-chrome", "sard");
    else el.removeAttribute("data-chrome");
    return () => el.removeAttribute("data-chrome");
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      className="wc"
      data-tauri-drag-region="deep"
      data-focused={focused ? "true" : "false"}
      // A right-click on a caption shows the window menu; the page's own menu has no business here.
      onContextMenu={(e) => {
        e.preventDefault();
        void showWindowMenu(Math.round(e.screenX * window.devicePixelRatio), Math.round(e.screenY * window.devicePixelRatio)).catch(() => {});
      }}
    >
      <div className="wc-controls">
        <button type="button" className="wc-btn" aria-label={t("window.minimize")} title={t("window.minimize")} onClick={() => { void win().minimize(); }}>
          <Icon name="windowMinimize" size="md" />
        </button>
        <button
          type="button"
          className="wc-btn"
          aria-label={maximized ? t("window.restore") : t("window.maximize")}
          title={maximized ? t("window.restore") : t("window.maximize")}
          onClick={() => { void win().toggleMaximize(); }}
        >
          <Icon name={maximized ? "windowRestore" : "windowMaximize"} size="md" />
        </button>
        {/* Close goes through the same request the native ✕ raised, so the page's own close handler
            (App.tsx — the reading position is saved first) runs exactly as before. */}
        <button type="button" className="wc-btn wc-close" aria-label={t("window.close")} title={t("window.close")} onClick={() => { void win().close(); }}>
          <Icon name="windowClose" size="md" />
        </button>
      </div>
    </div>
  );
}
