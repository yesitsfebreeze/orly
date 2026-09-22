```
  , .  
 {@,@}  
 /) )   
  '"  

I have done what you asked, here is... oRly
```

# orly

**Your agent says "done". orly says "oh rly?"** — and checks, at the end of every turn,
before the stop goes through. If it isn't true, the agent is sent back with the gap named.

## Install

```sh
claude plugin marketplace add /path/to/orly && claude plugin install orly@orly-local
```

Then `/orly:orly <your goal>`. It writes the checks, then holds the agent to them.

Other loops (opencode, your own) pipe the message log in and read the exit code:

```sh
echo '{"messages":[…]}' | orly judge   # 0 = may stop, 2 = not done yet
```

`orly schema` prints both accepted shapes with a working example; a bad shape is named
before any request is spent. [Porting](docs/porting.txt) is one file.

## What you get

- **No fake "tests pass".** A claim without the command output behind it is blocked.
- **No stubs shipped as features.** A TODO where the work should be is blocked.
- **Nothing silently dropped.** Item three of a three-item request gets done.
- **No invented numbers.** A figure no command produced is blocked.
- **Checks on real files.** Specs read your files at judging time, not the agent's summary.
- **Hard facts decided in code.** Exit codes and counts are asserted directly; no model.
- **Your own sources.** Any command in `.orly/config.json` (ticket, deploy, migration)
  becomes evidence. No connectors.
- **An examiner the agent can't edit down.** Loosening a cut or deleting a spec is refused.
- **A malformed spec blocks.** It never waves the turn through.
- **Every mistake becomes a check.** `/orly:orly <what went wrong>` freezes the turn,
  writes the spec that catches it, replays every past case, and fixes the work.
- **Claims on every definition.** `src/http.ts.orly` holds lines like `fetchWithRetry: is
  exported`; `orly claims` judges each against that symbol's current source, all files in
  parallel, in any language: orly finds the right language server from public indexes
  and installs it when first needed (`orly servers` shows the plan).
  A renamed symbol fails instead of drifting.
- **Specs scale.** One small file each in `.orly/specs/<group>/`; `orly tree` indexes them.
- **No trap.** The agent stops when everything passes, when it says plainly what it
  couldn't do, or when the round cap runs out.

## Ask between turns

```sh
orly ask "is the stub gone?" "is there a test for it?" src/thing.ts
git diff | orly ask --json "does this touch auth?" -
```

Same judge. Batch many questions at once. Exit 2 if any answer is no.

## Does it work

12 fixtures against the live judge: **12/12** right on block-vs-pass, and **5/5** right
next step on blocked turns. Reproduce: `bun test/calibrate.ts`.
On your own work: `orly replay` scores every recorded case and keeps the history.
Cost and latency: [measured](docs/notes/measured.txt).

## More

[install](docs/install.txt) · [writing specs](docs/specs.txt) ·
[the guard](docs/guard.txt) · [porting](docs/porting.txt) · for machines: [`llms.txt`](llms.txt).
How it was built and measured: [`docs/notes/`](docs/notes/).

MIT.
