// Tests that stub the judge must not append to the real ~/.jev/log; temp state (check output, sandboxes) goes with the run.
import { afterAll, setDefaultTimeout } from "bun:test"; import { mkdtempSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const run = mkdtempSync(join(tmpdir(), "orly-test-"));
process.env.TMPDIR = run;
process.env.HOME = mkdtempSync(join(run, "home-"));
// bunfig's [test] timeout is not honoured (bun 1.3.14): subprocess-heavy tests blow the 5s default under load.
setDefaultTimeout(30_000);
afterAll(() => rmSync(run, { recursive: true, force: true }));
