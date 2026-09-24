require: checks.malformed_blocks.exit equals 0

In a fresh project with one spec file that does not parse, `orly judge` exits 2 and names the file, without a key and without a judge request.
