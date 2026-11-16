// A stand-in for the Anthropic Messages API on localhost, so the AI controls (ask a deal, import a lender's page,
// import a screenshot) can be driven end to end without a key and without any traffic leaving this machine. It
// answers from the prompt it is given, so the CRM's own checks (quotes really in the text, citations really on the
// timeline) run for real; it says nothing about what a real model would answer.
//
// Start the dev server for it with:
//   ANTHROPIC_API_KEY=sk-ant-stub ANTHROPIC_BASE_URL=http://127.0.0.1:4019 pnpm dev --port 3008
// and run the suite with WIRE_AI=stub.
import http from "node:http";

export const STUB_PORT = 4019;

/** The events in the ask prompt: `[e3] 2026-11-16 12:00 · lender · actor: Title — detail`. */
function askEvents(user) {
  return [...user.matchAll(/^\[(e\d+)\] [^·]*· [^·]*· [^:]*: (.*)$/gm)].map((m) => {
    const [title, ...rest] = m[2].split(" — ");
    return { ref: m[1], title: title.trim(), detail: rest.join(" — ").trim() };
  });
}

function askReply(user) {
  const question = /Question: (.*)$/m.exec(user)?.[1] ?? "";
  if (/unknowable|favourite colour|favorite color/i.test(question))
    return {
      answer: "The timeline has nothing about that.",
      cannot_answer: true,
      citations: [],
      confidence: "low",
    };
  const events = askEvents(user).filter((e) => e.title.split(/\s+/).length >= 3);
  const picked = [
    ...events.filter((e) => /declined|approved/i.test(e.title)).slice(0, 1),
    ...events.filter((e) => /^Sent to/.test(e.title)).slice(0, 1),
  ];
  const cites = (picked.length ? picked : events.slice(0, 1)).map((e) => ({
    ref: e.ref,
    quote: e.title,
  }));
  // a citation to an event that does not exist, so the check that drops unverifiable ones is exercised too
  if (/bogus/i.test(question)) cites.push({ ref: "e999", quote: "a line nobody ever wrote down" });
  return {
    answer: `It was sent out and one lender has answered. ${cites.length} lines of the timeline say so.`,
    cannot_answer: false,
    citations: cites,
    confidence: /bogus/i.test(question) ? "medium" : "high",
  };
}

function readReply(user) {
  const email = /<email>\n([\s\S]*)\n<\/email>/.exec(user)?.[1] ?? "";
  const hit = /[^.]*\bdecline[^.]*/i.exec(email);
  if (!hit)
    return {
      event: "no_change",
      is_from_lender: true,
      lender_name: "",
      business_name: "",
      offer: null,
      offers_count: 0,
      decline_reason: null,
      stips_requested: [],
      portal_link_only: false,
      summary: "Nothing about the deal.",
      next_step: "",
      evidence: [],
      confidence: 0.9,
    };
  return {
    event: "declined",
    is_from_lender: true,
    lender_name: "",
    business_name: "",
    offer: null,
    offers_count: 0,
    decline_reason: "revenue",
    stips_requested: [],
    portal_link_only: false,
    summary: "The lender declined the file: revenue is too low.",
    next_step: "Reshop it to another lender.",
    evidence: [{ field: "event", quote: hit[0].trim().slice(0, 100) }],
    confidence: 0.92,
  };
}

const transcriptReply = () => ({
  transcript:
    "Lender portal. Application status: we have to decline this deal. Reason given: monthly revenue is too low for our program.",
  legible: true,
  looks_like: "lender_portal",
});

/** Starts the stub; `calls` records every request body, `close()` stops it (the "AI unreachable" case). */
export function startModelStub(port = STUB_PORT) {
  const calls = [];
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
      const system =
        typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
      const first = body.messages?.[0]?.content;
      const user =
        typeof first === "string" ? first : (first ?? []).map((b) => b.text ?? "").join("\n");
      let out = null;
      if (system.startsWith("You answer one question")) out = askReply(user);
      else if (system.startsWith("You read one email")) out = readReply(user);
      else if (system.startsWith("You transcribe screenshots")) out = transcriptReply();
      if (!req.url?.startsWith("/v1/messages") || out === null) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "stub: unknown call" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: body.model ?? "claude-opus-5-5",
          content: [{ type: "text", text: JSON.stringify(out) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 400, output_tokens: 120 },
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({ calls, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}
