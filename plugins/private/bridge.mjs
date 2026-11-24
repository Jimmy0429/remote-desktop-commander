import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Plugins may run from a client-managed cache, with no dependencies and a
// working directory belonging to a different project. Use the operator's build.
const { JRC_CLIENT_ROOT: root, JRC_SERVER_URL: server, JRC_TOKEN_FILE: tokenFile } = process.env;
async function launch() {
  if (!root || !isAbsolute(root) || !tokenFile || !isAbsolute(tokenFile) || !server) {
    throw new Error('Configure JRC_CLIENT_ROOT and JRC_TOKEN_FILE as absolute paths and JRC_SERVER_URL as the private server origin.');
  }
  let checkout;
  let plugin;
  // All client packages ship this manifest alongside the launcher.
  try {
    plugin = JSON.parse(await readFile(new URL('./.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    if (!plugin.version || typeof plugin.version !== 'string') throw new Error();
  } catch {
    throw new Error('The installed private plugin is missing its version metadata. Refresh the plugin from your verified checkout.');
  }
  try {
    checkout = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (checkout.name !== '@jimmy0429/remote-desktop-commander') throw new Error();
  } catch {
    throw new Error('The configured checkout must contain a built Jimmy Remote Commander with its locked dependencies. Check JRC_CLIENT_ROOT.');
  }
  if (checkout.version !== plugin.version) {
    throw new Error(`Checkout version ${checkout.version} differs from installed plugin version ${plugin.version}. Refresh the plugin from the verified checkout and rebuild it.`);
  }
  let compiledVersion;
  try {
    ({ VERSION: compiledVersion } = await import(pathToFileURL(join(root, 'dist', 'version.js')).href));
  } catch {
    throw new Error('The configured checkout has no readable compiled version. Rebuild it with npm run build.');
  }
  if (compiledVersion !== plugin.version) {
    throw new Error(`Compiled version ${compiledVersion} differs from plugin version ${plugin.version}. Rebuild the verified checkout with npm run build.`);
  }
  let main;
  try {
    ({ main } = await import(pathToFileURL(join(root, 'dist', 'self-host', 'cli.js')).href));
    if (typeof main !== 'function') throw new Error();
  } catch {
    throw new Error('The configured checkout must contain a built Jimmy Remote Commander with its locked dependencies. Check JRC_CLIENT_ROOT.');
  }
  await main(['bridge', '--server', server, '--token-file', tokenFile]);
}

launch().catch(error => {
  console.error(error instanceof Error ? error.message : 'Private bridge startup failed.');
  process.exitCode = 1;
});
