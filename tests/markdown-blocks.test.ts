import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, blocks } from "@/components/assistant/Markdown";

describe("assistant Markdown lists", () => {
  it("one numbered list when blank lines sit between the items", () => {
    const b = blocks("Steps:\n\n1. Open it\n\n2. Check it\n\n3. Send it");
    expect(b.map((x) => x.kind)).toEqual(["p", "ol"]);
    const ol = b[1]!;
    expect(ol.kind === "ol" && ol.items).toEqual(["Open it", "Check it", "Send it"]);
    const html = renderToStaticMarkup(createElement(Markdown, { text: "1. a\n\n2. b\n\n3. c" }));
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(3);
  });

  it("tight lists and several blank lines still make one list", () => {
    expect(blocks("1. a\n2. b").map((x) => x.kind)).toEqual(["ol"]);
    expect(blocks("- a\n\n\n- b").map((x) => x.kind)).toEqual(["ul"]);
  });

  it("a paragraph between numbered items splits the list, and the next one carries on from its own number", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: "1. first\n\nSome words in between.\n\n2. second" }),
    );
    expect(html.match(/<ol/g)).toHaveLength(2);
    expect(html).toContain('<ol start="2"');
  });

  it("a bullet list after a numbered one is its own list", () => {
    expect(blocks("1. a\n\n- b").map((x) => x.kind)).toEqual(["ol", "ul"]);
  });

  it("paragraphs keep their blank-line breaks", () => {
    expect(blocks("one\n\ntwo").map((x) => x.kind)).toEqual(["p", "p"]);
  });
});
