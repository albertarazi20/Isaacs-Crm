// A stand-in for the Anthropic Messages API on localhost, so the assistant can be driven end to end without a key
// and without any traffic leaving this machine. It streams the same server-sent events the real API streams, and it
// answers from what the CRM sends it (the merchants the CRM's own tools returned), so the CRM's checks run for real;
// it says nothing about what a real model would answer.
//
// Start a dev server for it with:
//   ANTHROPIC_API_KEY=sk-ant-stub ANTHROPIC_BASE_URL=http://127.0.0.1:4019 pnpm dev --port 3008
// and run the suite with WIRE_AI=stub BASE_URL=http://localhost:3008.
import http from "node:http";

export const STUB_PORT = 4019;

const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n");

/** What the assistant would do next, given the conversation so far. */
function nextTurn(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const today =
    /\[Today is \w+ (\d{4}-\d{2}-\d{2})/.exec(textOf(messages[0]?.content))?.[1] ?? "2026-01-01";
  const results = Array.isArray(last?.content)
    ? last.content.filter((b) => b.type === "tool_result")
    : [];
  if (results.length === 0) {
    return { blocks: [{ tool: "list_follow_ups", input: { when: "overdue" } }], stop: "tool_use" };
  }
  // which tool answered? find the tool_use in the previous assistant turn
  const prev = messages[messages.length - 2];
  const used = (prev?.content ?? []).find(
    (b) => b.type === "tool_use" && b.id === results[0].tool_use_id,
  );
  if (used?.name === "list_follow_ups") {
    let rows = [];
    try {
      rows = JSON.parse(results[0].content);
    } catch {
      rows = [];
    }
    const first = rows[0];
    if (!first)
      return { blocks: [{ text: "Nothing is overdue. **Nice work.**" }], stop: "end_turn" };
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const tomorrow = d.toISOString().slice(0, 10);
    return {
      blocks: [
        {
          text: `You have ${rows.length} overdue. Start with **${first.business}**:\n\n1. Call ${first.contact || "the owner"} at ${first.phone}.\n2. Ask for the application today.\n3. If there is no answer, try again tomorrow.`,
        },
        {
          tool: "propose_actions",
          input: {
            actions: [
              {
                type: "set_follow_up",
                label: `Call ${first.business} tomorrow`,
                merchant_id: first.merchant_id,
                date: tomorrow,
              },
              {
                type: "add_note",
                label: "Note the plan",
                merchant_id: first.merchant_id,
                note: "Plan from the assistant: call, ask for the application today.",
              },
              {
                type: "copy",
                label: "Copy a text to send",
                text: `Hi, it's me from Selective Capital. Got a minute today?`,
              },
              { type: "open", label: "Open the call list", href: "/today" },
            ],
          },
        },
      ],
      stop: "tool_use",
    };
  }
  return { blocks: [{ text: "\n\nClick a button to do it." }], stop: "end_turn" };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

/** Starts the stub; `calls` records every request body, `close()` stops it. */
export function startModelStub(port = STUB_PORT) {
  const calls = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        // an unreadable body gets the 400 below
      }
      calls.push({ url: req.url, body });
      const system = JSON.stringify(body.system ?? "");
      if (
        !req.url?.startsWith("/v1/messages") ||
        !system.includes("You are the assistant inside Selective CRM") ||
        !body.stream
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "stub: unknown call" },
          }),
        );
        return;
      }
      const turn = nextTurn(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, "message_start", {
        message: {
          id: `msg_stub_${++n}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1200,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
      turn.blocks.forEach((b, index) => {
        if (b.text !== undefined) {
          sse(res, "content_block_start", {
            index,
            content_block: { type: "text", text: "", citations: null },
          });
          for (const piece of b.text.match(/[\s\S]{1,24}/g) ?? [])
            sse(res, "content_block_delta", { index, delta: { type: "text_delta", text: piece } });
        } else {
          sse(res, "content_block_start", {
            index,
            content_block: {
              type: "tool_use",
              id: `toolu_stub_${n}_${index}`,
              name: b.tool,
              input: {},
            },
          });
          sse(res, "content_block_delta", {
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
          });
        }
        sse(res, "content_block_stop", { index });
      });
      sse(res, "message_delta", {
        delta: { stop_reason: turn.stop, stop_sequence: null },
        usage: { output_tokens: 180 },
      });
      sse(res, "message_stop", {});
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({ calls, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}
