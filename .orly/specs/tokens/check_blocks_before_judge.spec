require: checks.check_first.exit equals 0

In a fresh project whose only spec is a `require` on a failing check, `orly judge` exits 2 and names the check, with no key set: the block costs no judge tokens.
