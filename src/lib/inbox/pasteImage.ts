import { costCents } from "../ai/readLenderEmail";
import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  TRANSCRIBE_PROMPT_VERSION,
  transcribeOfferImage,
  type ImageType,
  type Transcriber,
} from "../ai/transcribeImage";
import { UserError } from "../data/mutations";
import type { DbAccess } from "../db";
import { importPastedOffer, type PastedOfferResult } from "./paste";
import type { Reader } from "./process";

/**
 * Import an offer from a screenshot: the image is transcribed, the transcript goes through the pasted-text path
 * (the lender reader with its quote and arithmetic checks), and the terms land in the Review tray with source
 * 'pasted' for a manager to confirm. The kill switch and the daily spend cap gate both model calls.
 */
export interface OfferImageInput {
  dealId: string;
  submissionId?: string | null;
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
}

export interface OfferImageResult extends PastedOfferResult {
  transcript: string;
  looksLike: string;
}

const isImageType = (t: string): t is ImageType => (IMAGE_TYPES as readonly string[]).includes(t);

export async function importOfferImage(args: {
  db: DbAccess;
  userId: string;
  input: OfferImageInput;
  transcriber?: Transcriber;
  reader?: Reader;
}): Promise<OfferImageResult> {
  const { input } = args;
  if (!isImageType(input.mediaType))
    throw new UserError("Send a PNG, JPEG, WebP or GIF screenshot");
  if (input.bytes.length === 0) throw new UserError("The image is empty");
  if (input.bytes.length > MAX_IMAGE_BYTES) throw new UserError("The image is over 8 MB");

  const settings = await args.db.withUser(args.userId, async (q) => {
    const deal = (
      await q.query<{ id: string }>("select id from deals where id = $1", [input.dealId])
    ).rows[0];
    if (!deal) throw new UserError("That deal isn't in your view");
    const s = (
      await q.query<{
        ai_enabled: boolean;
        ai_model: string;
        ai_daily_cap_cents: number;
        spent: string;
      }>(
        "select ai_enabled, ai_model, ai_daily_cap_cents, app.ai_spent_today_cents()::text as spent from shop_settings",
      )
    ).rows[0];
    if (!s?.ai_enabled) throw new UserError("The AI reader is switched off in Settings");
    if (Number(s.spent) >= s.ai_daily_cap_cents)
      throw new UserError(
        "Today's AI spend cap is used up — try again tomorrow or raise it in Settings",
      );
    return s;
  });

  const transcriber: Transcriber =
    args.transcriber ?? ((img, model) => transcribeOfferImage(img, { model }));
  const out = await transcriber(
    { bytes: input.bytes, mediaType: input.mediaType },
    settings.ai_model,
  );
  await args.db.withUser(args.userId, (q) =>
    q.query("select record_ai_run('transcribe_offer_image', $1, $2::jsonb)", [
      input.dealId,
      JSON.stringify({
        model: out.model,
        prompt_version: TRANSCRIBE_PROMPT_VERSION,
        input_hash: out.inputHash,
        input_tokens: out.inputTokens,
        output_tokens: out.outputTokens,
        cost_cents: costCents(out.model, out.inputTokens, out.outputTokens),
        output: {
          filename: input.filename,
          looks_like: out.result.looks_like,
          legible: out.result.legible,
          chars: out.result.transcript.length,
        },
      }),
    ]),
  );
  if (!out.result.legible || out.result.transcript.trim().length < 20)
    throw new UserError(
      "That screenshot is not readable enough — zoom in on the terms and try again, or paste the text",
    );
  const pasted = await importPastedOffer({
    db: args.db,
    userId: args.userId,
    input: {
      dealId: input.dealId,
      submissionId: input.submissionId ?? null,
      text: `(transcribed from the screenshot ${input.filename})\n${out.result.transcript}`,
    },
    reader: args.reader,
  });
  return { ...pasted, transcript: out.result.transcript, looksLike: out.result.looks_like };
}
