```
   , .
  {@,@}
  /) )
---'"-------- orly
```

# orly

**Your agent says "done". orly asks "oh really?"** At the end of a coding agent's turn,
orly checks the recorded work against your project's specs. If a spec does not hold, the
stop is refused and the agent is sent back with the gap named.

orly is one file, `orly.ts`, run with [bun](https://bun.sh). It has no dependencies.

## How it works

- **A bounded state, not the transcript.** The turn is reduced to the user's request, what
  the agent said, one line per tool call (the last 40) and the tool results that matter
  (12 at most, failures first). A long session and a short one cost about the same to judge.
- **One request.** Four built-in hazard questions (an unverified claim, a stub left
  standing, a part never addressed, a failure never reported), a choice of next step, a
  coverage score and one yes/no question per spec all go to the
  [TypeSafe](https://typesafe.ai) Jev judge together. The judge answers with probabilities.
- **Policy in code.** Thresholds turn probabilities into block or pass. A spec that a
  command can decide (`require: checks.tests.exit equals 0`) runs that command and never
  reaches the judge.
- **A guard against easing the gate.** The agent being judged cannot lower a cut, delete a
  spec, or mark one optional to get an easier pass. See [docs/guard.txt](docs/guard.txt).

## Install

Needs bun 1.1 or newer and a TypeSafe API key.

```sh
git clone https://github.com/yesitsfebreeze/orly ~/orly
export TYPESAFE_API_KEY=...        # or "keyCommand" in .orly/config.json
alias orly="bun ~/orly/orly.ts"
```

### Claude Code

The repository is a Claude Code plugin. It gates the stop, refuses spec edits that weaken
the gate, briefs each session on the goals and specs, and cleans up when a session ends:

```sh
claude plugin marketplace add ~/orly && claude plugin install orly@orly
```

### OpenCode and Pi

One-line shims load the shipped adapters. On a block they prompt the session again with
the reason; spec edits that weaken the gate are refused.

```sh
mkdir -p .opencode/plugins && echo 'export { OrlyPlugin } from "'$HOME'/orly/install/opencode/plugin.ts";' > .opencode/plugins/orly.ts
mkdir -p .pi/extensions && echo 'export { default } from "'$HOME'/orly/install/pi/extension.ts";' > .pi/extensions/orly.ts
```

### Codex CLI

Codex runs command hooks from `~/.codex/hooks.json` (or `.codex/hooks.json` in a project).
Point Stop, SessionStart, SessionEnd and PreToolUse at the adapter:

```json
{ "hooks": {
  "Stop":         [{ "hooks": [{ "type": "command", "command": "bun ~/orly/install/codex/adapter.ts", "timeout": 25 }] }],
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun ~/orly/install/codex/adapter.ts", "timeout": 10 }] }],
  "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "bun ~/orly/install/codex/adapter.ts", "timeout": 5 }] }],
  "PreToolUse":   [{ "hooks": [{ "type": "command", "command": "bun ~/orly/install/codex/adapter.ts", "timeout": 10 }] }]
} }
```

Codex edits files through `apply_patch`, which the pre-edit guard cannot read; the gate's
baseline check catches a weakened spec at the end of the turn instead.

### Cursor

Copy `install/cursor/hooks.json` to `.cursor/hooks.json` (or `~/.cursor/hooks.json`). A block
becomes Cursor's follow-up message, and spec edits that weaken the gate are denied before
they happen. Cursor does not document its transcript format; the adapter reads it only when
it is JSONL of messages, and otherwise judges nothing but the weakening guard.

Other hosts can call the gate from their own turn-end hook; see
[docs/api.txt](docs/api.txt).

Without a key, `orly gate` allows every turn and says so once per session; `orly judge`
exits 1.

## Quick start

```sh
orly goal build "the test suite passes"                 # appends to .orly/goal
mkdir -p .orly/specs/build
printf 'require: checks.tests.exit equals 0\n\nDoes the test suite exit zero?\n' \
  > .orly/specs/build/tests_green.spec
echo '{"checks": {"tests": {"command": "bun test"}}}' > .orly/config.json
orly specs                                              # validate every spec
orly tasks                                              # list specs, goal order
```

Then feed a turn to the gate, from a hook or by hand:

```sh
orly gate --session my-session < turn.json
```

## Commands

| Command | Does |
|---|---|
| `orly judge` | `{"messages":[…]}` or `{"turn":{…}}` on stdin, verdict JSON on stdout |
| `orly gate` | the same input through the full gate: baseline guard, round cap |
| `orly goal [group] "<text>"` | appends a goal to `.orly/goal`, never overwrites |
| `orly tasks` | the specs, most important goal first |
| `orly specs` | validates every spec file and check name; exit 1 if any is rejected |
| `orly help` | the command list and environment variables |

Exit codes for `judge` and `gate`: `0` the turn may end, `2` it may not, `1` orly could not
run (`judge` only; `gate` fails open).

## Documentation

- [docs/install.txt](docs/install.txt): the `.orly` layout, the API key, environment variables
- [docs/specs.txt](docs/specs.txt): writing specs, goals, evidence, checks
- [docs/guard.txt](docs/guard.txt): what counts as weakening the gate
- [docs/api.txt](docs/api.txt): the library API, the Turn shape, wiring a host hook

## Development

```sh
bun test
```

The tests never call the live judge. This repository gates its own development with the
specs under `.orly/specs/`.

## License

[MIT](LICENSE.md)
