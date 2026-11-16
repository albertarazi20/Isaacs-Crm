type Fetch = typeof fetch;

/**
 * The two Google Sheets API calls the sync needs, as plain fetches (no SDK), the way email/gmail.ts talks to Gmail.
 * The access token comes from accessTokenFor() on the user's stored refresh token.
 */

export interface SheetTab {
  title: string;
  gid: number;
  rowCount: number;
}

export async function listTabs(
  token: string,
  spreadsheetId: string,
  fetchImpl: Fetch = fetch,
): Promise<{ title: string; tabs: SheetTab[] }> {
  const res = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new SheetsError(res.status, await res.text());
  const body = (await res.json()) as {
    properties?: { title?: string };
    sheets?: {
      properties?: { title?: string; sheetId?: number; gridProperties?: { rowCount?: number } };
    }[];
  };
  return {
    title: body.properties?.title ?? "",
    tabs: (body.sheets ?? []).map((s) => ({
      title: s.properties?.title ?? "",
      gid: s.properties?.sheetId ?? 0,
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    })),
  };
}

/** Every cell of a tab as strings. Google returns rows only up to the last non-empty one. */
export async function readTab(
  token: string,
  spreadsheetId: string,
  tabTitle: string,
  fetchImpl: Fetch = fetch,
): Promise<string[][]> {
  const range = tabTitle ? `'${tabTitle.replace(/'/g, "''")}'` : "A:ZZ";
  const res = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new SheetsError(res.status, await res.text());
  const body = (await res.json()) as { values?: unknown[][] };
  return (body.values ?? []).map((r) => r.map((c) => String(c ?? "")));
}

export class SheetsError extends Error {
  constructor(
    public status: number,
    detail: string,
  ) {
    super(
      status === 403
        ? "Google says this account can't read that sheet. Share the sheet with the connected account, or reconnect Google with Sheets access."
        : status === 404
          ? "That sheet was not found. Check the link."
          : `Google Sheets error (${status}): ${detail.slice(0, 200)}`,
    );
    this.name = "SheetsError";
  }
}
