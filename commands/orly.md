---
description: Turn a goal into checkable specs and work until they pass — or report a mistake and have it fixed, specced and replayed in one go
argument-hint: <a goal> | <what went wrong>
allowed-tools: Read, Write, Bash, Glob, Grep
---

The user wrote: **$ARGUMENTS**

**First decide which of two things this is.** A goal ("add retries to the client") → follow
*Setting a goal*. A report that something went wrong ("it said tests pass but they
didn't", "that block was wrong", "you forgot X again") → skip straight to *When something
went wrong* and do all of it without asking.

## Setting a goal

Write the spec tree in `.orly/` at the project root, then start working toward the goal. From
that point on every turn you try to end is checked against these specs by Jev, and you
will be blocked until they pass.

## The contract a spec has to meet

A spec becomes one yes/no question asked about **the recorded evidence of a turn** —
which commands ran, what they printed, and what you told the user. Nothing else is
visible to the judge. So:

- **Write what would be observable.** "Do `command_results` show a test run reporting
  zero failures after the last edit?" — not "the tests are good".
- **Never make the judge simulate execution.** It is confidently wrong at reasoning about
  what code would do. Anchor to a command's *output*, not to the code's behaviour.
- **No judgements of taste.** Clean, elegant, readable, idiomatic, robust, proper — a spec
  containing any of these is rejected before it runs.
- **One thing per spec.** Split anything with an "and" in it.
- **5 to 12 specs.** Fewer misses the goal; more makes every turn a negotiation.

**Name the files a spec depends on.** A spec about file state is otherwise only answerable
from what you happened to print, which makes it unfalsifiable — you could edit nothing, say
"done", and pass. A header line `evidence: duration.js` makes the checker read that file
itself at judging time and put its real contents in front of the judge, under `project.files`.
Point the spec's wording at that entry.

**Evidence does not have to be a file.** If something outside the repository decides
whether the work is done — a ticket's acceptance criteria, a staging deploy, a migration
status — declare one command for it under `context` in `.orly/config.json` and name it in
`evidence:` exactly as you would a path. Its output is put in front of the judge under
`project.context`, and you ask about it in words.

```json
"context": { "ticket": { "command": "jira issue view $TICKET --plain" } }
```

Use a `require` check when a command can decide the answer, and a context source when
someone has to read it.

**And when nothing can produce it** — a design review, a screenshot, an answer only a
search will find — name it in `evidence:` anyway and add `gather: <what to do>`. The
block will ask for it in those words, and the next turn is judged on what you bring back.

Mark a spec `optional: yes` when it is desirable but you should be allowed to end the
turn by explaining why it was skipped.

## Shape

One file per spec, folders to group them. The file name is the id.

```
.orly/goal                         rounds: 6  (blank line)  the goal in one sentence
.orly/specs/build/tests_green.spec
.orly/specs/impl/no_stub.spec
```

A spec file is optional `key: value` header lines, a blank line, then the question:

```
evidence: duration.js

Look at the `duration.js` entry under `project.files`, which is the file's real current
content. Is the `throw new Error("not implemented")` stub gone?
```

Headers: `cut`, `require: <path> <op> <value>`, `evidence: a, b`, `optional: yes`,
`gather`, `true`, `false`. A file that does not parse blocks every turn until fixed.
`bun ${CLAUDE_PLUGIN_ROOT}/bin/orly.ts tree` prints the index.

## Do this in order

1. Read enough of the project to write specs that refer to its real commands and paths.
2. Write `.orly/goal` and one file per spec under `.orly/specs/`.
3. Run `bun "${CLAUDE_PLUGIN_ROOT}/bin/orly.ts" specs` — it word-filters for taste
   judgements and asks Jev whether each spec is decidable from recorded evidence. Rewrite
   every spec it rejects and re-run until it is clean. Do not start work on a spec list
   that has not passed this check; an unfalsifiable spec produces a confident number that
   means nothing, and you will be looping against noise.
4. Tell the user the spec list in one short block, then begin the work.

The loop ends when every spec is met, when you state plainly what you could not do and
why, or when the round cap runs out — whichever comes first.

## When something went wrong

Every mistake becomes a spec and a regression case, so it is caught next time. Do all of
this in one go, without stopping to ask:

1. **Find the turn.** `bun ${CLAUDE_PLUGIN_ROOT}/bin/orly.ts turns` — `last` is the newest
   judged turn; pick the one the user means.
2. **Decide the direction.** `block` if the gate let a mistake through, `pass` if it
   blocked a turn that was fine.
3. **Freeze it, spec it, replay it — one command.** For a missed mistake, write the
   question that would have caught it (observable, no taste words, see above) and file it
   in the group it belongs to:

   ```
   bun ${CLAUDE_PLUGIN_ROOT}/bin/orly.ts case last block "<what went wrong, in the user's words>" \
     --spec <group>/<id> --ask "<the question>"
   ```

   Use `--spec <group>/<id>` without `--ask` when an existing spec should have caught it.
   For a wrong block: `case <turn> pass "<why it was fine>"`, then reword the spec that
   fired — never lower its cut or delete it.
4. **Iterate until replay is all right.** The command replays every case against the
   live judge. If any case is wrong, edit the spec's wording (or add `evidence:` so it
   reads the real file) and run `orly replay` again. A fix that breaks an earlier case is
   not a fix.
5. **Fix the actual mistake** in the work itself, so the new spec passes on this turn.
6. **Report in three lines:** the spec file added, the case file, and the replay score.

Cases live in `.orly/cases/` and are committed. Each holds the turn verbatim: read it for
secrets before committing.
