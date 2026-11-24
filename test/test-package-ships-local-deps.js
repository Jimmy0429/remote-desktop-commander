/** Check that the packed npm distribution includes every file: runtime dependency. */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain } from './helpers/run-if-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Normalize paths declared in the npm manifest for comparison. */
const folder = (value) => path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '');
/** True when the listed folder is dir or one of its parents */
const covers = (listed, dir) => dir === listed || dir.startsWith(`${listed}/`);

async function runTests() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const local = Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('file:'))
    .map(([name, spec]) => ({ name, dir: folder(spec.slice('file:'.length)) }));
  const files = (pkg.files ?? []).map(folder);
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];

  const missing = [];
  for (const { name, dir } of local) {
    if (!files.some((listed) => covers(listed, dir))) missing.push(`npm: ${dir} is not in package.json "files"`);
    if (!bundled.includes(name)) missing.push(`npm: ${name} is not in bundleDependencies`);
  }

  assert.deepEqual(missing, [], `local dependencies the npm package leaves out:\n  ${missing.join('\n  ')}`);
  console.log(`✅ PASS  local dependencies ship in the npm package: ${local.map(({ name }) => name).join(', ') || 'none'}`);
}

runIfMain(import.meta.url, runTests);
