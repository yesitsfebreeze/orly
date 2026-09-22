import { QUESTIONS } from "../../src/gate.ts";
import { normalizeLastTurn } from "../../src/normalize.ts";
import { readFileSync } from "node:fs";
const KEY = Bun.spawnSync(["security","find-generic-password","-a","typesafe/api-key","-s","kern","-w"]).stdout.toString().trim();
const strip = (q: any) => { const { criteria, ...rest } = q; return rest; };
async function ask(state: any, questions: any) {
  const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }) });
  return (await r.json()).answers;
}
const NOULS = ["unverified_claim","placeholder_left","unaddressed_part","silent_failure"];
const withC: any = {}, without: any = {};
for (const id of NOULS) { withC[id] = (QUESTIONS as any)[id]; without[id] = strip((QUESTIONS as any)[id]); }
for (const f of ["a_lied","c_stub","d_dropped","g_blocked_declared","h_explain_only"]) {
  const state = normalizeLastTurn(JSON.parse("[]"));
  const [w, o] = [await ask(state, withC), await ask(state, without)];
  const row = NOULS.map(id => `${id.slice(0,9)} ${w[id].noul.toFixed(2)}/${o[id].noul.toFixed(2)}`).join("  ");
  console.log(`${f.padEnd(19)} ${row}`);
}
console.log("\nformat: with_criteria/without_criteria");
