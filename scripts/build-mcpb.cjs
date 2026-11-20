#!/usr/bin/env node
// Package the private stdio client from the locked checkout. The desktop needs
// only Node and the archive; no package installs occur when it launches.
const { build } = require('esbuild');
const { mkdtemp, rm, readFile, writeFile, copyFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

async function buildBundle(outputPath) {
    const { packExtension } = await import('@anthropic-ai/mcpb/cli');
    const pkg = require('../package.json');
    const template = await readFile(path.join(root, 'manifest.template.json'), 'utf8');
    const manifest = JSON.parse(template.replace('{{VERSION}}', pkg.version));
    const output = outputPath || path.join(root, manifest.name + '-' + manifest.version + '.mcpb');
    const stage = await mkdtemp(path.join(tmpdir(), 'jrc-extension-'));
    try {
        const result = await build({
            absWorkingDir: root, entryPoints: ['src/self-host/desktop-bridge.ts'],
            platform: 'node', target: 'node22', format: 'cjs', bundle: true,
            outfile: path.join(stage, manifest.server.entry_point), metafile: true,
            legalComments: 'eof',
        });
        const packageDirs = new Set();
        for (const name of Object.keys(result.metafile.inputs)) {
            const match = name.match(/^(.*(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+)\//);
            if (match) packageDirs.add(match[1]);
        }
        const notices = [];
        for (const dir of [...packageDirs].sort()) {
            const contents = await readdir(path.join(root, dir));
            for (const file of contents.filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name)).sort()) {
                notices.push(dir + '/' + file + '\n' + await readFile(path.join(root, dir, file), 'utf8'));
            }
        }
        await writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n'));
        await copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
        await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
        if (!await packExtension({ extensionPath: stage, outputPath: output, silent: true })) {
            throw new Error('MCPB validation or packaging failed.');
        }
        return output;
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

module.exports = { buildBundle };
if (require.main === module) {
    buildBundle().then(file => console.log('Built ' + file)).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
