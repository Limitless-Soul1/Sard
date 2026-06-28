import { useState } from "react";

// The Sard hoopoe mark (band K). It is an accent, never the hero: a transparent PNG that
// sits on any theme and mirrors for RTL (handled in CSS) so it always faces into the
// content. The asset lives at /assets/sard-bird.png; until it is dropped in, this renders
// nothing and callers fall back gracefully (sidebar → wordmark only; empty state → spines).
export function Hoopoe({ size, className }: { size: number; className?: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      src="/assets/sard-bird.png"
      alt=""
      aria-hidden="true"
      className={`hoopoe${className ? ` ${className}` : ""}`}
      style={{ height: size, width: "auto" }}
      onError={() => setOk(false)}
    />
  );
}
