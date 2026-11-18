export interface Finding {
  rule: string;
  line: number;
  /** Redacted: the first four characters and the length. Never the value. */
  preview: string;
  /** The matched text, for allowlist matching only. Never print it. */
  value: string;
}
export interface SecretAllow {
  path: string;
  rule?: string;
  contains?: string;
  reason: string;
}
export interface HttpAllow {
  path: string;
  url?: string;
  reason: string;
}
export interface AdvisoryAllow {
  id: string;
  reason: string;
}
export interface Allowlist {
  secrets: SecretAllow[];
  http: HttpAllow[];
  advisories: AdvisoryAllow[];
}
export interface AuditAdvisory {
  id: string;
  severity: string;
  name: string;
  title: string;
  url: string;
  vulnerable: string;
  patched: string;
}
export function jwtRole(value: string): string | null;
export function entropy(s: string): number;
export function looksRandom(value: string): boolean;
export function redact(value: string): string;
export function redactUrl(url: string): string;
export function isPlaceholderValue(value: string): boolean;
export function passwordOfUrl(url: string): string;
export function scanText(text: string): Finding[];
export function findHttpUrls(text: string): { line: number; url: string }[];
export function isForbiddenEnvFile(path: string): boolean;
export function isBackupFile(path: string): boolean;
export function parseAllowlist(raw: unknown): Allowlist;
export function secretAllowed(entry: SecretAllow, path: string, finding: Finding): boolean;
export function httpAllowed(entry: HttpAllow, path: string, url: string): boolean;
export function summariseAudit(
  stdout: string,
  ignore?: AdvisoryAllow[],
): { advisories: AuditAdvisory[]; ignored: number; total: number };
