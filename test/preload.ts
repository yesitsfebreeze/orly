// Tests that stub the judge must not append to the real ~/.jev/log.
import { mkdtempSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
process.env.HOME = mkdtempSync(join(tmpdir(), "orly-home-"));
