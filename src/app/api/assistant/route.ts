import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { anthropicCaller, runAssistantTurn } from "@/lib/assistant/run";
import { toActionError } from "@/lib/data/errors";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
// a hosted request gets 60 seconds; the turn stops starting model calls well before that and hands back "more"
export const maxDuration = 60;

const body = z.object({
  threadId: z.string().uuid().nullable(),
  /** null continues a turn the last request handed back */
  message: z.string().max(6000).nullable(),
  /** The label on the button that asked, for the conversation's name in the history list. */
  title: z.string().max(200).nullable().optional(),
});

function apiErrorWords(e: InstanceType<typeof Anthropic.APIError>): string {
  if (e instanceof Anthropic.RateLimitError)
    return "The assistant is busy right now. Try again in a minute.";
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return "The assistant's key was refused. A manager needs to check it in the server settings.";
  if (e instanceof Anthropic.APIConnectionError)
    return "Couldn't reach the assistant. Check the connection and try again.";
  return "The assistant ran into a problem. Try again.";
}

/**
 * One turn with the assistant, streamed as newline-delimited JSON: {t:"thread"}, {t:"text"}, {t:"tool"},
 * {t:"actions"}, {t:"notice"}, then {t:"done", more} or {t:"error"}. Same-origin only.
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host"))
    return Response.json({ error: "Not allowed" }, { status: 403 });
  const session = await requireSession();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "That request doesn't look right" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // once the browser has gone (Stop, a closed tab) every later write throws: that also stops the model call,
      // whose spend up to that point is still counted (runAssistantTurn logs an unfinished call)
      let gone = false;
      const send = (event: Record<string, unknown>) => {
        if (gone) throw new Error("the browser went away");
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch (e) {
          gone = true;
          throw e;
        }
      };
      const last = (event: Record<string, unknown>) => {
        try {
          send(event);
        } catch {
          // nobody is listening any more
        }
      };
      try {
        const result = await runAssistantTurn({
          userId: session.userId,
          threadId: parsed.data.threadId,
          message: parsed.data.message,
          title: parsed.data.title ?? null,
          keySet: Boolean(env().ANTHROPIC_API_KEY),
          caller: anthropicCaller(),
          events: {
            thread: (id) => send({ t: "thread", id }),
            text: (d) => send({ t: "text", d }),
            tool: (name, label) => send({ t: "tool", name, label }),
            actions: (actions) => send({ t: "actions", actions }),
            notice: (message) => send({ t: "notice", message }),
            discard: () => send({ t: "discard" }),
          },
        });
        last({ t: "done", threadId: result.threadId, more: result.more });
      } catch (e) {
        if (gone) return;
        if (!(e instanceof Anthropic.APIError)) console.error("assistant turn failed:", e);
        last({
          t: "error",
          message: e instanceof Anthropic.APIError ? apiErrorWords(e) : toActionError(e),
        });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed by the browser leaving
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
