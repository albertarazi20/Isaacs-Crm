import { describe, expect, it } from "vitest";
import { textStream } from "@/lib/export/stream";

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe("streamed backup body", () => {
  it("comes out in several chunks and reassembles to exactly the same text", async () => {
    const text = JSON.stringify({ note: "Café — $1,250 « ok »".repeat(40_000) });
    const chunks = await drain(textStream(text, 64 * 1024));
    expect(chunks.length).toBeGreaterThan(5);
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }
    expect(new TextDecoder().decode(joined)).toBe(text);
  });

  it("an empty body is an empty stream, not an error", async () => {
    expect(await drain(textStream(""))).toEqual([]);
  });
});
