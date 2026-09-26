---
name: orly
description: Turn a goal into checkable specs and work until they pass, or turn a reported mistake into the spec that catches it. Use when the user states a goal for this session, or says something the agent did was wrong.
---

The user wrote: **$ARGUMENTS** (when nothing follows, use their last message).

When nothing follows and `.orly/swarm/` exists in this repo, go to *Joining the swarm*.
Otherwise decide which this is. A goal ("add retries to the client") → *Setting a goal*. A report
that something went wrong ("it said tests pass but they didn't") → *When something went wrong*.

`orly` below means `bun "${CLAUDE_PLUGIN_ROOT}/orly.ts"`; without that variable it is
`orly.ts` in the orly checkout.

## Setting a goal

1. Read enough of the project to name its real commands and paths.
2. Write `.orly/goal` (`rounds: 6`, a blank line, then `- <group>: <text>` per goal) and one
   spec file per check under `.orly/specs/<group>/`. Put every check a command can decide
   into `checks` in `.orly/config.json` and assert it with `require:`.
3. Run `orly specs`. Rewrite every spec it rejects and re-run until clean; an undecidable
   spec yields a confident number that means nothing. If the judge cannot be reached, say
   so plainly: the word filter ran, decidability did not.
4. Show the user the spec list in one short block (`orly tasks`), then start the work.

From then on every turn you try to end is judged against these specs. The loop ends when
every spec is met, when you state plainly what you could not do and why, or when the
round cap runs out.

## Writing a spec

A spec is one yes/no question about the recorded evidence of a turn: commands run, their
output, what you said, and files orly reads from disk itself.

- **Observable.** "Do `command_results` show a test run reporting zero failures after the
  last edit?", not "the tests are good".
- **Output, not behaviour.** The judge cannot predict what code does at runtime.
- **No taste words** (clean, readable, idiomatic, robust, proper): rejected.
- **One thing per spec**, 5 to 12 specs.
- **Branch when it only sometimes applies:** "First check whether `actions_taken` edits X.
  If NOT, answer yes. If it does, answer yes only when …".

A file is optional `key: value` headers, a blank line, then the question. The file name
is the id.

```
evidence: duration.js

Look at the `duration.js` entry under `project.files`, which is the file's real current
content. Is the `throw new Error("not implemented")` stub gone?
```

Headers: `require: <path> <op> <value>` (decided in code from a check, e.g.
`require: checks.tests.exit equals 0` with `"checks": {"tests": {"command": "bun test"}}`),
`evidence: a, b` (files read at judging time), `cut: 0.6`, `optional: yes`, `true:` and
`false:` (what met and unmet look like). A file that does not parse blocks every turn
until fixed.

## When something went wrong

1. Write the question that would have caught it as a new spec in its group, with
   `evidence:` when it is about file state.
2. Run `orly specs`; reword until it is accepted.
3. Fix the mistake itself in the work, so the new spec is met this turn.
4. Report in two lines: the spec file, and what was fixed.

If a fine turn was blocked, reword the spec that fired so it branches on when it applies.
Never lower its cut or delete it: the next stop is refused when the spec set got weaker.

## Joining the swarm

This session joins the one swarm of this repo and keeps its sitters alive. More sessions mean
more workers; nothing else sets a count.

1. Read `.orly/swarm/swarm.md` (the director's brief and the rules every sitter keeps) and each
   seat in `.orly/swarm/seats/`.
2. Run `orly swarm`. Each line is one sitter this session hosts: `director` when the director's
   lease was free (this session now holds it), then `<seat>-<n>` for each seat whose `filled`
   query returned a row. The same session running it again gets the same names back.
3. Per line, unless that name is already live: `orly lane open <name>` (skip for `director`),
   then start one background worker named exactly that. Its prompt: the seat file with `<you>`
   replaced by the name and `<lane>` by the work dir, a line `---`, then swarm.md's rules.
   - Claude Code: `ListAgents` shows who is live; `Agent` with `name` set to it.
   - Codex: `spawn_agent` with the name as its task name (`work-1` may be written `work_1`;
     orly reads either); `send_input` relays a line, `wait` collects a finished worker.
   The sitter posts `seated <seat> at <sha>` when ready.
4. Watch the bus: Claude Code arms one `Monitor` on `orly bus watch <session-name> '*'`; Codex
   runs `orly bus read <session-name>` at the start of every turn. Relay what a sitter must see.
   Every wake: `orly bus lease director` when this session holds the director (a refusal means
   another session took it; stop hosting the director), `orly bus reap` if you host the director
   (releases the claims of sessions that are gone), and `orly swarm` again, seating new lines.
5. Only `orly lane land` writes the main branch. A sitter `orly lane put`s its files, and when
   the unit is whole runs `orly lane sync <name> && orly lane land <name> <slug>` itself: the land
   merges, gates on swarm.md's `gate` checks with the lane named, moves main and pushes, one
   land at a time. Red means not landed: fix and land again. The director lands only for a
   sitter that is gone (`orly bus pending`).
6. No seat blocks on the human, the director included: never call AskUserQuestion (the hook
   denies it to every seat). A seat that needs a decision writes `.orly/swarm/questions/<slug>.md`
   (frontmatter `status: open`; body the question and the options), posts `question <slug>` on the
   bus and keeps working. The director's brief, added to its prompt: every turn read the questions
   with `status: open`, tell the human once for each new one (Claude Code: `PushNotification`; Codex: say it in the turn's reply), and keep landing;
   the human's answer lands in that file verbatim.

Stopping: `orly bus unlease director` if held; the sitters end with the session and their names
free up.
