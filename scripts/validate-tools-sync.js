#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { NODE_TEST_CONTEXT, ...env } = process.env;
const result = spawnSync(process.execPath, [
  '--test',
  'test/test-self-host-catalog.js',
  'test/test-self-host-desktop-package.js',
], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
