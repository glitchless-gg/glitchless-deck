#!/usr/bin/env node
// Stands in for ssh in the tests: skips ssh's options and the destination, then runs the command with
// sh in the folder that plays the Deck's home (FAKE_DECK_HOME). rsync's -e uses it the same way.

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const withValue = new Set(['-i', '-o', '-p', '-l', '-F', '-E', '-c', '-m', '-b', '-J', '-L', '-R', '-D', '-S', '-W', '-w', '-e', '-Q', '-I', '-O', '-B']);
let i = 0;
while (i < args.length && args[i].startsWith('-')) i += withValue.has(args[i]) ? 2 : 1;
i++; // user@address
const command = args.slice(i).join(' ');
if (process.env.FAKE_DECK_DOWN) {
  process.stderr.write('ssh: connect to host deck port 22: Connection refused\n');
  process.exit(255);
}
const home = process.env.FAKE_DECK_HOME;
const r = spawnSync('sh', ['-c', command], { cwd: home, env: { ...process.env, HOME: home }, stdio: 'inherit' });
process.exit(r.status ?? 1);
