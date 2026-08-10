// DIAGNOSTIC INSTRUMENTATION — throwaway branch. Never merged, never shipped.
//
// The reader is blank on a real Linux machine and every gate passes. That combination means the
// failure is somewhere no gate looks, so this records the lifecycle itself: each step, when it
// started, whether it finished, and what it returned.
//
// TWO RULES, both learned the hard way this session.
//
// 1. NOTHING MAY REMAIN SILENTLY PENDING. Every asynchronous step is wrapped so that it reports
//    START and then exactly one of SUCCESS, FAILURE or TIMEOUT. A step that hangs is the single most
//    likely shape of "the screen is blank and nothing errored", and a trace that simply stops is
//    indistinguishable from a trace that was never written.
// 2. A TIMEOUT IS NOT A FALLBACK. It reports and rethrows. Turning it into a default value would
//    convert the very failure being hunted into a silent success.
//
// The host has no Tauri API by design, so it cannot write anywhere itself. It sends its lines over
// the port and the application forwards them.

let sink: ((line: string) => void) | null = null;
let seq = 0;
const t0 = Date.now();

/** Where trace lines go. Set once by the application; the host uses `hostTrace` instead. */
export function setTraceSink(fn: (line: string) => void): void {
  sink = fn;
}

function emit(line: string): void {
  const stamped = `[${String(Date.now() - t0).padStart(6)}ms] ${line}`;
  try {
    sink?.(stamped);
  } catch {
    /* a broken sink must not break the thing it is measuring */
  }
  // eslint-disable-next-line no-console
  console.log(stamped);
}

export function trace(event: string, detail?: unknown): void {
  emit(detail === undefined ? event : `${event} ${JSON.stringify(detail).slice(0, 400)}`);
}

/**
 * Run one asynchronous step under observation.
 *
 * The id correlates START with its outcome, so interleaved operations can be told apart — which
 * matters here because the open path runs several at once.
 */
export async function step<T>(name: string, ms: number, run: () => Promise<T>): Promise<T> {
  const id = `#${++seq}`;
  trace(`START    ${id} ${name}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      trace(`TIMEOUT  ${id} ${name} after ${ms}ms`);
      reject(new Error(`TIMEOUT ${name}`));
    }, ms);
  });
  try {
    const v = await Promise.race([run(), timeout]);
    trace(`SUCCESS  ${id} ${name}`);
    return v;
  } catch (e) {
    // A timeout has already reported itself; anything else is reported here.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("TIMEOUT ")) trace(`FAILURE  ${id} ${name} ${msg.slice(0, 200)}`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
