```
   , .
  {@,@}
  /) )
---'"-------- orly
```

# orly

**Your agent says "done". orly asks "oh really?"** orly is a guard check for coding agents. The
agent turns the user's request into guards: one yes/no question each about the finished work,
decided by a shell command where one can. At every stop the open guards are checked against the
recorded turn. An unmet guard refuses the stop, and the agent keeps working until every guard is
upheld.

orly is one file, `orly.ts`, run with [bun](https://bun.sh). No dependencies.

## How it works

1. **A prompt arrives.** The hook tells the agent which guards the session has and how to add
   one. For a request that asks for work, the agent writes 2 to 6 guards before it starts:

   ```sh
   orly guard "Do command_results show bun test exiting 0 after the last edit?" --check "bun test"
   orly guard "Does README.md list every plugin in exactly one tier?" --file README.md
   orly guard "Does the final message name the changed file and how to verify it?"
   ```

2. **The agent stops.** Every guard with a `--check` runs its command: exit 0 upholds it. The
   remaining open guards go to the [TypeSafe](https://typesafe.ai) Jev judge in one request,
   over a bounded view of the turn (the request, what the agent said, one line per tool call, the
   results that matter) plus the files the guards name. A judged guard that holds is retired; a
   check runs at every stop, so a regression reopens it.

3. **A guard is not upheld.** The stop is refused with the guard named and, for a check, the
   last lines of its output. The agent fixes the work and stops again; that stop is not judged.
   A guard that cannot be met: the agent says so and names why. Only the user drops a guard.

Guards live per session in `~/.orly/sessions/<session>.json` and go with the session. There is no
spec tree in the repository, no goal file and no baseline. A session with no guards judges nothing.

Two safety rails only loosen the gate: after 6 refusals in a row, or 3 without a new guard upheld,
the turn ends with a note so the user can decide.

## Install

Needs bun 1.1 or newer and a TypeSafe API key.

```sh
git clone https://github.com/yesitsfebreeze/orly ~/orly
export TYPESAFE_API_KEY=...        # or {"keyCommand": "..."} in ~/.orly/config.json
alias orly="bun ~/orly/orly.ts"
```

### Claude Code

```sh
claude plugin marketplace add ~/orly && claude plugin install orly@orly
```

Hooks: `UserPromptSubmit` (the guard brief), `Stop` (the check, in the background; a pass shows
nothing, a refusal wakes the agent with one message), `SessionEnd` (cleanup). `/orly:orly` loads
the skill that teaches the agent to write guards.

### Codex CLI

```sh
codex plugin marketplace add ~/orly && codex plugin add orly@orly
```

Same hooks through `install/codex/adapter.ts`, reading the rollout transcript under
`~/.codex/sessions`. Approve the hooks once under `/hooks`.

## Commands

```
orly guard "<question>" [--check "<cmd>"] [--file <path>]…   add one guard
orly guards                                                   list the session's guards
orly drop <id>                                                remove one (on the user's word only)
orly check                                                    {messages:[…]} or {turn:{…}} on stdin; exit 2 = refused
orly end                                                      forget the session
```

The session is `--session <id>`, else `ORLY_SESSION`, else `CLAUDE_CODE_SESSION_ID`.

## Writing a guard

- **One yes/no question about evidence**: a command result, a file's content, the final
  message. Taste words (clean, readable, robust, proper) are rejected.
- **`--check` when a command decides it.** Exit 0 is upheld. Never reaches the judge.
- **`--file` when the question is about file state.** The judge sees the real current content,
  so "is the stub gone from duration.js" is decidable.
- The agent's own words are a claim, not evidence. A recorded command result is evidence.

## Environment

| variable | default | meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | - | the judge's key; or `keyCommand` in `~/.orly/config.json` |
| `TYPESAFE_BASE_URL`, `ORLY_MODEL` | api.typesafe.ai, `jev-latest` | endpoint and model |
| `ORLY_GUARD_MET` | 0.7 | probability at which a judged guard is upheld |
| `ORLY_TIMEOUT_MS` | 15000 | judge request timeout |
| `ORLY_CHECK_TIMEOUT_MS` | 60000 | per check; a killed check is not upheld |
| `ORLY_FILE_CHARS` | 12000 | per `--file`, head and tail beyond that |
| `ORLY_MAX_ROUNDS` | 6 | refusals in a row before the turn ends with a note |

Status for a status line: `~/.orly/status/<session>.json` (`pct`, `blocked`, `items`).

## Development

```sh
bun test
```

MIT.
