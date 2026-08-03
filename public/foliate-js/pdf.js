const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const fetchText = async url => await (await fetch(url)).text()

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/text_layer_builder.css
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/annotation_layer_builder.css
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))

const render = async (page, doc, zoom) => {
    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    // RAWY-85 test: adopting a painted canvas across documents renders blank in Chromium/WebView2;
    // copy the pixels into an <img> in the page iframe instead (engine-robust).
    const pageImg = doc.createElement('img')
    pageImg.src = canvas.toDataURL()
    pageImg.style.width = canvas.width + 'px'
    pageImg.style.height = canvas.height + 'px'
    doc.querySelector('#canvas').replaceChildren(pageImg)

    const container = doc.querySelector('.textLayer')
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container, viewport,
    })
    await textLayer.render()

    // hide "offscreen" canvases appended to docuemnt when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const canvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // fix text selection
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    container.append(endOfContent)
    // TODO: this only works in Firefox; see https://github.com/mozilla/pdf.js/pull/17923
    container.onpointerdown = () => container.classList.add('selecting')
    container.onpointerup = () => container.classList.remove('selecting')

    const div = doc.querySelector('.annotationLayer')
    const linkService = {
        goToDestination: () => {},
        getDestinationHash: dest => JSON.stringify(dest),
        addLinkAttributes: (link, url) => link.href = url,
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService })
        .render({ annotations: await page.getAnnotations() })
}

const renderPage = async (page, getImageBlob) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(resolve))
    }
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `], { type: 'text/html' }))
    const onZoom = ({ doc, scale }) => render(page, doc, scale)
    return { src, onZoom }
}

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    // RAWY-86: one page per view (spread:'none') — the natural PDF experience, and a clean 1:1
    // page↔spread mapping for navigation + fraction resume (vs foliate's default 2-up book spread).
    const book = { rendition: { layout: 'pre-paginated', spread: 'none' } }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    book.toc = outline?.map(makeTOCItem)

    const cache = new Map()
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) return cached
            const url = await renderPage(await pdf.getPage(i + 1))
            cache.set(i, url)
            return url
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    // RAWY-285: ONE resolver for both entry points below. They were three duplicated lines carrying the
    // same defect — `dest[0]` assumed a TOC entry ALWAYS resolves to a destination array. It does not,
    // and there are TWO ordinary ways for it not to, both reproduced against real PDF.js:
    //
    //   1. `item.dest` is null outright. An outline entry may carry an ACTION instead of a destination
    //      (/A << /S /URI >>, GoToR, JavaScript). `makeTOCItem` does JSON.stringify(null) -> "null",
    //      so this arrives here as the parsed value `null`.
    //   2. `item.dest` is a NAME that is not in the document's name tree — a dangling named destination,
    //      routinely produced by splitting, merging or re-saving a PDF. `getDestination()` returns null.
    //
    // Either way `dest[0]` threw "Cannot read properties of null (reading '0')". That is fatal rather
    // than cosmetic because `view.open()` builds TOCProgress for EVERY TOC item (view.js) with no
    // try/catch, so a single unresolvable bookmark stopped the whole document from opening.
    //
    // The fix resolves honestly instead of guarding the symptom: an entry that names no reachable page
    // HAS no page, and says so by returning null. A valid destination is resolved exactly as before, so
    // every PDF that opens today is unaffected — see the `C-valid-control` case.
    const destToPageIndex = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        if (!Array.isArray(dest) || !dest.length) return null
        try {
            return await pdf.getPageIndex(dest[0])
        } catch {
            // A well-formed dest can still reference something that is not a page in THIS document
            // (a damaged ref, or one aimed at an external file). Unresolvable is unresolvable.
            return null
        }
    }
    // null = "this link goes nowhere". `view.goTo` already treats a non-resolving target as a no-op, so
    // clicking such a bookmark does nothing instead of rejecting an un-caught promise.
    book.resolveHref = async href => {
        const index = await destToPageIndex(href)
        return index == null ? null : { index }
    }
    // `[null, null]` keeps the [index, fragment] contract. TOCProgress groups by section id, and PDF
    // section ids are the page NUMBERS (`id: i` below), so a null id can never collide with a real
    // section: the entry simply never becomes the current-chapter label, and that page inherits the
    // previous entry's label — the same thing that already happens for a page with no TOC entry.
    book.splitTOCHref = async href => {
        const index = await destToPageIndex(href)
        return index == null ? [null, null] : [index, null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    // RAWY-86: plain text of a page (0-based) for a basic in-PDF find. Arabic text layers can be
    // segmented/disconnected upstream, so matches are best-effort.
    book.getPageText = async i => {
        const page = await pdf.getPage(i + 1)
        const tc = await page.getTextContent()
        return tc.items.map(it => it.str ?? '').join(' ')
    }
    book.destroy = () => pdf.destroy()
    return book
}
