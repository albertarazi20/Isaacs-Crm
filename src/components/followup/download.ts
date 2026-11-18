/** Hands a text file to the browser's download. */
export function downloadFile(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
