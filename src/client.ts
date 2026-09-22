/**
 * The one way this library talks to the judge.
 *
 * There were three: the gate's, `orly ask`'s and `orly specs`'s — each with its own
 * endpoint default, its own auth header, its own idea of what a bad response was. Three
 * copies of a transport means three places to get a timeout wrong and three error strings
 * for the same outage, and a host porting the library had no single thing to point at.
 *
 * Everything above this file deals in questions and answers. Nothing else does HTTP.
 */

export const ENDPOINT_DEFAULT = "https://api.typesafe.ai/v1/systemone";
export const MODEL_DEFAULT = "jev-latest";

export type Transport = {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
};

export type Answers = Record<string, any>;
export type Usage = { input_tokens: number; output_tokens: number };

/**
 * One request, however many questions. They are independent judgments over the same
 * state, so they are evaluated in parallel — TypeSafe measured 13 batched at 12.2x
 * cheaper and 10x faster than 13 separate calls, with the same answers. Asking one thing
 * at a time is the only way to use this badly.
 */
export async function ask(
  state: unknown,
  questions: Record<string, unknown>,
  t: Transport,
): Promise<{ answers: Answers; usage?: Usage }> {
  const res = await fetch(t.endpoint || ENDPOINT_DEFAULT, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: t.model || MODEL_DEFAULT, questions }),
    signal: AbortSignal.timeout(t.timeoutMs ?? 12_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  // A 200 that is not the documented shape means we reached something that is not the
  // judge — a proxy, a captive portal, a stray local service on the same port. It once
  // was exactly that, answering {"ok":true}. Treat it as an outage, never as evidence
  // about the turn.
  if (!out?.answers || typeof out.answers !== "object") throw new Error("response had no answers");
  return { answers: out.answers, usage: out.usage };
}
