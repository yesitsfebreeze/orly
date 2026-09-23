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

## Install

Needs [bun](https://bun.sh) and a [TypeSafe](https://console.typesafe.ai) key in `TYPESAFE_API_KEY`.

```sh
claude plugin marketplace add yesitsfebreeze/orly && claude plugin install orly@orly   # Claude Code
codex plugin marketplace add yesitsfebreeze/orly                                        # Codex ($orly skill)
gemini extensions install https://github.com/yesitsfebreeze/orly                        # Gemini CLI (/orly)
copilot plugin install yesitsfebreeze/orly                                              # Copilot CLI
droid plugin marketplace add https://github.com/yesitsfebreeze/orly                     # Factory Droid
pi install git:github.com/yesitsfebreeze/orly                                           # Pi
```

Every agent, including those, gets its hooks from one command run in your project:

```sh
git clone https://github.com/yesitsfebreeze/orly ~/orly
bun ~/orly/bin/orly.ts install <agent>     # claude codex gemini cursor copilot droid qwen
                                           # goose opencode kilo pi continue junie
```

It merges into the agent's own hook file, adds an `/orly` command in the agent's format,
and is safe to run twice. `--global` writes the user-level file, `--dry-run` shows it.

| Agent | Gate | Agent | Gate |
|---|---|---|---|
| Claude Code, Codex, Gemini CLI, Copilot CLI | blocks the stop, reason sent back | Cursor | follow-up message (5 in a row) |
| Droid, Qwen Code, Continue, Junie | same hook dialect as Claude Code | OpenCode, Kilo | plugin re-prompts the session |
| Goose, Pi | blocks the stop | Windsurf, Cline, Kiro, Amp, Aider | no hook can hold the agent: use `orly judge` |

[docs/hosts.txt](docs/hosts.txt) has each agent's events, files and caveats. Any loop at all:

```sh
echo '{"messages":[…]}' | orly judge   # 0 = may stop, 2 = not done, 1 = could not run
```

## Usage

```
/orly add retries to the http client        writes 5–12 specs, validates them, starts work
/orly it said tests pass but one failed     freezes the turn as a case, adds the spec, replays
orly ask "is the stub gone?" src/thing.ts   a yes/no now, between turns
orly hosts                                  every agent and how it is gated
orly goal <group> "<text>" / orly tasks     append a goal; list unmet specs, top goal first
```

## What it checks

- **Claims without output.** "Tests pass" with no test run behind it is blocked.
- **Stubs and dropped items.** A TODO where the work should be, or a skipped part of the request.
- **Invented numbers.** A figure no command produced.
- **Your specs.** One file each in `.orly/specs/<group>/`. Facts (exit codes, counts)
  are decided in code; everything else by one judge request per turn, against your real
  files and any command you declare as evidence.

It fails closed: a malformed spec blocks. It can't trap you: the agent stops when every
spec passes, when it states plainly what it couldn't do, or when the round cap runs out.
And the agent can't file it down: lowering a cut or deleting a spec is refused, in the
edit hook and again at the stop.

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
