/** A text body as a stream of 64 KB chunks. A streamed response is not held to the 4.5 MB cap that Vercel puts on a
 * buffered one, which a full backup will pass as the merchant list grows. */
export function textStream(text: string, chunkBytes = 64 * 1024): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(at, at + chunkBytes));
      at += chunkBytes;
    },
  });
}
