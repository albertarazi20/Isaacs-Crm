/** Hands a text file to the browser's download. */
export function downloadFile(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  // Excel needs the byte-order mark to read accents and curly quotes in a CSV; Response.text() strips it, so a file
  // that came from the server arrives without one. Adding it is a no-op when the text already has it.
  const body = type.startsWith("text/csv") && !text.startsWith("\uFEFF") ? `\uFEFF${text}` : text;
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  // in the page for the click (Safari and Firefox ignore a detached link), and the blob URL outlives it: the browser
  // reads it after click() returns, so revoking at once can leave an empty file
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
