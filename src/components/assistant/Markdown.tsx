import { Fragment, type ReactNode } from "react";

/**
 * The little formatting the assistant uses (paragraphs, numbered and bulleted lists, **bold**, `code`, short
 * headings), rendered as React text, never as HTML: nothing the model writes can become markup or a link.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith("**") ? (
        <strong key={`${key}-${i++}`} className="font-semibold text-text">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <code
          key={`${key}-${i++}`}
          className="rounded-md bg-surface-2 px-1 py-0.5 font-mono text-[12px]"
        >
          {tok.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number }
  | { kind: "h"; text: string };

/** Exported for tests. */
export function blocks(src: string): Block[] {
  const out: Block[] = [];
  for (const raw of src.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    const prev = out[out.length - 1];
    if (!line.trim()) {
      // one marker per gap: it ends a paragraph, and a list that follows may still continue the one before it
      if (!(prev && prev.kind === "p" && prev.lines.length === 0))
        out.push({ kind: "p", lines: [] });
    } else if (heading) {
      out.push({ kind: "h", text: heading[1]! });
    } else if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const item = bullet ? bullet[1]! : numbered![2]!;
      // a blank line between items ("1. a", "", "2. b") is still one list, so the steps count 1, 2, 3
      const gap = prev && prev.kind === "p" && prev.lines.length === 0;
      const before = gap ? out[out.length - 2] : prev;
      if (before && before.kind === kind) {
        if (gap) out.pop();
        before.items.push(item);
      } else if (kind === "ol") out.push({ kind, items: [item], start: Number(numbered![1]) });
      else out.push({ kind, items: [item] });
    } else if (prev && (prev.kind === "ul" || prev.kind === "ol") && /^\s{2,}/.test(raw)) {
      // an indented continuation line belongs to the last list item
      prev.items[prev.items.length - 1] += ` ${line.trim()}`;
    } else if (prev && prev.kind === "p") {
      prev.lines.push(line);
    } else {
      out.push({ kind: "p", lines: [line] });
    }
  }
  return out.filter((b) => b.kind !== "p" || b.lines.length > 0);
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2.5 text-[14px] leading-[1.6] text-text-2">
      {blocks(text).map((b, bi) => {
        const k = `b${bi}`;
        if (b.kind === "h")
          return (
            <p key={k} className="pt-1 text-[13px] font-semibold tracking-tight text-text">
              {inline(b.text, k)}
            </p>
          );
        if (b.kind === "p")
          return (
            <p key={k}>
              {b.lines.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 ? <br /> : null}
                  {inline(l, `${k}-${li}`)}
                </Fragment>
              ))}
            </p>
          );
        const List = b.kind === "ol" ? "ol" : "ul";
        return (
          <List
            key={k}
            {...(b.kind === "ol" && b.start !== 1 ? { start: b.start } : {})}
            className={
              b.kind === "ol"
                ? "list-decimal space-y-1.5 pl-5 marker:font-semibold marker:text-accent"
                : "list-disc space-y-1.5 pl-5 marker:text-muted"
            }
          >
            {b.items.map((it, ii) => (
              <li key={ii} className="pl-1">
                {inline(it, `${k}-${ii}`)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
