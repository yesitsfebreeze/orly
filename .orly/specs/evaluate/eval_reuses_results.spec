require: checks.eval_reuse.exit equals 0

Run twice on an unchanged project, the second `orly eval` reports every check result as reused and runs no check command.
