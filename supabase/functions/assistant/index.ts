// Supabase Edge Function "assistant" (Deno). Two jobs for signed-in users of Dilapidation Inspector:
//   { type: "ask", messages: [{ role, content }...] }  → answer how-to questions from the user guide (Claude)
//   { type: "feedback", kind, message, page }          → store a bug report / idea and email it to the app owner
// Secrets (Project Settings → Edge Functions → Secrets): ANTHROPIC_API_KEY (required for "ask"),
// RESEND_API_KEY + OWNER_EMAIL (optional: email copies of feedback; feedback is always stored in public.feedback).
import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";
import { createClient } from "npm:@supabase/supabase-js@2";
import { HELP_GUIDE } from "./guide.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You are the built-in help assistant of Dilapidation Inspector, a web app for recording building-condition inspections on floor plans, used by architects and inspectors on site (often on a phone) and in the office.

Answer questions about how to use the app, using the user guide below as your only source of truth about what the app can do. Give short, practical, step-by-step answers that name the exact buttons and menus. Phone users are common, so mention the phone way when it differs.

If the guide does not cover something, or the app cannot do it, say so plainly — do not invent buttons, settings or features — and suggest sending it as an idea with the "Suggest an improvement" tab in Help. For questions outside the app (engineering judgement, legal or safety advice about a building), say that is outside what this assistant covers.

<user_guide>
${HELP_GUIDE}
</user_guide>`;

type Turn = { role: "user" | "assistant"; content: string };
const validTurns = (x: unknown): x is Turn[] =>
  Array.isArray(x) && x.length > 0 && x.length <= 20 &&
  x.every((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.length <= 4000) &&
  x[0].role === "user" && x[x.length - 1].role === "user";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  // Only signed-in app users (their own token, so database rules apply to them).
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Sign in to use Help → Ask and Suggest an improvement." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }

  if (body.type === "ask") {
    if (!validTurns(body.messages)) return json({ error: "Bad request." }, 400);
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "The assistant is not switched on yet (no API key on the server). The Guide tab has the answers." }, 503);
    const client = new Anthropic({ apiKey: key });
    try {
      const res = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 2000,
        output_config: { effort: "low" }, // short how-to answers
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: body.messages as Turn[],
      });
      if (res.stop_reason === "refusal") return json({ answer: "Sorry, I can't help with that one. For anything about using the app, ask away — or send it as a suggestion." });
      const answer = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      return json({ answer: answer || "Sorry, I have no answer for that. Try the Guide tab." });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json({ error: "The assistant is busy — try again in a minute." }, 429);
      if (e instanceof Anthropic.AuthenticationError) return json({ error: "The assistant's API key on the server is not valid." }, 503);
      if (e instanceof Anthropic.APIError) return json({ error: `The assistant could not answer (${e.status}).` }, 502);
      return json({ error: "The assistant could not answer right now." }, 502);
    }
  }

  if (body.type === "feedback") {
    const kind = ["bug", "idea", "question"].includes(String(body.kind)) ? String(body.kind) : "idea";
    const message = String(body.message ?? "").trim().slice(0, 5000);
    const page = String(body.page ?? "").slice(0, 300);
    if (message.length < 3) return json({ error: "Please write a little more." }, 400);
    const { error } = await supabase.from("feedback").insert({ user_id: user.id, email: user.email, kind, message, page });
    if (error) return json({ error: `Could not save: ${error.message}` }, 500);

    let emailed = false;
    const resend = Deno.env.get("RESEND_API_KEY"), to = Deno.env.get("OWNER_EMAIL");
    if (resend && to) {
      const label = { bug: "Bug report", idea: "Improvement idea", question: "Question" }[kind];
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("FEEDBACK_FROM") ?? "Dilapidation Inspector <onboarding@resend.dev>",
          to: [to],
          reply_to: user.email ?? undefined,
          subject: `${label} from ${user.email ?? "a user"}`,
          text: `${label} from ${user.email ?? user.id}\nScreen: ${page || "-"}\n\n${message}\n\n(Also stored in the Supabase table public.feedback.)`,
        }),
      });
      emailed = r.ok;
    }
    return json({ ok: true, emailed });
  }

  return json({ error: "Bad request." }, 400);
});
