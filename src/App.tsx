import { useEffect, useState } from "react";
import "./styles/global.css";
import {
  appInfo,
  dbHealth,
  settingsGet,
  settingsSet,
  type AppInfo,
  type DbHealth,
} from "./lib/ipc";

// RAWY-08: dev-only probe that exercises the Rust core IPC seam end-to-end
// (app_info + db_health + a settings round-trip). TEMPORARY — remove once a real
// UI exists. The shell itself is still the empty الراوي placeholder.
function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [health, setHealth] = useState<DbHealth | null>(null);
  const [probe, setProbe] = useState("…");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setInfo(await appInfo());
        setHealth(await dbHealth());
        await settingsSet("dev_probe", "hello");
        const v = await settingsGet("dev_probe");
        setProbe(
          `settings_set('dev_probe','hello') → settings_get → ${JSON.stringify(v)} ${
            v === "hello" ? "✓ PASS" : "✗ FAIL"
          }`,
        );
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  return (
    <main className="erawy-shell" dir="rtl">
      <div>
        <h1 className="erawy-wordmark">الرَّاوِي</h1>
        <p className="erawy-tagline">
          eRawy — <span className="erawy-accent">the storyteller</span>
        </p>
        <pre className="erawy-devprobe" dir="ltr">
          {error
            ? `ERROR: ${error}`
            : [
                `app_data_dir : ${info?.app_data_dir ?? "…"}`,
                `db_path      : ${info?.db_path ?? "…"}`,
                `schema       : v${info?.schema_version ?? "…"}`,
                `db_health.ok : ${String(health?.ok ?? "…")}`,
                `tables (${health?.tables.length ?? 0}) : ${health?.tables.join(", ") ?? "…"}`,
                probe,
              ].join("\n")}
        </pre>
      </div>
    </main>
  );
}

export default App;
