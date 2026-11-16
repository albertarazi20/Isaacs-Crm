/**
 * Watermarks (plan §Anti-backdooring 4): a statement opened in the app carries the viewer's name and the time;
 * a copy sent to a lender carries that lender's name and the date. A leaked file then says where it leaked from.
 * PDFs only — images pass through unchanged.
 */
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";

export async function watermarkPdf(bytes: Uint8Array, text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(14, Math.min(28, width / 24));
    const w = font.widthOfTextAtSize(text, size);
    // one diagonal line across the middle, one small line in the footer
    page.drawText(text, {
      x: width / 2 - (w * Math.cos(Math.PI / 6)) / 2,
      y: height / 2 - (w * Math.sin(Math.PI / 6)) / 2,
      size,
      font,
      color: rgb(0.55, 0.55, 0.6),
      opacity: 0.22,
      rotate: degrees(30),
    });
    page.drawText(text, { x: 18, y: 10, size: 7, font, color: rgb(0.4, 0.4, 0.45), opacity: 0.8 });
  }
  return pdf.save({ useObjectStreams: true });
}

export const isPdf = (contentType: string, bytes: Uint8Array): boolean =>
  contentType === "application/pdf" ||
  (bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46);
