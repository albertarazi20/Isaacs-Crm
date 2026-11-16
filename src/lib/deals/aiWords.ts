/**
 * The AI controls (ask a question, import a lender's page) fail for reasons a person can act on, so the toast says
 * which. Pure and browser-safe: the actions use it to word a failure, the pages to explain a disabled control.
 */

export const NO_KEY_WORDS =
  "The AI isn't set up yet: this server has no Anthropic key. Ask whoever runs the app to add it.";

export interface AiReadinessInput {
  keyPresent: boolean;
  enabled: boolean;
  spentCents: number;
  capCents: number;
}

/** Why the AI controls cannot run right now, in plain words; null when they can. */
export function aiBlockedWords(i: AiReadinessInput): string | null {
  if (!i.keyPresent) return NO_KEY_WORDS;
  if (!i.enabled) return "The AI is switched off in Settings.";
  if (i.spentCents >= i.capCents)
    return "Today's AI spend cap is used up. Try again tomorrow or raise it in Settings.";
  return null;
}

interface MaybeApiError {
  status?: number;
  name?: string;
  message?: string;
}

/**
 * A failed model call in plain words, or null when the error is not the AI's (the caller then uses its generic
 * wording). Reads the shape of the SDK's errors rather than importing them, so nothing server-only comes along.
 */
export function aiFailureWords(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const err = e as MaybeApiError;
  const message = typeof err.message === "string" ? err.message : "";
  const name = typeof err.name === "string" ? err.name : "";
  // a key that was sent and refused (the API's own "invalid x-api-key") is not a missing key
  if (err.status === 401 || err.status === 403)
    return "Anthropic refused this server's key. Ask whoever runs the app to check it.";
  if (/could not resolve authentication|api[_ ]?key.*(missing|not set)/i.test(message))
    return NO_KEY_WORDS;
  if (/credit balance/i.test(message))
    return "The Anthropic account is out of credit. Add credit, then try again.";
  if (err.status === 429) return "The AI is busy right now. Try again in a minute.";
  if (typeof err.status === "number" && err.status >= 500)
    return "The AI service is having trouble. Try again in a few minutes.";
  if (
    /APIConnectionError|APIConnectionTimeoutError/.test(name) ||
    /connection error/i.test(message)
  )
    return "Couldn't reach the AI service. Check the connection and try again.";
  return null;
}
