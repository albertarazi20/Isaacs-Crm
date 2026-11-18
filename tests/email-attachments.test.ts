import { describe, expect, it } from "vitest";
import { buildRawEmail } from "@/lib/email/raw";

/** An email with files: the readable part first, then each file, the way every mail client reads it. */
describe("attachments", () => {
  const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
  it("wraps text and HTML and the files in multipart/mixed", () => {
    const raw = decode(
      buildRawEmail({
        from: "rep@x.com",
        to: "rep@x.com",
        subject: "Accepted",
        text: "Plain words",
        html: "<p>Designed</p>",
        attachments: [
          {
            filename: 'Farm - Driver\'s "license".pdf',
            contentType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3]),
          },
          { filename: "check.png", contentType: "image/png", bytes: new Uint8Array([9]) },
        ],
      }),
    );
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="=_mix_/);
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="=_alt_/);
    expect(raw).toContain(
      'Content-Disposition: attachment; filename="Farm - Driver\'s _license_.pdf"',
    );
    expect(raw).toContain('Content-Disposition: attachment; filename="check.png"');
    expect(raw).toContain(Buffer.from([1, 2, 3]).toString("base64"));
    expect(raw).toContain(Buffer.from("Plain words").toString("base64"));
    // the closing boundary of the whole message is there
    expect(raw.trimEnd().endsWith("--")).toBe(true);
  });
  it("refuses a file type that could break a header", () => {
    expect(() =>
      buildRawEmail({
        from: "a@x.com",
        to: "a@x.com",
        subject: "s",
        text: "t",
        attachments: [
          { filename: "f", contentType: "text/plain\r\nBcc: x@y.com", bytes: new Uint8Array([1]) },
        ],
      }),
    ).toThrow(/bad attachment type/);
  });
  it("without files is the message it always was", () => {
    const raw = decode(buildRawEmail({ from: "a@x.com", to: "a@x.com", subject: "s", text: "t" }));
    expect(raw).not.toContain("multipart/mixed");
  });
});

describe("sending files through Gmail", () => {
  it("uses Gmail's upload address with the message itself when there are files, and the JSON send without", async () => {
    const { sendViaGmail } = await import("@/lib/email/gmail");
    const { encryptSecret } = await import("@/lib/crypto");
    const key = Buffer.alloc(32, 7).toString("base64");
    const creds = { refreshTokenEnc: encryptSecret("refresh", key), googleEmail: "rep@x.com" };
    const cfg = { clientId: "c", clientSecret: "s", tokenEncKey: key };
    const calls: { url: string; type: string }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("oauth2"))
        return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      calls.push({ url: u, type: new Headers(init?.headers).get("content-type") ?? "" });
      return new Response(JSON.stringify({ id: "m1", threadId: "t1" }), { status: 200 });
    }) as typeof fetch;
    await sendViaGmail(
      creds,
      cfg,
      {
        to: "rep@x.com",
        subject: "s",
        text: "t",
        attachments: [
          { filename: "a.pdf", contentType: "application/pdf", bytes: new Uint8Array([1]) },
        ],
      },
      fake,
    );
    await sendViaGmail(creds, cfg, { to: "rep@x.com", subject: "s", text: "t" }, fake);
    expect(calls).toEqual([
      {
        url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
        type: "message/rfc822",
      },
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        type: "application/json",
      },
    ]);
  });
});
