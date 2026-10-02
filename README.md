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
export TYPESAFE_API_KEY=...        # or "keyCommand" in .orly/config.json or ~/.orly/config.json
alias orly="bun ~/orly/orly.ts"
```

### Claude Code

The repository is a Claude Code plugin. It checks each finished turn, refuses spec edits
that weaken the gate, briefs each session on the goals and specs, and cleans up when a
session ends. The check runs in the background and shows nothing: a turn that passes ends
as usual, and a turn that fails wakes the agent with one message naming the unmet specs,
which the agent weighs itself (continue, or say why not and stop). The stop after that
message is not checked again. `/orly off` turns the gate off for the running session
(`/orly on` turns it back on, `/orly status` reports); the switch dies with the session:

```sh
claude plugin marketplace add ~/orly && claude plugin install orly@orly
```

### OpenCode and Pi

One-line shims load the shipped adapters. On a block they prompt the session again with
the reason; spec edits that weaken the gate are refused. The gate is inert until the
session arms it: nothing is injected and nothing is judged unless you type `/orly`
(`/orly off` disarms, `/orly status` reports). OpenCode arms on its own first idle event;
in Pi `/orly` is the only thing that arms it.

```sh
mkdir -p .opencode/plugins && echo 'export { OrlyPlugin } from "'$HOME'/orly/install/opencode/plugin.ts";' > .opencode/plugins/orly.ts
mkdir -p .pi/extensions && echo 'export { default } from "'$HOME'/orly/install/pi/extension.ts";' > .pi/extensions/orly.ts
```

OpenCode 2 loads plugins by package directory instead: add
`"plugins": [{"package": "<orly>/install/opencode"}]` to `opencode.jsonc`. It ignores
`main`, so the entry stays `index.ts`.

### Codex CLI

Codex installs orly as a plugin from this repo's own marketplace. The plugin carries the skill
and the hooks (`.codex-plugin/plugin.json` points Stop, SessionStart and SessionEnd at
`install/codex/adapter.ts`), and stays current on update:

```sh
codex plugin marketplace add ~/orly && codex plugin add orly@orly
```

Codex has no `/orly`: skills are not slash commands there. Type `$` and pick orly from the
skill list (or `/skills`) wherever this README says `/orly`.

Codex asks you to trust new hooks once: open `/hooks` in the TUI and approve orly's. Remove any
orly entries left in `~/.codex/hooks.json` from an older install, or the gate runs twice, and
any copy in `~/.codex/skills/orly`, which shadows the plugin's skill.

Codex edits files through `apply_patch`, which the pre-edit guard cannot read; the gate's
baseline check catches a weakened spec at the end of the turn instead.

### Cursor

Copy `install/cursor/hooks.json` to `.cursor/hooks.json` (or `~/.cursor/hooks.json`). A block
becomes Cursor's follow-up message, and spec edits that weaken the gate are denied before
they happen. Cursor does not document its transcript format; the adapter reads it only when
it is JSONL of messages, and otherwise judges nothing but the weakening guard.

Other hosts can call the gate from their own turn-end hook; see
[docs/api.txt](docs/api.txt).

Without a key, `orly gate` still blocks on a failing `require:` check, allows every other turn, and says so once per session; `orly judge`
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
| `orly ask "<question>" [path…]` | puts one yes/no question to the judge over project files: a file, a folder, a glob or `tree:<glob>`; with no path, over the file list and the files carrying the question's words; never gates |
| `orly on\|off\|status [--session <id>]` | turns the gate off for one session (nothing judged, no edit refused) and back on; the session is `--session`, else `ORLY_SESSION` |
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
