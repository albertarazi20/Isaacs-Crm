import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentProps, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "@/components/ui";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });

// Field takes its children as a prop; createElement passes them as arguments, so view it without the required prop
const FieldNoKids = Field as FunctionComponent<Omit<ComponentProps<typeof Field>, "children">>;

describe("Field", () => {
  const child = createElement("button", { type: "button" }, "pick");
  it("is a <label> by default and a labelled group for a control made of buttons", () => {
    const plain = renderToStaticMarkup(createElement(FieldNoKids, { label: "Name" }, child));
    expect(plain.startsWith("<label")).toBe(true);
    const grouped = renderToStaticMarkup(
      createElement(FieldNoKids, { label: "Follow up", group: true }, child),
    );
    expect(grouped).not.toContain("<label");
    expect(grouped).toContain('role="group"');
    // the group is named by its caption
    const id = /aria-labelledby="([^"]+)"/.exec(grouped)?.[1];
    expect(id).toBeTruthy();
    expect(grouped).toContain(`id="${id}"`);
  });
});

describe("no label wraps a control made of many buttons", () => {
  // inside a <label>, a click on the caption or a gap presses the first button in it and silently changes the value
  const MULTI_BUTTON = /<(TimerPicker|TimeSelect)\b/;
  it("every <Field> that holds a TimerPicker or a TimeSelect is a group", () => {
    const offenders: string[] = [];
    for (const file of files(join(process.cwd(), "src", "components"))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<Field\b([^>]*)>([\s\S]*?)<\/Field>/g)) {
        if (MULTI_BUTTON.test(m[2] ?? "") && !/\bgroup\b/.test(m[1] ?? ""))
          offenders.push(file.replace(process.cwd(), ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
