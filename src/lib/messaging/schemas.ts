import "../zod-setup";
import { z } from "zod";
import { findSensitive } from "../data/sensitive";
import { MERGE_FIELDS, leftoverFields, isMergeField, splitSubject } from "./merge";

/** Single-line: no line breaks or control characters (they would become email header injection). */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep that under ${max} characters`)
    .regex(/^[^\p{Cc}]*$/u, "That field can't contain line breaks or control characters");

/** Multi-line text that never holds an SSN, card or account number (CLAUDE.md: never store those). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep that under ${max.toLocaleString("en-US")} characters`)
    .regex(
      /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/,
      "That text has characters that can't be saved",
    )
    .superRefine((v, ctx) => {
      const hit = findSensitive(v);
      if (hit) ctx.addIssue({ code: "custom", message: hit.message });
    });

export const MAX_SNIPPETS = 60;
export const SNIPPET_BODY_MAX = 3000;
export const SIGNATURE_MAX = 1000;

const FIELD_LIST = MERGE_FIELDS.map((f) => `{${f}}`).join(", ");

export const snippetSchema = z
  .object({
    id: z.string().uuid().optional(),
    title: line(80).min(1, "Give the snippet a name"),
    kind: z.enum(["text", "email"]),
    body: text(SNIPPET_BODY_MAX).min(1, "Write the message first"),
  })
  .superRefine((v, ctx) => {
    for (const token of leftoverFields(v.body)) {
      if (!isMergeField(token.slice(1, -1))) {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: `${token} isn't a field I know. The fields are ${FIELD_LIST}.`,
        });
        return;
      }
    }
    if (v.kind === "email") {
      const { subject, body } = splitSubject(v.body);
      if (/^\s*subject:/i.test(v.body) && subject === null) {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "The Subject: line is empty. Write a subject after it, or take the line out.",
        });
      } else if (subject !== null && subject.length > 200) {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "The Subject: line is too long (200 characters at most).",
        });
      } else if (subject !== null && body.trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "Add some message text under the Subject: line.",
        });
      }
    }
  });
export type SnippetInput = z.output<typeof snippetSchema>;

export const snippetIdSchema = z.object({ id: z.string().uuid() });

/** A full web address starting with http:// or https://, or blank. */
const webAddress = line(500).refine((v) => {
  if (v === "") return true;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !/\s/.test(v);
  } catch {
    return false;
  }
}, "Enter a full web address that starts with https://");

export const messageSettingsSchema = z.object({
  signature: text(SIGNATURE_MAX),
  applicationLink: webAddress,
});
export type MessageSettingsInput = z.output<typeof messageSettingsSchema>;

export const messagingContextSchema = z.object({ clientId: z.string().uuid() });
