// MEASURE A SCROLLER, INCLUDING ONE THAT MOUNTS LATE.
//
// WHY THIS EXISTS, and it is a measured defect rather than a tidy-up. The first mobile Library
// measured its scroller in a `useLayoutEffect(…, [])`. That effect runs ONCE, after the first
// render — and the first render is the loading branch (`books === null`), which does not contain the
// scroller. `scroller.current` was therefore `null`, the effect returned early, and the
// ResizeObserver was never attached at all. The consequences were all visible on an Android 16
// emulator and none were visible to a unit test:
//
//   * `viewport` stayed 0 and `metrics` stayed the initial `{columns: 2, rowHeight: 260}` forever,
//     so only six cells rendered whatever the screen size;
//   * the assumed 260px row pitch ran against an actual ~325px, so the rendered window drifted out
//     of the viewport — coverage measured 66% at some scroll positions, i.e. a third of the screen
//     blank while books existed below;
//   * `scrollHeight` changed as you scrolled (2553 → 2520), so the scrollbar lied;
//   * rotating to landscape kept two 393px columns where five were correct — proof that the
//     container was never re-measured;
//   * and the last book in the library became unreachable: the scroller reported `atBottom` while
//     the final item had never been rendered.
//
// A CALLBACK REF FIXES THE CLASS, not the instance. React invokes it with the element every time
// that element is attached — first mount, a later mount after a loading state, or a remount after a
// conditional branch flips — and with `null` when it is detached. There is no dependency array to
// get wrong, so "the element appeared later" stops being a case the caller has to remember.
//
// MEASURED IN THE CALLBACK, not in an effect: React runs ref callbacks during commit, before the
// browser paints, so the first painted frame already has the real size. Measuring in an effect
// shows one frame windowed for a zero-height viewport, which on a slow device is a visible flash of
// the wrong row count.
//
// NOT UNIT-TESTED, deliberately. `vitest.config.ts` runs on `node` with no DOM shim and says why:
// a jsdom test of layout "would buy nothing and would invite tests that pass in a fake DOM and lie".
// ResizeObserver behaviour is exactly that kind of question. This hook is therefore kept as thin as
// it can be — all of the arithmetic it feeds lives in `useVirtualGrid`, which IS pure and IS tested —
// and its correctness is established on a device.

import { useCallback, useRef, useState } from "react";

export interface Size {
  /** Content-box width in CSS px. 0 until the element is attached. */
  width: number;
  /** Content-box height in CSS px. 0 until the element is attached. */
  height: number;
}

const SAME = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

/**
 * Observe an element's size for as long as it is mounted.
 *
 * Returns the ref callback to put on the element and the latest size. Both are stable across
 * renders, so passing the ref down does not remount anything.
 *
 * ```tsx
 * const [ref, { height }] = useElementSize<HTMLDivElement>();
 * return <div ref={ref} className="scroller">…</div>;
 * ```
 */
export function useElementSize<T extends HTMLElement>(): [(el: T | null) => void, Size] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    // Detaching from the previous element is not optional: without it a remount leaves the old
    // observer alive and two elements report into one piece of state.
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;

    const read = () => {
      // `clientWidth`/`clientHeight` are the CONTENT box — padding excluded, scrollbar excluded —
      // which is the box the grid arithmetic divides into columns. `ResizeObserver`'s own
      // `contentRect` agrees, but reading the element keeps one source for both paths.
      const next = { width: el.clientWidth, height: el.clientHeight };
      // Guard the state write: a ResizeObserver fires for sub-pixel and no-op changes, and an
      // unguarded `setSize` would re-render the whole windowed list on every scroll-induced reflow.
      setSize((prev) => (SAME(prev, next) ? prev : next));
    };

    read(); // before paint — the first frame is already windowed correctly

    // A device without ResizeObserver would still get the mount-time measurement above rather than
    // a zero, so the feature degrades to "correct until rotated" instead of to "broken".
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    observer.current = ro;
  }, []);

  return [ref, size];
}
