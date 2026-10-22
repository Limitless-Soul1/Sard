/**
 * The translation view, as the reader engine runs it: shown on a section's document as it loads, and taken off it
 * again. The engine knows nothing else about translation (`features/translation/reader`): it calls this, and it
 * never lets it break a section's render.
 */
export interface TranslationLayer {
  apply(doc: Document, index: number): void;
  clear(doc: Document): void;
}
