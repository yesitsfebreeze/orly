```
  , .  
 {@,@}  
 /) )   
  '"  

I have done what you asked, here is... oRly
```

# orly

**Your agent says "done". orly says "oh rly?"** At the end of every turn it checks the
work against your specs. If something isn't true, the stop is refused and the agent is
sent back with the gap named. One gate, one adapter per coding agent.

[![stars](https://img.shields.io/github/stars/yesitsfebreeze/orly?style=flat)](https://github.com/yesitsfebreeze/orly/stargazers)
[![tests](https://img.shields.io/badge/bun%20test-144%20pass-green)](test)
[![license](https://img.shields.io/badge/license-MIT-blue)](package.json)

## The technique

A reviewer that re-reads the whole conversation costs as much as the agent did. orly
doesn't read the conversation. It reduces the turn to a **bounded state** and asks a
**System One judge** typed questions about it, in **one request**, getting back
**probabilities, not prose**.

- **The state.** The request, the closing message, what the agent said, one line per tool
  call (the last 40, 300 chars each) and the tool output that matters (the last 12
  results, failures kept first, 600 chars each). Files a spec names are read from disk
  (8 at most, 12000 chars each), never from what the agent printed. A 200k-token session
  and a 2k-token one produce a state of the same order.
- **The questions.** Four yes/no hazards (a claim nothing verified, a stub left standing,
  a part never addressed, a failure never reported), one choice of the next step, one
  score for coverage, and one yes/no per spec of yours. All evaluated in parallel over
  the same state; adding a spec adds a question, not a request.
- **The policy, in code.** A hazard blocks above its cut; a spec passes above its cut;
  cuts are fitted from the log, never guessed. A spec a command can decide (`require:
  checks.tests.exit equals 0`) is asserted by running it: zero judge tokens.
- **The verdict.** The block names the gap and one next step (fix the failure, verify the
  claim, finish the work, report the blocker). The agent's next round starts from that
  sentence, not from a human re-prompt carrying the whole context. Every banner prints
  the judge's token count for the turn, so the cost is never a claim.

## Install

Needs [bun](https://bun.sh) and a [TypeSafe](https://console.typesafe.ai) key in `TYPESAFE_API_KEY`.

```sh
claude plugin marketplace add yesitsfebreeze/orly && claude plugin install orly@orly   # Claude Code
git clone https://github.com/yesitsfebreeze/orly ~/orly && bun ~/orly/bin/orly.ts install <agent>
#   codex gemini cursor copilot droid qwen goose opencode kilo pi continue junie
```

`orly install` merges into the agent's own hook file, adds `/orly` in the agent's format,
and is safe to run twice (`--global`, `--dry-run`). Codex, Gemini, Copilot, Droid and Pi
also take this repository through their own plugin installers.

| Agent | Gate |
|---|---|
| Claude Code, Codex, Gemini CLI, Copilot CLI, Goose, Pi | blocks the stop, reason sent back |
| Droid, Qwen Code, Continue, Junie | same hook dialect as Claude Code |
| Cursor · OpenCode, Kilo | follow-up message · plugin re-prompts the session |
| Windsurf, Cline, Kiro, Amp, Aider | no hook can hold the agent: `orly judge` from your loop |

Details per agent in [docs/hosts.txt](docs/hosts.txt). Any loop: `echo '{"messages":[…]}' | orly judge` (0 may stop, 2 not done, 1 could not run).

## Usage

```
/orly add retries to the http client        writes 5–12 specs, validates them, starts work
/orly it said tests pass but one failed     freezes the turn as a case, adds the spec, replays
orly ask "is the stub gone?" src/thing.ts   a yes/no now, between turns
orly hosts                                  every agent and how it is gated
```

It fails closed: a malformed spec blocks. It can't trap you: the agent stops when every
spec passes, when it says plainly what it couldn't do, or when the round cap runs out. And
the agent can't file it down: lowering a cut or deleting a spec is refused, in the edit
hook and again at the stop.

## Measured

Twelve labelled turns in `test/fixtures/`, judged live by `bun test/calibrate.ts` on
2026-09-23 ([docs/measured.txt](docs/measured.txt), regenerated rather than edited):

| | result |
|---|---|
| block / pass decided correctly | 12 / 12 |
| next step named, on blocked turns | 5 / 5 |
| unverified claim: quiet at most / fires at least | 0.44 / 0.94 |
| placeholder left | 0.30 / 0.98 |
| unaddressed part | 0.53 / 0.94 |
| silent failure | 0.39 / 0.96 |

Scores move about 0.05 between runs; a cut is fitted from the log (`orly fit`), never guessed.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=yesitsfebreeze/orly&type=Date)](https://star-history.com/#yesitsfebreeze/orly&Date)

Deeper: [writing specs](docs/specs.txt) · [the guard](docs/guard.txt) · [porting](docs/porting.txt) · [install](docs/install.txt) · [llms.txt](llms.txt)
