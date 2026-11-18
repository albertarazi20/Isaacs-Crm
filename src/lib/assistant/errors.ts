import Anthropic from "@anthropic-ai/sdk";

/** What the browser is told when a model call fails. Plain words, never the API's own message. */
export function apiErrorWords(e: InstanceType<typeof Anthropic.APIError>): string {
  if (/credit balance/i.test(e.message))
    return "The assistant's Anthropic account is out of credit. A manager needs to add credits under Plans & Billing at console.anthropic.com.";
  if (e instanceof Anthropic.RateLimitError)
    return "The assistant is busy right now. Try again in a minute.";
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return "The assistant's key was refused. A manager needs to check it in the server settings.";
  if (e instanceof Anthropic.APIConnectionError)
    return "Couldn't reach the assistant. Check the connection and try again.";
  return "The assistant ran into a problem. Try again.";
}
