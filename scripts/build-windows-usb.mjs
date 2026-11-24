#!/usr/bin/env node
// Build the offline, file-only Windows pilot. No host-installed Node modules are
// used when it runs from the USB drive. Build dependencies come from npm ci.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import PizZip from 'pizzip';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = 'src/self-host/usb-api.ts';
const distribution = 'deploy/windows-usb';
const folder = 'JimmyRemoteCommander-USB';
const nodeVersion = '22.23.5';
// SHA-256 of each complete official archive, from the release's SHASUMS256.txt.
const nodeArchives = {
  x64: '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3',
  arm64: 'c1856817f611738c77534efbff8a5a17990593eab24046bc8d2c23a77a160d13',
};
const shippedFiles = ['CHECK-USB.cmd', 'START-PILOT.cmd', 'portable-launcher.mjs', 'README.txt'];
// The check includes a loopback relay, but its USB device must contain only
// the designated-file engine. A newly reachable product module needs review.
const portableSources = new Set([
  'src/version.ts', 'src/tools/schemas.ts', entry,
  ...['agent-connection', 'catalog', 'dashboard', 'device-engine', 'enrollment', 'mcp',
    'portable-agent', 'portable-file', 'private-storage', 'protocol', 'registry', 'relay',
    'server', 'server-lock'].map(name => 'src/self-host/' + name + '.ts'),
]);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const committed = (revision, name) => git('show', revision + ':' + name);
const slash = name => name.split(path.sep).join('/');

async function nodeRuntime(arch) {
  const base = 'node-v' + nodeVersion + '-win-' + arch;
  const url = 'https://nodejs.org/dist/v' + nodeVersion + '/' + base + '.zip';
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Node runtime download failed (HTTP ' + response.status + ').');
  const archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== nodeArchives[arch]) throw new Error('Node runtime archive checksum mismatch.');
  const zip = new PizZip(archive);
  const exe = zip.file(base + '/node.exe')?.asNodeBuffer();
  const license = zip.file(base + '/LICENSE')?.asNodeBuffer();
  if (!exe || !license) throw new Error('Verified runtime archive is missing node.exe or its license.');
  const pe = exe.readUInt32LE(0x3c);
  const machine = arch === 'x64' ? 0x8664 : 0xaa64;
  if (exe.readUInt16LE(0) !== 0x5a4d || exe.readUInt32LE(pe) !== 0x4550 || exe.readUInt16LE(pe + 4) !== machine) {
    throw new Error('Unexpected Windows executable architecture.');
  }
  return { url, exe, license };
}

async function bundleAgent(revision) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], outfile: 'portable.cjs',
    platform: 'node', target: 'node22.13', format: 'cjs',
    bundle: true, write: false, metafile: true, legalComments: 'eof', preserveSymlinks: true,
    // server-lock uses createRequire(import.meta.url) to load Node's own
    // SQLite module. Its CJS equivalent must resolve to the shipped bundle.
    banner: { js: 'const jrcUsbModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    define: {
      'import.meta.url': 'jrcUsbModuleUrl',
      'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
    tsconfigRaw: { compilerOptions: { target: 'es2020' } },
    plugins: [{
      name: 'committed-project-source',
      setup(builder) {
        builder.onLoad({ filter: /\.(?:ts|js|json)$/ }, ({ path: file }) => {
          const name = slash(path.relative(root, file));
          if (!name.startsWith('src/')) return;
          // Read Git's canonical bytes on both Windows (autocrlf) and macOS.
          return { contents: committed(revision, name), loader: path.extname(name).slice(1), resolveDir: path.dirname(file) };
        });
      },
    }],
  });
  const output = result.metafile.outputs['portable.cjs'];
  if (!output || result.outputFiles.length !== 1) throw new Error('USB agent must bundle to a single CJS file.');
  for (const dependency of output.imports) {
    if (!isBuiltin(dependency.path)) throw new Error('USB app needs a non-bundled module: ' + dependency.path);
  }
  const packages = new Set();
  for (const [name, info] of Object.entries(output.inputs)) {
    if (!info.bytesInOutput) continue;
    if (name.startsWith('src/') && !portableSources.has(name)) throw new Error('Unexpected module in the file-only USB build: ' + name);
    const match = name.match(/^(.*(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
  const notices = [];
  const lock = JSON.parse(committed(revision, 'package-lock.json'));
  for (const directory of [...packages].sort()) {
    const installed = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    if (lock.packages[directory]?.version !== installed.version) throw new Error('Run npm ci; lock mismatch in ' + directory);
    const names = (await readdir(path.join(root, directory))).filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name));
    notices.push(installed.name + ' ' + installed.version + ' (' + (installed.license || 'see package notices') + ')');
    for (const name of names.sort()) {
      const license = await readFile(path.join(root, directory, name), 'utf8');
      notices.push(directory + '/' + name + '\n' + license.replace(/\r\n/g, '\n'));
    }
  }
  return { code: Buffer.from(result.outputFiles[0].contents), notices: notices.join('\n\n') + '\n' };
}

async function main() {
  const { values } = parseArgs({ options: { arch: { type: 'string' }, output: { type: 'string' } } });
  if (!Object.hasOwn(nodeArchives, values.arch) || !values.output || !values.output.toLowerCase().endsWith('.zip')) {
    throw new Error('Usage: node scripts/build-windows-usb.mjs --arch x64|arm64 --output PATH.zip');
  }
  const arch = values.arch;
  const revision = git('rev-parse', '--verify', 'HEAD').toString().trim();
  git('diff', '--quiet', revision, '--', 'scripts/build-windows-usb.mjs', 'package-lock.json');
  const pkg = JSON.parse(committed(revision, 'package.json'));
  const files = new Map();
  for (const name of shippedFiles) {
    let contents = committed(revision, distribution + '/' + name).toString('utf8').replace(/\r\n/g, '\n');
    if (name.endsWith('.cmd') || name.endsWith('.txt')) contents = contents.replace(/\n/g, '\r\n');
    files.set(name, Buffer.from(contents));
  }
  files.set('LICENSE', committed(revision, 'LICENSE'));
  const [agent, node] = await Promise.all([bundleAgent(revision), nodeRuntime(arch)]);
  files.set('app/portable.cjs', agent.code);
  files.set('runtime/node.exe', node.exe);
  files.set('runtime/LICENSE', node.license);
  files.set('THIRD-PARTY-NOTICES.txt', Buffer.from(agent.notices));
  const manifest = {
    name: 'Jimmy Remote Commander USB pilot', version: pkg.version, architecture: arch,
    sourceCommit: revision, lockfileSha256: sha256(committed(revision, 'package-lock.json')),
    node: { version: nodeVersion, url: node.url, archiveSha256: nodeArchives[arch] },
    files: Object.fromEntries([...files.keys()].sort().map(name => [name, sha256(files.get(name))])),
  };
  files.set('BUILD.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  // PizZip encodes local calendar fields in DOS time. Fixed local fields,
  // stable entry order and its pinned JS compressor give identical archives.
  const zip = new PizZip();
  for (const name of [...files.keys()].sort()) {
    zip.file(folder + '/' + name, files.get(name), { date: new Date(2000, 0, 1), createFolders: false });
  }
  const bytes = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(output), '.jrc-usb-'));
  try {
    const digest = sha256(bytes);
    const checksum = digest + '  ' + path.basename(output) + '\n';
    await writeFile(path.join(stage, 'archive.zip'), bytes);
    await writeFile(path.join(stage, 'archive.sha256'), checksum);
    await rename(path.join(stage, 'archive.zip'), output);
    await rename(path.join(stage, 'archive.sha256'), output + '.sha256');
    console.log('Built ' + output + '\nBytes ' + bytes.length + '\nSHA-256 ' + digest);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
