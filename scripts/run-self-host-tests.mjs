import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Expand files here because Windows' npm shell does not expand wildcard arguments.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(join(root, 'test')).filter(name => /^test-self-host-.*\.js$/.test(name)).sort();
if (!files.length) throw new Error('No self-host tests found.');
// Native Windows permission tests start inbox PowerShell processes. Bound their
// parallelism so CPU contention does not consume unrelated MCP startup deadlines.
const concurrency = process.platform === 'win32' ? ['--test-concurrency=2'] : [];
const result = spawnSync(process.execPath, ['--test', ...concurrency, ...files.map(name => join(root, 'test', name))], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
