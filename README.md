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
sent back with the gap named.

## Install

```sh
claude plugin marketplace add /path/to/orly && claude plugin install orly@orly-local
```

Then `/orly:orly <your goal>`: it writes the specs, then holds the agent to them.

Any other loop pipes its message log in and reads the exit code:

```sh
echo '{"messages":[…]}' | orly judge   # 0 = may stop, 2 = not done, 1 = could not run
```

`orly schema` prints the accepted input shapes with a working example.

## What it checks

- **Claims without output.** "Tests pass" with no test run behind it is blocked.
- **Stubs and dropped items.** A TODO where the work should be, or a skipped part of the request.
- **Invented numbers.** A figure no command produced.
- **Your specs.** One file each in `.orly/specs/<group>/`. Facts (exit codes, counts)
  are decided in code; everything else by one judge request per turn, against your real
  files and any command you declare as evidence.

It fails closed: a malformed spec blocks. It can't trap you: the agent stops when every
spec passes, when it states plainly what it couldn't do, or when the round cap runs out.
And the agent can't file it down: lowering a cut or deleting a spec is refused.

## Every mistake becomes a check

`/orly:orly <what went wrong>` freezes that turn as a case, writes the spec that catches
it, replays every earlier case, and fixes the work. By hand:

```sh
orly case last block "said tests pass while one failed" --spec build/tests_ran --ask "…"
orly replay     # every case against the current specs; exit 2 if any comes out wrong
```

## Ask between turns

```sh
orly ask "is the stub gone?" "is there a test for it?" src/thing.ts
git diff | orly ask --json "does this touch auth?" -
```

## Does it work

12 fixtures against the live judge: **12/12** right on block-vs-pass, **5/5** right next
step on blocked turns. Reproduce with `bun test/calibrate.ts`; the table is in
[measured](docs/measured.txt).

## More

[install](docs/install.txt) · [writing specs](docs/specs.txt) · [the guard](docs/guard.txt) ·
[porting](docs/porting.txt) · [measured](docs/measured.txt) · for machines: [`llms.txt`](llms.txt)

MIT.
