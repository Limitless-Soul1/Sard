// HOW A LEGAL DOCUMENT IS SET, in one place.
//
// Two surfaces show this text — the acceptance gate, and the copy kept in Settings so it can be
// read again afterwards. They must never be able to show it differently, so the rendering lives
// here and neither of them owns it.
//
// LINKS ARE DELIBERATELY PLAIN TEXT. The source marks a few up — the Privacy Policy, the LICENSE
// file, the issue tracker — and the extractor keeps the words and drops the `href`. Nothing here is
// clickable: a legal document is for reading, and a surface that must be answered is not a place to
// send someone somewhere else. No wording is lost, because in each case the link text IS the words.
import type { LegalBlock, LegalDocument } from "../../legal/content.generated";

/** One block, set the way Sard sets that kind of thing. The wording is the source's, untouched. */
function Block({ b }: { b: LegalBlock }) {
  if (b.k === "eyebrow") {
    return (
      <div style={{ font: "600 .6875rem var(--ui-font)", color: "var(--faint)", marginBottom: 4 }}>{b.t}</div>
    );
  }
  if (b.k === "h1") {
    return <h3 style={{ margin: "0 0 10px", font: "600 1.125rem var(--ui-font)", color: "var(--text)" }}>{b.t}</h3>;
  }
  if (b.k === "h2") {
    return <h4 style={{ margin: "20px 0 7px", font: "600 .875rem var(--ui-font)", color: "var(--text)" }}>{b.t}</h4>;
  }
  if (b.k === "stamp") {
    // The version and when it takes effect — the fact the whole mechanism turns on, so it is shown
    // rather than kept for the paperwork.
    return (
      <div style={{ font: "500 .75rem var(--ui-font)", color: "var(--faint)", margin: "0 0 14px" }}>{b.t}</div>
    );
  }
  if (b.k === "note") {
    return (
      <div
        style={{
          margin: "0 0 16px", padding: "11px 13px", borderRadius: "var(--r-md)",
          background: "var(--chrome-bg)", border: "1px solid var(--chrome-border)",
          font: "500 .8125rem/1.65 var(--ui-font)", color: "var(--text)",
        }}
      >
        {b.t}
      </div>
    );
  }
  if (b.k === "li") {
    return <li style={{ margin: "0 0 6px", font: "400 .8125rem/1.7 var(--ui-font)", color: "var(--muted)" }}>{b.t}</li>;
  }
  const lede = b.k === "lede";
  return (
    <p
      style={{
        margin: "0 0 10px",
        font: `400 ${lede ? ".875rem" : ".8125rem"}/1.75 var(--ui-font)`,
        color: lede ? "var(--text)" : "var(--muted)",
      }}
    >
      {b.t}
    </p>
  );
}

/** A whole document, in the interface's own language. Consecutive list items share one list. */
export function LegalBody({ doc, lang }: { doc: LegalDocument; lang: string }) {
  const blocks = lang === "ar" ? doc.ar : doc.en;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].k !== "li") {
      out.push(<Block key={i} b={blocks[i]} />);
      continue;
    }
    const run: LegalBlock[] = [];
    while (i < blocks.length && blocks[i].k === "li") run.push(blocks[i++]);
    i--;
    out.push(
      <ul key={`ul${i}`} style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>
        {run.map((b, j) => <Block key={j} b={b} />)}
      </ul>,
    );
  }
  return <>{out}</>;
}
