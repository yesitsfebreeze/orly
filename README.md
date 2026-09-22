```
  ; ,
 {@.@}
 /) )  oRly?
  "'
```

Your agent says it's done. orly asks the obvious question — at the end of **every** turn,
before the stop goes through. Whatever isn't true comes back with the gap named, and the
agent keeps working until it is.

A library and a CLI. Claude Code is one adapter, in one file.

```sh
claude plugin marketplace add /path/to/orly && claude plugin install orly@orly-local
```

Then `/orly:orly <your goal>` — it writes the checks, then holds you to them.

Any other loop — opencode, pi, your own — pipes its message log in and reads the exit code:

```sh
echo '{"messages":[…]}' | orly judge   # 0 = may stop, 2 = not done yet
```

Anthropic and OpenAI message shapes both work. [Porting](docs/porting.txt) is one file.

## What it catches that a test suite can't

- Tests it said it ran, and didn't.
- A TODO standing in for the feature you asked for.
- The third item of a three-item request, quietly dropped.
- A figure in the summary that no command produced.

## Why it holds

**It reads your files, not the agent's story about them.** A check names the files it
depends on; orly opens them itself at judging time. Stub still on disk → blocked.

**Facts are decided in code.** Exit codes, diagnostic counts, line counts: asserted
directly. No model, no threshold, no drift.

**Anything else that decides "done" is one command away.** Name a ticket, a deploy, a
migration status in `.orly/config.json` and its output is judged alongside your code. No
connectors to install.

**The agent can't file it down.** Lowering a bar, deleting a check or marking one optional
is refused by the harness — at the edit, and again at the end of the turn.

**It can't trap you.** Three exits, all in code: everything passes, you say plainly what
you couldn't do, or the round cap runs out.

## What it costs

One request per turn. Measured on a real turn: **under 400 ms, 2,610 input tokens —
about $1.10 per 10,000 turns.**

## Between turns

```sh
orly ask "is the stub gone?" "is there a test for it?" src/thing.ts
git diff | orly ask --json "does this touch auth?" -
```

Same judge, same key, answers in under a second. Batching is nearly free, so ask twenty
things at once. `--json` for a program on the other end; exit 2 if any answer is no.

## Does it work

12 fixtures against the live judge: **12/12** right about block-vs-pass, and on blocked
turns it names the right next step **5/5**. Regenerate with `bun test/calibrate.ts --write`.

## Deeper

[`docs/`](docs/), indexed for machines in [`llms.txt`](llms.txt):
[why the turn boundary](docs/why.txt) · [install](docs/install.txt) ·
[writing specs](docs/specs.txt) · [calibration](docs/calibration.txt) ·
[measured](docs/measured.txt) · [the state problem](docs/state.txt) ·
[the guard](docs/guard.txt) · [learning](docs/learning.txt) · [porting](docs/porting.txt)

MIT.
