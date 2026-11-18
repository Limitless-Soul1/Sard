// The selection toolbar exists in the application, but on WebKit the words it points at live two
// frames deep: section iframe -> reader host iframe -> application. Both seams have to work for the
// toolbar to appear in the right place. These guards cover the two hosted-only failures.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { HostedReader, rectInApp } from "../../src/reader-transport/hosted";

type Probe = {
  frame: { getBoundingClientRect: () => { left: number; top: number } } | null;
  receive: (msg: unknown) => void;
};

describe("hosted selection anchoring", () => {
  it("adds the host frame's offset without changing the rect's size", () => {
    const rect = { left: 30, top: 120, bottom: 156, width: 240, height: 36 };
    expect(rectInApp(rect, { left: 12, top: 74 })).toEqual({
      left: 42,
      top: 194,
      bottom: 230,
      width: 240,
      height: 36,
    });
  });

  it("translates the rect before handing a host selection to the application callback", () => {
    const reader = new HostedReader();
    const probe = reader as unknown as Probe;
    probe.frame = { getBoundingClientRect: () => ({ left: 12, top: 74 }) };
    const handler = vi.fn();
    reader.handlers.set("onSelection", handler);

    const selection = {
      cfi: "/4/2[nameid(5)]/1:0",
      text: "a remembered passage",
      rect: { left: 30, top: 120, bottom: 156, width: 240, height: 36 },
    };
    probe.receive({ kind: "event", name: "onSelection", args: [selection] });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual({
      ...selection,
      rect: { left: 42, top: 194, bottom: 230, width: 240, height: 36 },
    });
  });

  it("translates every event whose payload carries a host-viewport rect", () => {
    const src = readFileSync("src/reader-transport/hosted.ts", "utf8");
    for (const name of ["onSelection", "onShowAnnotation", "onReferenceHit"]) {
      expect(src).toContain(`"${name}"`);
    }
    expect(src).toContain("rectInApp(first.rect, this.frame.getBoundingClientRect())");
  });

  it("subscribes the toolbar only after the hosted controller has resolved", () => {
    const reader = readFileSync("src/features/reader/Reader.tsx", "utf8");
    expect(reader).toContain("const [ctrlReady, setCtrlReady] = useState(!needsReaderHost())");
    expect(reader).toContain("ctrlRef.current = await hostedRef.current;");
    expect(reader).toContain("setCtrlReady(true);");
    expect(reader).toContain("ready={ctrlReady}");

    const layer = readFileSync("src/features/reader/AnnotationLayer.tsx", "utf8");
    expect(layer).toContain("if (!ready) return;");
    expect(layer).toMatch(/\}, \[ready\]\);/);
  });
});
