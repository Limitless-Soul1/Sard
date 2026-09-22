// A CONTINUOUS SCROLL FOR FIXED-LAYOUT BOOKS — Sard's PDF "Scroll" mode.
//
// ============================================================================================
// WHY THIS EXISTS AT ALL, and why it is not a wheel fix
// ============================================================================================
//
// `fixed-layout.js` shows ONE spread. Its host is a scroller, so when the page is larger than the
// viewport there is somewhere to scroll; when it is not, there is not. MEASURED in the running
// application, on a 567-page PDF at a 705px viewport:
//
//     zoom fit-page (the default)   page 720px   scrollable travel 0 px     1 wheel notch turns the page
//     zoom 1                        page 720px   scrollable travel 0 px     1 wheel notch turns the page
//     fit-width                    page 1019px   scrollable travel 314 px   4 notches, then it turns
//     zoom 2                       page 1340px   scrollable travel 635 px   7 notches
//     zoom 3                       page 2010px   scrollable travel 1305 px  12 notches
//
// The wheel itself was measured CORRECT — `scrollTop` moved by exactly `deltaY` at every delta from
// 4px to 400px, the event reached exactly one document, and the page-turn guard held a burst of ten
// notches to a single turn. Nothing about the delta handling was wrong. What was wrong is that the
// amount a gesture means was a function of the ZOOM: at the default fit there is nothing to scroll,
// so the first notch of an ordinary gesture jumps a whole page. Raising a threshold or debouncing
// would only change how big the jump felt; the page boundary would still be doing the job of a
// scroll boundary.
//
// ============================================================================================
// WHAT THIS DOES INSTEAD
// ============================================================================================
//
// One real scroll container holding every page of the document as a laid-out slot, with only the
// pages near the viewport actually MOUNTED. Three consequences, and they are the whole design:
//
//   1. THE BROWSER SCROLLS. There is no wheel handler in this file and no delta arithmetic anywhere
//      in it. Wheel, trackpad, momentum, middle-click autoscroll, PageUp/PageDown, Home/End, the
//      scrollbar and the keyboard all work because they are the platform's, not a re-implementation.
//      A small gesture moves a small amount because that is what scrolling is.
//
//   2. A PAGE BOUNDARY IS NOT AN EVENT. Pages are stacked in one flow, so crossing one is just more
//      scrolling. Nothing resets to the top of anything.
//
//   3. THE PAGES THEMSELVES ARE RENDERED EXACTLY AS THEY ALWAYS WERE. Each mounted slot holds the
//      same per-page iframe `fixed-layout.js` builds, from the same `section.load()`, so the text
//      layer, the annotation layer, Sard's theme injection, its highlight marking and its read-aloud
//      extraction all keep working unchanged and unaware. This renderer owns LAYOUT and NAVIGATION.
//      It does not own what a page is.
//
// ============================================================================================
// LAYOUT WITHOUT RENDERING
// ============================================================================================
//
// A 567-page document must have its full extent on the first frame, or the scrollbar lies and a drag
// to the middle lands nowhere. Heights therefore come from `book.pageSize(i)` (SARD LOCAL PATCH 12 in
// pdf.js), which reads the page's own dictionary — no canvas, no decode.
//
// Even that is O(pages) parses, so it is not done upfront either: the FIRST page is measured, its
// size is assumed for every page that has not been measured yet, and each page's true size replaces
// the assumption as it is measured (which happens when it comes near the viewport). Almost every PDF
// is uniform, so for almost every PDF the assumption is already right. When it is not, the correction
// keeps the CURRENT page's position on screen fixed, so the document never jumps under the reader.
//
// ============================================================================================
// WHAT IS DELIBERATELY NOT HERE
// ============================================================================================
//
// No wheel listener. No scroll animation. No smoothing, damping, or delta accumulation. No page-turn
// threshold. Every one of those would be this file having an opinion about a gesture the platform has
// already interpreted correctly.

const MOUNT_RADIUS = 1      // pages kept mounted either side of the current one (so at most 3)
const PAGE_GAP = 18         // the gutter between pages, in CSS px — a desk gap, not a page margin

export class FixedLayoutScroll extends HTMLElement {
    static observedAttributes = ['zoom']
    #root = this.attachShadow({ mode: 'closed' })
    #scroller
    #column
    #slots = []             // one per section: { el, frame, index, top, height, width, measured, mounted }
    #sizes = []             // intrinsic size per section, or null until measured
    #fallback = null        // the first page's intrinsic size, used for pages not yet measured
    #index = 0
    #zoom = 'fit-page'
    #scale = 1
    #book = null
    #raf = 0
    #observer = new ResizeObserver(() => this.#relayout())
    #pendingAnchor = null   // a goTo that arrived before layout was ready
    #suppressReport = false
    #destroyed = false

    constructor() {
        super()
        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            display: block;
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
        .scroller {
            width: 100%;
            height: 100%;
            overflow-x: auto;
            overflow-y: scroll;
            /* The reading surface is pinned LTR like the rest of Sard's reading area: a PDF page's
               own direction belongs to the page, and the scroll axis is vertical in both scripts. */
            direction: ltr;
            /* The platform's own smoothing only; nothing here animates a scroll. */
            overscroll-behavior: contain;
        }
        .column {
            position: relative;
            margin: 0 auto;
        }
        .slot {
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
            overflow: hidden;
            background: transparent;
        }
        .slot > iframe {
            border: 0;
            display: block;
            overflow: hidden;
            transform-origin: top left;
        }`)
        this.#scroller = document.createElement('div')
        this.#scroller.className = 'scroller'
        this.#column = document.createElement('div')
        this.#column.className = 'column'
        this.#scroller.append(this.#column)
        this.#root.append(this.#scroller)
        this.#scroller.addEventListener('scroll', () => this.#onScroll(), { passive: true })
        this.#observer.observe(this)
    }

    attributeChangedCallback(name, _, value) {
        if (name !== 'zoom') return
        const next = value !== 'fit-width' && value !== 'fit-page' ? parseFloat(value) : value
        if (next === this.#zoom) return
        this.#zoom = next
        this.#relayout({ keepCurrentPage: true })
    }

    // ---- the renderer contract view.js uses -------------------------------------------------

    open(book) {
        this.#book = book
        this.#slots = book.sections.map((section, index) => ({
            section, index, el: null, frame: null, top: 0, height: 0, width: 0, mounted: false,
        }))
        this.#sizes = book.sections.map(() => null)
        void this.#bootstrap()
    }

    get index() { return this.#index }

    /** The scroller itself, so a host that wants the real scrolling element can reach it. */
    get scrollElement() { return this.#scroller }

    /** Mirrors of the scroller, so anything that used to read the host's geometry still can. */
    get scrollTop() { return this.#scroller.scrollTop }
    set scrollTop(v) { this.#scroller.scrollTop = v }
    get scrollLeft() { return this.#scroller.scrollLeft }
    set scrollLeft(v) { this.#scroller.scrollLeft = v }
    get scrollHeight() { return this.#scroller.scrollHeight }
    get scrollWidth() { return this.#scroller.scrollWidth }
    get clientHeight() { return this.#scroller.clientHeight }
    get clientWidth() { return this.#scroller.clientWidth }

    async goTo(target) {
        if (this.#destroyed) return
        const index = typeof target === 'number' ? target
            : typeof target?.index === 'number' ? target.index : null
        if (index == null) return
        const clamped = Math.max(0, Math.min(this.#slots.length - 1, index))
        if (!this.#fallback) { this.#pendingAnchor = clamped; return }
        await this.#scrollToPage(clamped)
    }

    /** One page forward. The reader's own wheel does not come through here — only the controls do. */
    async next() { await this.#scrollToPage(Math.min(this.#slots.length - 1, this.#index + 1)) }
    async prev() { await this.#scrollToPage(Math.max(0, this.#index - 1)) }

    /**
     * The mounted pages, CURRENT FIRST.
     *
     * Everything downstream — Sard's theme injection, highlight marking, read-aloud extraction,
     * `view.js`'s own selection code — reads `getContents()[0]` and means "the page being read". With
     * more than one page mounted that is no longer "the only one", so the order states it.
     */
    getContents() {
        const out = []
        const cur = this.#slots[this.#index]
        const push = slot => {
            const doc = slot?.frame?.contentDocument
            if (doc) out.push({ doc, index: slot.index, overlayer: slot.overlayer ?? null })
        }
        push(cur)
        for (const slot of this.#slots) if (slot !== cur && slot.mounted) push(slot)
        return out
    }

    destroy() {
        this.#destroyed = true
        this.#observer.disconnect()
        for (const slot of this.#slots) this.#unmount(slot)
        this.#slots = []
    }

    // ---- layout -----------------------------------------------------------------------------

    async #bootstrap() {
        // The first page's size stands in for every page not yet measured. One parse, not N.
        const size = await this.#measure(0)
        if (this.#destroyed) return
        this.#fallback = size ?? { width: 600, height: 800 }
        this.#relayout()
        if (this.#pendingAnchor != null) {
            const at = this.#pendingAnchor
            this.#pendingAnchor = null
            await this.#scrollToPage(at)
        } else {
            this.#report('open')
        }
    }

    async #measure(index) {
        const book = this.#book
        if (!book?.pageSize) return null
        try {
            const s = await book.pageSize(index)
            if (s?.height > 0) { this.#sizes[index] = s; return s }
        } catch { /* a page that will not report its size keeps the assumption */ }
        return null
    }

    #sizeOf(index) { return this.#sizes[index] ?? this.#fallback ?? { width: 600, height: 800 } }

    /**
     * The scale a fit mode resolves to. Read from the CURRENT page rather than from the first, so a
     * document whose pages differ does not fit the whole book to page one.
     */
    #scaleFor() {
        const { width, height } = this.#sizeOf(this.#index)
        const vw = Math.max(1, this.#scroller.clientWidth - 2 * PAGE_GAP)
        const vh = Math.max(1, this.#scroller.clientHeight - 2 * PAGE_GAP)
        if (typeof this.#zoom === 'number' && !isNaN(this.#zoom)) return this.#zoom
        if (this.#zoom === 'fit-width') return vw / width
        return Math.min(vw / width, vh / height)   // fit-page
    }

    /**
     * Rebuild the height table and the slot geometry.
     *
     * `keepCurrentPage` holds the reader's place across a zoom change or a measurement correction: the
     * offset INTO the current page is kept as a fraction of that page's height, so the same part of
     * the same page stays under the eye. Without it, every correction on a non-uniform document would
     * shift the document under the reader.
     */
    #relayout({ keepCurrentPage = false } = {}) {
        if (!this.#fallback || this.#destroyed) return
        const before = keepCurrentPage ? this.#pagePosition() : null
        this.#scale = this.#scaleFor()
        let top = PAGE_GAP
        let widest = 0
        for (const slot of this.#slots) {
            const s = this.#sizeOf(slot.index)
            // THE BOX IS THE SIZE OF WHAT pdf.js WILL ACTUALLY PAINT, to the device pixel.
            //
            // pdf.js sizes its canvas to `floor(intrinsic * scale * dpr)` DEVICE pixels and shows it at
            // `1/dpr`. Rounding the slot independently left it up to a pixel wider than the painted
            // page, and that pixel is the desk showing through — the hairline strips at the page edge.
            // Measured: a 1px empty strip at zoom 1 on a scanned page. Sizing the box from the same
            // arithmetic the painter uses leaves nothing between them.
            slot.width = this.#painted(s.width)
            slot.height = this.#painted(s.height)
            slot.top = top
            top += slot.height + PAGE_GAP
            if (slot.width > widest) widest = slot.width
            if (slot.el) this.#placeSlot(slot)
        }
        this.#column.style.height = `${top}px`
        this.#column.style.width = `${widest}px`
        if (before) this.#restorePagePosition(before)
        this.#syncMounted()
    }

    /** The CSS size pdf.js paints a page dimension at — `floor(d * scale * dpr) / dpr`. */
    #painted(d) {
        const dpr = globalThis.devicePixelRatio || 1
        return Math.floor(d * this.#scale * dpr) / dpr
    }

    #placeSlot(slot) {
        Object.assign(slot.el.style, {
            top: `${slot.top}px`,
            width: `${slot.width}px`,
            height: `${slot.height}px`,
        })
        const f = slot.frame
        if (f) {
            const s = this.#sizeOf(slot.index)
            // ONE SCALE, APPLIED ONCE.
            //
            // A page with `onZoom` (every PDF page) RE-RENDERS itself at the target scale: pdf.js paints
            // the canvas at that scale and sizes the page document to match. Its frame must therefore be
            // the SCALED size with NO transform. The first version of this file also CSS-scaled the frame,
            // so the page was drawn at scale × scale. MEASURED on three real PDFs: at fit-page a page
            // meant to fill a 423×684 slot was painted 612×990 and lost 189px on the right and 306px at
            // the bottom; at 0.75 it shrank to 0.56 and left an 88px empty strip. Only at exactly zoom 1
            // did the two cancel. This is the rule `fixed-layout.js` has always followed
            // (`iframeScale = onZoom ? scale : 1`), restated here rather than rediscovered.
            //
            // A page WITHOUT `onZoom` (a pre-paginated EPUB image page) cannot re-render, so it is laid
            // out at its intrinsic size and magnified — the same branch the paged renderer takes.
            const renders = !!slot.onZoom
            Object.assign(f.style, renders
                ? { width: `${slot.width}px`, height: `${slot.height}px`, transform: 'none' }
                : { width: `${s.width}px`, height: `${s.height}px`, transform: `scale(${this.#scale})` })
            // A PDF page re-renders at the new scale rather than magnifying its bitmap — the same
            // call `fixed-layout.js` makes, so resolution behaves identically in both modes.
            //
            // GUARDED ON THE PAGE'S OWN STRUCTURE, not merely on `contentDocument` being non-null. A
            // frame that has been given a `src` but has not loaded it yet still HAS a document — the
            // blank one — and re-rendering into that threw `Cannot read properties of null (reading
            // 'replaceChildren')` out of pdf.js, because `#canvas` does not exist there. Measured:
            // three such exceptions per open. The page re-renders at the right scale on its own load
            // anyway (`#placeSlot` runs again from the load handler), so the early call had nothing
            // to contribute even when it did not throw.
            const ready = slot.onZoom && f.contentDocument?.querySelector('#canvas')
            if (ready) {
                try { slot.onZoom({ doc: f.contentDocument, scale: this.#scale }) } catch { /* a page torn down mid-render */ }
            }
        }
    }

    /** Where the reader is, expressed so it survives a re-layout: a page, and a fraction into it. */
    #pagePosition() {
        const slot = this.#slots[this.#index]
        if (!slot || !slot.height) return null
        const y = this.#scroller.scrollTop
        return { index: slot.index, into: (y - slot.top) / slot.height }
    }

    #restorePagePosition(pos) {
        const slot = this.#slots[pos.index]
        if (!slot) return
        this.#suppressReport = true
        this.#scroller.scrollTop = Math.max(0, slot.top + pos.into * slot.height)
        this.#suppressReport = false
    }

    // ---- mounting ---------------------------------------------------------------------------

    #syncMounted() {
        const lo = Math.max(0, this.#index - MOUNT_RADIUS)
        const hi = Math.min(this.#slots.length - 1, this.#index + MOUNT_RADIUS)
        for (const slot of this.#slots) {
            const want = slot.index >= lo && slot.index <= hi
            if (want && !slot.mounted) this.#mount(slot)
            else if (!want && slot.mounted) this.#unmount(slot)
        }
        // Measure the window's pages so the table converges on the truth where it matters first.
        for (let i = lo; i <= hi; i++) {
            if (this.#sizes[i]) continue
            void this.#measure(i).then(s => {
                if (!s || this.#destroyed) return
                // A correction must not move the document under the reader.
                this.#relayout({ keepCurrentPage: true })
            })
        }
    }

    #mount(slot) {
        slot.mounted = true
        if (!slot.el) {
            slot.el = document.createElement('div')
            slot.el.className = 'slot'
            slot.el.setAttribute('dir', 'ltr')
            this.#column.append(slot.el)
        }
        this.#placeSlot(slot)
        const iframe = document.createElement('iframe')
        // The same sandbox posture the paged renderer uses — see SARD LOCAL PATCH 1b in fixed-layout.js.
        iframe.setAttribute('sandbox', globalThis.__sardSectionSandbox ?? 'allow-same-origin')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        slot.frame = iframe
        slot.el.replaceChildren(iframe)
        this.#placeSlot(slot)
        void Promise.resolve(slot.section.load()).then(srcOption => {
            if (this.#destroyed || slot.frame !== iframe) return
            const src = typeof srcOption === 'string' ? srcOption : srcOption?.src
            slot.onZoom = typeof srcOption === 'string' ? null : srcOption?.onZoom
            if (!src) return
            iframe.addEventListener('load', () => {
                if (this.#destroyed || slot.frame !== iframe) return
                const doc = iframe.contentDocument
                this.#placeSlot(slot)
                // The SAME event `fixed-layout.js` dispatches, with the same detail — which is what
                // makes every existing per-page consumer (theme, highlights, read-aloud, keys) work
                // here without knowing this renderer exists.
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index: slot.index } }))
                this.dispatchEvent(new CustomEvent('create-overlayer', {
                    detail: {
                        doc, index: slot.index,
                        attach: overlayer => { slot.overlayer = overlayer },
                    },
                }))
            }, { once: true })
            iframe.src = src
        })
    }

    #unmount(slot) {
        slot.mounted = false
        slot.overlayer = null
        slot.onZoom = null
        if (slot.frame) {
            // Drop the document so the page's raster is released; the slot keeps its box, so nothing
            // in the layout moves when a page leaves the window.
            try { slot.frame.removeAttribute('src') } catch { /* already gone */ }
            slot.frame.remove()
            slot.frame = null
        }
        if (slot.el) slot.el.replaceChildren()
    }

    // ---- where the reader is ----------------------------------------------------------------

    #onScroll() {
        if (this.#raf) return
        this.#raf = requestAnimationFrame(() => {
            this.#raf = 0
            if (this.#destroyed) return
            const next = this.#pageAtViewportMiddle()
            const moved = next !== this.#index
            this.#index = next
            if (moved) this.#syncMounted()
            if (!this.#suppressReport) this.#report('scroll')
        })
    }

    /**
     * THE CURRENT PAGE IS THE ONE UNDER THE MIDDLE OF THE VIEWPORT.
     *
     * Not the topmost visible one: at a zoom where two pages share the screen, the top one can be a
     * two-pixel sliver while the reader is plainly reading the other. The middle is what a reader
     * would point at.
     */
    #pageAtViewportMiddle() {
        const mid = this.#scroller.scrollTop + this.#scroller.clientHeight / 2
        // The slots are sorted by `top`, so this is a binary search, not a scan — it runs on scroll.
        let lo = 0, hi = this.#slots.length - 1, best = 0
        while (lo <= hi) {
            const m = (lo + hi) >> 1
            const s = this.#slots[m]
            if (mid < s.top) hi = m - 1
            else { best = m; lo = m + 1 }
        }
        return best
    }

    async #scrollToPage(index) {
        if (!this.#fallback) { this.#pendingAnchor = index; return }
        const slot = this.#slots[index]
        if (!slot) return
        this.#index = index
        this.#syncMounted()
        this.#suppressReport = true
        this.#scroller.scrollTop = Math.max(0, slot.top - PAGE_GAP)
        this.#suppressReport = false
        this.#report('page')
        // Give the newly mounted page a frame to arrive, so a caller that awaits `goTo` and then
        // reads `getContents()` is not handed an empty document.
        await new Promise(r => requestAnimationFrame(() => r()))
    }

    /**
     * The SAME shape `fixed-layout.js` reports, so nothing downstream has to learn a second one.
     *
     * `fraction` in particular: Sard persists a PDF's position as the section MIDPOINT,
     * `(index + 0.5) / n` (RAWY-86), because foliate's own inverse rounds a boundary up. Reporting
     * anything else here would silently change what every previously saved position means.
     */
    #report(reason) {
        const n = this.#slots.length || 1
        this.dispatchEvent(new CustomEvent('relocate', {
            detail: { reason, range: null, index: this.#index, fraction: 0, size: 1 },
        }))
        void n
    }
}

customElements.define('foliate-fxl-scroll', FixedLayoutScroll)
