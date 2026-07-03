// RAWY-88: a tiny bridge that exposes the vendored engine's CFI comparator to the app. Vite refuses
// to let source code import a /public module, but a runtime <script type="module"> tag (the same
// mechanism FoliateController uses to load view.js) is served as-is and can import it. The comparator
// orders two EPUB CFIs — the app uses it for the spoiler-safe boundary (is a match past your place?).
import { compare } from '/foliate-js/epubcfi.js'
window.__sardCfiCompare = compare
