/** The only HTTP transport to the judge; everything else deals in questions and answers. */

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

/** One request for all questions: independent judgments over one state, evaluated in parallel. */
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
  // A 200 without `answers` came from something other than the judge (proxy, captive
  // portal, stray local service): an outage, never evidence about the turn.
  if (!out?.answers || typeof out.answers !== "object") throw new Error("response had no answers");
  return { answers: out.answers, usage: out.usage };
}
