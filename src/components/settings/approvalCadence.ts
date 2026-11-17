import { decodeEntities, htmlToText } from "@/lib/approvals/html";

/*
 * Pure helpers for Settings → Approval emails: hours ⇄ words, when each email goes, the inbox line of a design. No
 * "use client" on purpose: the server page builds its warnings with them and the editor draws with them.
 */

/** The most emails an approval gets, and the longest gap between two (the server's limits). */
export const MAX_APPROVAL_EMAILS = 6;
export const MAX_GAP_HOURS = 2160;

export type GapUnit = "hours" | "days";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Email 1 — the approval", then "Follow-up 1", "Follow-up 2"… */
export function emailTitle(step: number): string {
  return step <= 1 ? "Email 1 — the approval" : `Follow-up ${step - 1}`;
}

/** The short name, for a sentence: "Email 1", "Follow-up 2". */
export function emailName(step: number): string {
  return step <= 1 ? "Email 1" : `Follow-up ${step - 1}`;
}

/** 48 → 2 days; 36 → 36 hours. What the gap editor starts from. */
export function splitHours(hours: number): { value: number; unit: GapUnit } {
  return hours > 0 && hours % 24 === 0
    ? { value: hours / 24, unit: "days" }
    : { value: hours, unit: "hours" };
}

/** The gap editor's number and unit as whole hours, or why it cannot be saved. */
export function gapToHours(raw: string, unit: GapUnit): { hours: number } | { error: string } {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { error: "Enter a whole number" };
  const hours = Number(t) * (unit === "days" ? 24 : 1);
  if (hours < 1) return { error: "At least an hour" };
  if (hours > MAX_GAP_HOURS) return { error: "At most 90 days" };
  return { hours };
}

/** Exact: 24 → "1 day", 36 → "36 hours", 72 → "3 days". */
export function formatHours(hours: number): string {
  const { value, unit } = splitHours(hours);
  return plural(value, unit === "days" ? "day" : "hour");
}

/** Rounded, for a total the caller says "about" to: whole days from three days on, hours below that. */
export function roughHours(hours: number): string {
  if (hours % 24 === 0 || hours >= 72) return plural(Math.round(hours / 24), "day");
  return plural(hours, "hour");
}

export interface CadenceStep {
  step: number;
  delay_hours: number;
}

export interface CadencePoint {
  step: number;
  /** Hours after the email before it (0 for the first: it goes right away). */
  gapHours: number;
  /** Hours after the approval, if every email goes the moment it is due. */
  atHours: number;
}

/** When each email goes, counted from the approval. The first email's own delay never counts: it goes right away. */
export function cadence(steps: readonly CadenceStep[]): CadencePoint[] {
  let at = 0;
  return [...steps]
    .sort((a, b) => a.step - b.step)
    .map((s, i) => {
      const gap = i === 0 ? 0 : Math.max(0, s.delay_hours);
      at += gap;
      return { step: s.step, gapHours: gap, atHours: at };
    });
}

/** The sequence in a few words: "4 emails over about 6 days". */
export function cadenceSummary(steps: readonly CadenceStep[]): string {
  const points = cadence(steps);
  if (points.length === 0) return "No emails";
  const last = points[points.length - 1]!.atHours;
  if (points.length === 1 || last === 0) return `${plural(points.length, "email")}, right away`;
  return `${points.length} emails over about ${roughHours(last)}`;
}

/** The line under the timeline. */
export function lastEmailSentence(steps: readonly CadenceStep[]): string {
  const points = cadence(steps);
  if (points.length <= 1) return "Just the one email, right away.";
  const last = points[points.length - 1]!.atHours;
  if (last === 0) return "Every email goes right away.";
  return `If nobody replies, the last one goes about ${roughHours(last)} after the approval.`;
}

/** Where one email sits in the sequence, from the approval. */
export function sinceApproval(atHours: number): string {
  return atHours <= 0 ? "Right away" : `About ${roughHours(atHours)} after the approval`;
}

/** 9 → "9 AM", 12 → "Noon", 18 → "6 PM", 0 and 24 → "Midnight". */
export function hourLabel(hour: number): string {
  if (hour === 12) return "Noon";
  if (hour === 0 || hour === 24) return "Midnight";
  return `${hour % 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Monday to Friday, 9 AM to 6 PM, in each merchant's own time zone." */
export function windowSummary(start: number, end: number, weekends: boolean): string {
  return `${weekends ? "Every day" : "Monday to Friday"}, ${hourLabel(start)} to ${hourLabel(end)}, in each merchant's own time zone.`;
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** An email can go out once it has a design and a subject (the engine's own test). */
export function hasDesign(e: { html: string; subject: string }): boolean {
  return e.html.trim() !== "" && e.subject.trim() !== "";
}

/** The design's size as sent: UTF-8 bytes, the way Gmail counts toward its clip. */
export function byteSize(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 1000-based, like the size check's own message: "6.1 KB", "14.3 KB", "120 KB". */
export function formatKb(bytes: number): string {
  if (bytes < 1000) return `${plural(bytes, "byte")}`;
  const kb = bytes / 1000;
  return `${kb < 100 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

const HIDDEN = /<div\b[^>]*display\s*:\s*none[^>]*>([\s\S]*?)<\/div>/i;

/**
 * The grey line an inbox shows after the subject: the design's hidden preheader when it has one (what Gmail and Apple
 * Mail show), otherwise its opening words. Cut to about `max` characters.
 */
export function inboxPreview(html: string, max = 90): string {
  const m = HIDDEN.exec(html);
  const hidden = m
    ? decodeEntities((m[1] ?? "").replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
    : "";
  const text = hidden || htmlToText(html).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Is this a file the design picker takes? By name, since a browser may give an .htm no type at all. */
export function isHtmlFile(name: string, type: string): boolean {
  return /\.html?$/i.test(name) || type === "text/html";
}

/** One email of the sequence as the settings page hands it to the editor. */
export interface ApprovalEmailView {
  step: number;
  subject: string;
  html: string;
  fileName: string;
  delayHours: number;
  /** "Updated 3 hours ago by Josh Miller", worded on the server ("" when there is no design). */
  updated: string;
}

export interface ApprovalWindowView {
  on: boolean;
  windowStart: number;
  windowEnd: number;
  weekends: boolean;
}
