# orly? is installed

orly is a turn-end gate: when you finish a turn it checks the work against the specs in
`.orly/specs/` and, if something is not true, sends you back with the gap named.

- `/orly <goal>` writes the specs for a goal and holds you to them.
- `/orly <what went wrong>` freezes the mistake as a case, writes the spec that catches it,
  and replays every earlier case.
- The hooks that judge each turn are wired by `orly install gemini` from the checkout of
  this extension (`bun bin/orly.ts install gemini`); the extension alone provides the command.
