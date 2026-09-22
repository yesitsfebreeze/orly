cut: 0.75
fitted: met>=0.96 unmet<=0.20 (state: transcript + file evidence; .orly at the repository root)

First check whether `actions_taken` contains an edit to any file that changes what the judge is shown: the question wordings in src/gate.ts or src/specs.ts, or any src/enrich*.ts, which decides what evidence goes into the state. If there is NO such edit, answer yes — regardless of anything else in the turn. If there IS such an edit, answer yes only when `command_results` show a calibration script being run after it.
