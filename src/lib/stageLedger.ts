// A STAGE LEDGER — the shared machinery behind every pipeline diagnostic. OBSERVATION ONLY.
//
// The idea that makes these reports useful: every stage of a pipeline is declared UP FRONT, so a
// stage that never ran is reported as NOT ENTERED rather than simply being absent. Absence of
// evidence and evidence of absence are different things, and a timeline alone only gives the first.
//
// This was written for the PDF pipeline and is now shared with the EPUB rendering pipeline, so both
// print identically and a reader who has learned one ledger can read the other. Two rules are
// encoded here because both were learned from real false alarms:
//
//   - NOT OBSERVABLE is not FAILED. An early version reported "stage 13 FAILED" while the PDF was
//     visibly on screen, simply because we had no hook into it. A diagnostic that cries wolf on a
//     healthy machine is worse than none.
//   - A stage marked ENTERED but never completed prints "execution stopped here", which is the single
//     most valuable line in the report — it is the point where the pipeline died.
export type StageState = "NOT ENTERED" | "ENTERED" | "COMPLETED" | "FAILED" | "NOT OBSERVABLE";

export interface Stage {
  id: number;
  key: string;
  title: string;
  state: StageState;
  enteredAt: number | null;
  endedAt: number | null;
  meta: Record<string, unknown>;
  error: { name: string; message: string; stack: string; raw: string } | null;
}

export interface Ledger {
  reset(): void;
  enter(key: string, meta?: Record<string, unknown>): void;
  ok(key: string, meta?: Record<string, unknown>): void;
  fail(key: string, e: unknown, meta?: Record<string, unknown>): void;
  unobservable(key: string, reason: string, meta?: Record<string, unknown>): void;
  note(key: string, meta: Record<string, unknown>): void;
  stateOf(key: string): StageState;
  stages(): Stage[];
  render(title: string): string;
}

export function errShape(e: unknown): NonNullable<Stage["error"]> {
  const err = e as Error;
  return {
    name: err?.name ?? typeof e,
    message: err?.message ?? String(e),
    stack: err?.stack ?? "(no stack)",
    raw: (() => {
      try {
        return JSON.stringify(e, Object.getOwnPropertyNames(Object(e)));
      } catch {
        return String(e);
      }
    })(),
  };
}

/**
 * Build a ledger over a fixed list of `[key, title]` stages.
 *
 * `emit` receives every transition so the caller can also drop it on the shared timeline — the
 * ledger says WHERE it stopped, the timeline says WHAT ELSE was happening at that moment, and a
 * diagnosis usually needs both.
 */
export function makeLedger(
  defs: readonly (readonly [string, string])[],
  emit: (tier: "MEASURED" | "UNKNOWN", msg: string, data: Record<string, unknown>) => void,
): Ledger {
  let stages: Stage[] = [];
  let t0 = Date.now();

  const reset = () => {
    t0 = Date.now();
    stages = defs.map(([key, title], i) => ({
      id: i + 1, key, title, state: "NOT ENTERED",
      enteredAt: null, endedAt: null, meta: {}, error: null,
    }));
  };
  reset();

  const find = (key: string) => stages.find((s) => s.key === key);

  return {
    reset,
    stages: () => stages,
    stateOf: (key) => find(key)?.state ?? "NOT ENTERED",

    enter(key, meta = {}) {
      const s = find(key);
      if (!s) return;
      // Never walk a stage BACKWARDS. A section-level stage is entered once per section, and a later
      // re-entry must not erase the fact that an earlier one completed or failed.
      if (s.state === "NOT ENTERED") { s.state = "ENTERED"; s.enteredAt = Date.now() - t0; }
      Object.assign(s.meta, meta);
      emit("MEASURED", `STAGE ${s.id} ENTERED — ${s.title}`, meta);
    },

    ok(key, meta = {}) {
      const s = find(key);
      if (!s) return;
      if (s.state === "NOT ENTERED") { s.state = "ENTERED"; s.enteredAt = Date.now() - t0; }
      if (s.state !== "FAILED") s.state = "COMPLETED"; // a failure is never overwritten by a later pass
      s.endedAt = Date.now() - t0;
      Object.assign(s.meta, meta);
      emit("MEASURED", `STAGE ${s.id} COMPLETED — ${s.title}`, { ms: (s.endedAt ?? 0) - (s.enteredAt ?? 0), ...meta });
    },

    fail(key, e, meta = {}) {
      const s = find(key);
      if (!s) return;
      if (s.state === "NOT ENTERED") { s.state = "ENTERED"; s.enteredAt = Date.now() - t0; }
      s.state = "FAILED";
      s.endedAt = Date.now() - t0;
      s.error = errShape(e);
      Object.assign(s.meta, meta);
      emit("MEASURED", `STAGE ${s.id} FAILED — ${s.title}`, { ...meta, ...s.error });
    },

    unobservable(key, reason, meta = {}) {
      const s = find(key);
      if (!s) return;
      if (s.state === "COMPLETED" || s.state === "FAILED") return; // never downgrade a real result
      s.state = "NOT OBSERVABLE";
      s.endedAt = Date.now() - t0;
      Object.assign(s.meta, { reason, ...meta });
      emit("UNKNOWN", `STAGE ${s.id} NOT OBSERVABLE — ${s.title}`, { reason, ...meta });
    },

    /** Attach evidence to a stage without changing its state. */
    note(key, meta) {
      const s = find(key);
      if (s) Object.assign(s.meta, meta);
    },

    render: (title) => renderStageList(title, stages),
  };
}

/** Render any stage list — the live ledger, or one archived from an earlier attempt. */
export function renderStageList(title: string, stages: Stage[]): string {
      const L: string[] = [];
      L.push("=".repeat(78));
      L.push(title);
      L.push("=".repeat(78));
      L.push("");
      L.push("Every stage is declared in advance. A stage that never ran is reported as");
      L.push("NOT ENTERED, so 'we never got there' is stated rather than inferred from silence.");
      L.push("");
      const firstFail = stages.find((s) => s.state === "FAILED");
      const lastDone = [...stages].reverse().find((s) => s.state === "COMPLETED");
      const stalled = stages.find((s) => s.state === "ENTERED");
      L.push(`  furthest stage completed : ${lastDone ? `${lastDone.id} — ${lastDone.title}` : "NONE"}`);
      L.push(`  first stage that failed  : ${firstFail ? `${firstFail.id} — ${firstFail.title}` : "none recorded"}`);
      L.push(`  stopped inside stage     : ${stalled ? `${stalled.id} — ${stalled.title}` : "none — no stage was left unfinished"}`);
      L.push("");
      for (const s of stages) {
        const mark =
          s.state === "COMPLETED" ? "✓ entered   ✓ completed"
          : s.state === "FAILED" ? "✓ entered   ✗ FAILED"
          : s.state === "NOT OBSERVABLE" ? "? entered   NOT OBSERVABLE (no reliable hook — do NOT read as failure)"
          : s.state === "ENTERED" ? "✓ entered   … never completed (execution stopped here)"
          : "NOT ENTERED";
        L.push(`Stage ${String(s.id).padStart(2)} — ${s.title}`);
        L.push(`   ${mark}`);
        if (s.enteredAt != null) {
          L.push(`   start ${s.enteredAt} ms` + (s.endedAt != null ? `   end ${s.endedAt} ms   duration ${s.endedAt - s.enteredAt} ms` : ""));
        }
        for (const [k, v] of Object.entries(s.meta)) {
          L.push(`   ${k} = ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
        }
        if (s.error) {
          L.push(`   REASON: ${s.error.name}: ${s.error.message}`);
          L.push("   stack:");
          for (const line of s.error.stack.split("\n")) if (line.trim()) L.push(`     ${line.trim()}`);
          L.push(`   raw: ${s.error.raw.slice(0, 400)}`);
        }
        L.push("");
      }
      return L.join("\r\n");
}
