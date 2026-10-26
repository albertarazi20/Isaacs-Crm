/** RFC 4180 CSV: quoted fields, "" escapes, CRLF or LF, a leading BOM. No dependencies. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
    } else if (ch === "\n") endRow();
    else field += ch;
  }
  if (quoted) throw new Error("The file has an opening quote that never closes");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
