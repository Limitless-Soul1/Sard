// HOW AN ICON GETS ITS SIZE, AND THE ONE WAY IT MUST NEVER GET IT AGAIN.
//
// Sard 1.3.0 shipped every `Icon` with `width="var(--icon-md)"` as an SVG PRESENTATION ATTRIBUTE.
// On the WebView2 of the day that resolved to 16px and nothing looked wrong. On an older Chromium
// runtime it does not: a presentation attribute is parsed with the property's own grammar, older
// engines reject `var()` in a length attribute, and a rejected attribute is absent — so the inline
// svg takes its container's width at the viewBox's 1:1 ratio. MEASURED on the running app with the
// attribute rejected: a 16px mark became 165–199px, every icon in the Library at the width of its
// row, strokes scaled with it, text and covers untouched. That is the field report this guards.
//
// The fix moved the size into a `style` declaration, where `var()` is resolved by the cascade on
// every engine the product runs on. This file pins BOTH halves: the rendered markup carries no
// `var()` in a `width`/`height` attribute, and it does carry the token in the style. It renders the
// component for real (`react-dom/server`, which needs no DOM) rather than reading the source, so a
// refactor that moved the sizing somewhere else entirely would still be judged by what reaches the
// engine.
//
// The compatibility behaviour itself — an old engine rejecting the attribute — cannot be exercised
// here; a current engine accepts both forms. What CAN be held is that the product no longer depends
// on the engine accepting the risky one.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Icon, ICON_NAMES, type IconSize } from "../../src/components/Icon";

const render = (props: Parameters<typeof Icon>[0]) => renderToStaticMarkup(createElement(Icon, props));

/** The opening <svg …> tag alone — the sizing lives there, and only there. */
const openTag = (markup: string) => markup.match(/<svg[^>]*>/)?.[0] ?? "";

const SIZES: IconSize[] = ["sm", "md", "lg", "xl"];
const TOKEN: Record<IconSize, string> = {
  sm: "var(--icon-sm)",
  md: "var(--icon-md)",
  lg: "var(--icon-lg)",
  xl: "var(--icon-xl)",
};

describe("the size never rides a presentation attribute", () => {
  it("emits no width/height ATTRIBUTE carrying var(), for any size", () => {
    for (const size of SIZES) {
      const tag = openTag(render({ name: "gear", size }));
      // The exact failure mode: `width="var(…)"` on the element. Anything else here is a different
      // bug; this is the one that emptied the attribute on an older engine.
      expect(tag, `size=${size}`).not.toMatch(/\swidth="var\(/);
      expect(tag, `size=${size}`).not.toMatch(/\sheight="var\(/);
    }
  });

  it("does not depend on a width attribute at all — no attribute means no grammar to reject", () => {
    const tag = openTag(render({ name: "gear", size: "md" }));
    expect(tag).not.toMatch(/\swidth=/);
    expect(tag).not.toMatch(/\sheight=/);
  });
});

describe("the size rides a style declaration, from the same tokens", () => {
  it("carries the token for every size in the style attribute", () => {
    for (const size of SIZES) {
      const tag = openTag(render({ name: "gear", size }));
      const style = tag.match(/style="([^"]*)"/)?.[1] ?? "";
      expect(style, `size=${size}`).toContain(`width:${TOKEN[size]}`);
      expect(style, `size=${size}`).toContain(`height:${TOKEN[size]}`);
    }
  });

  it("keeps the layout declarations it always had", () => {
    const style = openTag(render({ name: "gear" })).match(/style="([^"]*)"/)?.[1] ?? "";
    expect(style).toContain("flex:none");
    expect(style).toContain("display:block");
  });

  it("holds for every icon in the set, not only one", () => {
    for (const name of ICON_NAMES) {
      const tag = openTag(render({ name }));
      expect(tag, name).not.toMatch(/\s(width|height)="var\(/);
      expect(tag, name).toContain("width:var(--icon-md)");
    }
  });
});

describe("the stroke weight rides the style too — the same attribute grammar rejects it", () => {
  it("emits no stroke-width ATTRIBUTE carrying var()", () => {
    // Rejected, a stroke-width attribute falls to the SVG default of 1: every outlined mark a third
    // thinner than drawn (measured 1.75px → 1px). Same engines, same mechanism as the size.
    for (const name of ICON_NAMES) {
      const tag = openTag(render({ name }));
      expect(tag, name).not.toMatch(/\sstroke-width="var\(/);
    }
  });

  it("every outlined icon gets its weight from the token, or every shape carries its own", () => {
    // Two lawful shapes and no third: the root style carries `var(--icon-stroke)`, or the icon is a
    // per-path one whose child shapes each declare a weight. A filled icon has no stroke at all.
    // An outlined icon with NEITHER would draw at the SVG default of 1 — the very degradation the
    // rejected attribute produced on an older engine.
    let tokenised = 0;
    for (const n of ICON_NAMES) {
      const markup = render({ name: n });
      const tag = openTag(markup);
      if (!/ stroke="currentColor"/.test(tag)) {
        expect(tag, `${n} is filled and must carry no weight`).not.toContain("stroke-width");
        continue;
      }
      const style = tag.match(/style="([^"]*)"/)?.[1] ?? "";
      const rootHasToken = style.includes("stroke-width:var(--icon-stroke)");
      const childWeights = (markup.slice(tag.length).match(/stroke-width="/g) ?? []).length;
      expect(rootHasToken || childWeights > 0, `${n} has neither a root weight nor per-shape weights`).toBe(true);
      if (rootHasToken) tokenised++;
    }
    expect(tokenised).toBeGreaterThan(10);
  });

  it("a caller's own weight wins, as its attribute used to (the reader's gear at 1.9)", () => {
    const style = openTag(render({ name: "gear", size: "sm", strokeWidth: 1.9 })).match(/style="([^"]*)"/)?.[1] ?? "";
    expect(style).toContain("stroke-width:1.9");
    expect(style).not.toContain("var(--icon-stroke)");
  });
});

describe("a caller's own sizing and style survive", () => {
  it("explicit width/height props win over the token (the reader's 18px gear)", () => {
    const tag = openTag(render({ name: "gear", size: "sm", width: 18, height: 18 }));
    const style = tag.match(/style="([^"]*)"/)?.[1] ?? "";
    expect(style).toContain("width:18px");
    expect(style).toContain("height:18px");
    expect(style).not.toContain("var(--icon-sm)");
    expect(tag).not.toMatch(/\swidth="/);
  });

  it("a caller's style is merged, not spread over the size", () => {
    // `style={{ opacity }}` used to REPLACE the component's style because `...rest` was spread last.
    // With the size now in the style, that would have re-created the very failure this guards.
    const style = openTag(render({ name: "navLibrary", size: "md", style: { opacity: 0.85 } })).match(/style="([^"]*)"/)?.[1] ?? "";
    expect(style).toContain("opacity:0.85");
    expect(style).toContain("width:var(--icon-md)");
    expect(style).toContain("display:block");
  });
});
