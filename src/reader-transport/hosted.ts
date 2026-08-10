// The reader as the application sees it when the engine runs inside the reader host.
//
// It presents the SAME surface `FoliateController` does. That is the design: `Reader.tsx` has 107
// call sites and none of them changes, because what differs between platforms is where the engine
// runs, not what it looks like from outside.
//
// Three shapes of member, classified in `surface.ts`:
//
//   • most are forwarded over the port and already return a promise;
//   • thirteen return synchronously, and are answered from a mirror the host pushes AHEAD of the
//     question, so their signatures stay synchronous and their call sites stay untouched;
//   • three are decided HERE, because the engine needs the answer before a round trip could return.
//
// Nothing re-implements engine logic. Where a decision is made on this side it calls the same shared
// module the engine calls — `navIntent`, `cfiSection` — so the two sides cannot disagree.
import { navIntent } from "../reader-engine/navIntent";
import { sameSection } from "../reader-engine/cfiSection";
import type { FoliateController } from "../reader-engine/FoliateController";
import { CROSSING } from "./surface";
import type { Mirror, Push, Reply, Request, RequestBody } from "./protocol";

const EMPTY_MIRROR: Mirror = {
  currentSectionIndex: 0,
  atChapterStart: true,
  isTtsChapterOnScreen: true,
  hasNextSection: false,
  openingUnderTopBar: false,
  pdfTextQuality: null,
  pdfRenderedScale: 1,
  pdfHasSpeakableText: false,
  isFixedLayout: false,
  toc: [],
  tocHrefSection: [],
  ttsCursors: [],
};

/**
 * Synchronous reads whose answer the mirror carries verbatim.
 *
 * Written out rather than derived. If the engine grows another synchronous member, this does not
 * quietly start returning `undefined` for it — `readerSurface.test.ts` fails first, because the new
 * member's shape is unforwardable and nothing classified it.
 */
const MIRRORED_DIRECT = {
  currentSectionIndex: "currentSectionIndex",
  atChapterStart: "atChapterStart",
  isTtsChapterOnScreen: "isTtsChapterOnScreen",
  hasNextSection: "hasNextSection",
  openingUnderTopBar: "openingUnderTopBar",
  pdfTextQuality: "pdfTextQuality",
  pdfRenderedScale: "pdfRenderedScale",
  pdfHasSpeakableText: "pdfHasSpeakableText",
} as const satisfies Record<string, keyof Mirror>;

export class HostedReader {
  // Deliberately NOT `#private`. The proxy below has to read `handlers` and dispatch on the members
  // declared here, and a `#name` field is unreachable from outside the class body — an earlier draft
  // reached for one through a cast, which type-checks and is always `undefined` at run time.
  private readonly port: MessagePort;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private mirror: Mirror = EMPTY_MIRROR;
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  constructor(port: MessagePort) {
    this.port = port;
    port.onmessage = (e: MessageEvent<Reply | Push>) => this.receive(e.data);
    port.start();
  }

  private receive(msg: Reply | Push): void {
    if ("kind" in msg) {
      if (msg.kind === "state") this.mirror = msg.mirror;
      else if (msg.kind === "event") this.handlers.get(msg.name)?.(...msg.args);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error ?? "the reader host refused the call"));
  }

  private send(req: RequestBody, transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ ...req, id } as Request, transfer);
    });
  }

  /** A consequence nobody awaits. The next mirror push reports the result either way. */
  private tell(method: string, args: unknown[] = []): void {
    void this.send({ kind: "call", method, args }).catch(() => {});
  }

  /** Used by the proxy for every member not declared on this class. */
  call(method: string, args: unknown[]): Promise<unknown> {
    return this.send({ kind: "call", method, args });
  }

  // ---- opening ----------------------------------------------------------------------------------

  /**
   * The same signature the engine has, so `Reader.tsx:1218` is untouched.
   *
   * The application resolves the book to an `asset:` URL and can fetch it; the host cannot, and must
   * not be able to — a filesystem route from that origin is exactly what `bookhost.rs` refuses. So
   * the bytes are read HERE and transferred, which is also the cheaper of the two measured options
   * (1257 ms vs 1278 ms on a 14.1 MB EPUB). `container` is ignored: the host owns its own.
   */
  async open(source: string, _container: HTMLElement, opts: unknown): Promise<void> {
    const bytes = await (await fetch(source)).arrayBuffer();
    await this.send({ kind: "open", bytes, opts }, [bytes]);
  }

  // ---- the three decisions that cannot wait ------------------------------------------------------

  /**
   * `Reader.tsx:1587` calls this in a keydown listener and uses the answer for `preventDefault()`.
   * A promise resolves long after the browser has decided what the key does.
   *
   * It does not need to cross. The engine's body is `navIntent(key)`, then — for arrows on a
   * reflowable book — the arrow callback, then a page turn. `navIntent` is the same module the engine
   * imports, and its comment says why it exists separately: ONE copy, shared with its tests.
   * `isFixedLayout` is mirrored. The arrow callback belongs to the application, which registered it.
   * Only the page turn crosses, and nothing waits for it.
   */
  handleNavKey(key: string): boolean {
    const intent = navIntent(key);
    if (!intent) return false;
    if (!this.mirror.isFixedLayout && (key === "ArrowLeft" || key === "ArrowRight")) {
      const arrow = this.handlers.get("onArrow") as ((k: string) => boolean) | undefined;
      if (arrow?.(key)) return true;
    }
    this.tell(intent === "forward" ? "forward" : "backward");
    return true;
  }

  /**
   * The engine asks the application whether it claimed an arrow, mid-gesture, and branches on the
   * answer. A port cannot reply in time — so the host never asks. The callback is held here and
   * consulted by `handleNavKey`, which is the only path that reaches it.
   */
  onArrow(cb: (key: string) => boolean): void {
    this.handlers.set("onArrow", cb as (...a: unknown[]) => unknown);
  }

  /**
   * The same shape as `onArrow`, and the harder of the two — because the engine does NOT reach this
   * one through a method the application calls.
   *
   * MEASURED: `arrowCb` is invoked from exactly one place, `handleNavKey`, which the application
   * drives — so arrows never need to cross. `spaceCb` is invoked from two keydown listeners the
   * ENGINE attaches (FoliateController:1663, :1765), and those run in the host. A boolean cannot get
   * back there in time.
   *
   * So the host does not ask. It registers its own `onSpace` that always claims the key — the engine
   * calls `preventDefault()` and takes no further action — and pushes a `space` event here. The
   * application's callback runs on this side, and only if it declines does a page turn cross. The
   * outcome is the engine's own `if (spaceCb()) preventDefault(); else next();`, with the page turn
   * one message later; nothing is re-implemented and nothing waits on a synchronous reply.
   */
  onSpace(cb: () => boolean): void {
    this.handlers.set("space", ((): unknown => {
      if (cb()) return true;
      this.tell("forward");
      return false;
    }) as (...a: unknown[]) => unknown);
  }

  // ---- synchronous reads, answered from the mirror -----------------------------------------------

  getToc(): unknown[] {
    return this.mirror.toc;
  }

  /** Pure, and shared with the engine — `cfiSection.ts` records why it is computed on this side. */
  bookmarkVisible(a: string | null | undefined, b: string | null | undefined): boolean {
    return sameSection(a, b);
  }

  /**
   * A lookup over the mirrored map, never a re-derivation of it. Called with an explicit list only
   * when the panel shows a synthesised TOC, in which case the answer is the same map narrowed to the
   * entries actually on screen.
   */
  tocHrefSectionMap(entries?: { href?: string }[]): Map<string, number> {
    const full = new Map(this.mirror.tocHrefSection);
    if (!entries) return full;
    const out = new Map<string, number>();
    for (const e of entries) {
      const href = e?.href;
      const i = href == null ? undefined : full.get(href);
      if (href != null && i !== undefined) out.set(href, i);
    }
    return out;
  }

  getTtsCursor(i: number): unknown {
    return this.mirror.ttsCursors[i] ?? null;
  }

  /** Reads the mirror for the eight members whose value it carries directly. */
  mirrored(method: keyof typeof MIRRORED_DIRECT): unknown {
    return this.mirror[MIRRORED_DIRECT[method]];
  }
}

/**
 * Present the hosted reader with the engine's own type.
 *
 * A `Proxy` rather than fifty-two hand-written one-line forwards. The forwards carry no decisions,
 * and writing them out by hand invites the one that is subtly different from the rest — which is the
 * failure mode this whole seam is trying to avoid.
 */
export function hostedReader(port: MessagePort): FoliateController {
  const impl = new HostedReader(port);
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);

      // `then` MUST NOT be manufactured, and this is not a hypothetical.
      //
      // `createReader()` is async, so returning this proxy makes the runtime ask whether it is a
      // thenable — by reading `.then`. The catch-all below happily produced a forwarding function,
      // the runtime called it with `(resolve, reject)`, and the transport tried to postMessage two
      // FUNCTIONS. MEASURED on WebKitGTK: `DataCloneError: The object can not be cloned`, thrown
      // inside `createReader()` before a single reader call had been made, as an unhandled rejection
      // with nothing pointing at the cause. `catch` and `finally` are refused for the same reason.
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;

      // Declared on HostedReader: the decisions, the mirrored reads with arguments, `open`.
      if (prop in target) return Reflect.get(target, prop, receiver);

      // Mirrored, answered synchronously.
      if (prop in MIRRORED_DIRECT) {
        return () => target.mirrored(prop as keyof typeof MIRRORED_DIRECT);
      }

      // A callback the application registers; the host pushes the event and we invoke it.
      if (CROSSING[prop] === "callback") {
        return (cb: (...a: unknown[]) => unknown) => {
          target.handlers.set(prop, cb);
        };
      }

      // Everything else is mechanical.
      return (...args: unknown[]) => target.call(prop, args);
    },
  }) as unknown as FoliateController;
}
