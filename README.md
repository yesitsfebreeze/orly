```
  , .  
 {@,@}  
 /) )   
  '"  

I have done what you asked, here is... oRly
```

# orly

**Your agent says "done". orly says "oh rly?"** A Claude Code plugin that turns your goal
into yes/no questions, asks a judge at the end of every turn, and refuses the stop until
every answer is yes. Under 500 lines of code, one hook, one CLI.

## How it works

1. `/orly:orly <goal>` has the agent write one question per acceptance criterion into
   `.orly/specs/`, then run `orly specs`, which rejects anything the judge could not decide
   from evidence.
2. When the agent tries to end a turn, the Stop hook reduces the turn to a bounded state
   (request, what the agent said, one line per tool call, the tool output that matters, files
   a spec names read from disk) and asks [jev](https://console.typesafe.ai) every question in
   one request.
3. Anything below its cut blocks the stop, and the reason names exactly what is not yet true.
   The agent works on that, not on a re-prompt carrying the whole conversation.

Where a command can decide, no tokens are spent: a spec with `require: checks.tests.exit
equals 0` runs the check from `.orly/config.json` in code, and a failing check blocks before
the judge is asked at all. Four built-in questions cover the ways agents stop early: an
unverified claim, a stub left standing, a part never addressed, a failure never reported.
Every judgment prints its token count.

## Install

Needs [bun](https://bun.sh) and a [TypeSafe](https://console.typesafe.ai) key in `TYPESAFE_API_KEY`
(or a `keyCommand` in `.orly/config.json` that prints it).

```sh
claude plugin marketplace add yesitsfebreeze/orly && claude plugin install orly@orly
```

## Usage

```
/orly:orly add retries to the http client   writes the specs, validates them, starts the work
/orly:orly it said tests pass but one failed  adds the question that would have caught it
orly specs                                    is every spec decidable from recorded evidence?
orly ask "is the stub gone?" src/thing.ts     one yes/no now, between turns
orly tree                                     every spec and how it is decided
echo '{"messages":[…]}' | orly judge          any loop: exit 0 may stop, 2 not done, 1 could not run
```

A spec is a file: optional `key: value` headers, a blank line, one question.

```
evidence: src/http.ts

Look at `src/http.ts` under `project.files`, the file's real content. Does every request
go through a retry loop with a bounded number of attempts?
```

It fails closed on your specs: a file that does not parse blocks every turn until fixed, and
the agent cannot delete a spec, lower a cut or mark one optional without the next stop being
refused. It fails open on itself: a judge that is down never becomes a wall. It cannot trap
the agent: the loop ends when every spec holds, when the agent says plainly what it could
not do and why, or at the round cap (`rounds: 6` in `.orly/goal`).

## Measured

`bun test/calibrate.ts` judges the twelve labelled turns in `test/fixtures/` live and prints
each hazard's separation and the token total, so the numbers are regenerated rather than
quoted. `bun test` runs offline against a local fake judge.

Deeper: [writing specs](docs/specs.txt) · [llms.txt](llms.txt)
