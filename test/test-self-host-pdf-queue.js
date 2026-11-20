import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument } from 'pdf-lib';
import { LocalEngine } from '../dist/self-host/local-engine.js';
import { callToolOnceLoaded } from './helpers/heavy-packages.js';
import { withEnv } from './helpers/test-env.js';

async function makePages(file, pages) {
  const doc = await PDFDocument.create();
  for (let page = 0; page < pages; page++) doc.addPage();
  await fs.writeFile(file, await doc.save());
}

async function waitForMarker(file, call) {
  const stop = new AbortController();
  const marker = async () => {
    while (!existsSync(file)) await delay(25, undefined, { signal: stop.signal });
  };
  const deadline = delay(15000, undefined, { signal: stop.signal }).then(() => {
    throw new Error('PDF test fixture timed out waiting for its publication gate');
  });
  try {
    await Promise.race([marker(), deadline, call.then(result => assert.fail('Tool ended before its gate: ' + JSON.stringify(result.content)))]);
  } finally {
    stop.abort();
  }
}

test('a private PDF edit waits for a PDF still being published as an insert source', { timeout: 60000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'jrc-pdf-queue-')));
  const workspace = join(root, 'work');
  const engine = new LocalEngine({ workspace, stateDir: join(root, 'state') });
  const client = { callTool: ({ name, arguments: args }) => engine.call(name, args) };
  const original = join(workspace, 'original.pdf');
  const insert = join(workspace, 'insert.pdf');
  const base = join(workspace, 'base.pdf');
  const output = join(workspace, 'copy.pdf');
  const release = join(root, 'release');
  try {
    await fs.mkdir(workspace);
    await makePages(original, 2);
    await makePages(base, 3);
    const preload = new URL('./helpers/pdf-publication-gate.mjs', import.meta.url).href;
    await withEnv({
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
      JRC_TEST_PDF_QUEUE_DIR: root,
    }, () => engine.start());

    // Exercise both real MCP entry points. The preload holds only fs.link in
    // the agent child. Its remaining application resources belong to LocalEngine.
    const first = callToolOnceLoaded(client, { name: 'write_pdf', arguments: {
      path: original, content: [{ type: 'delete', pageIndexes: [1] }], outputPath: insert,
    }});
    await waitForMarker(join(root, 'publishing'), first);
    const next = callToolOnceLoaded(client, { name: 'edit_block', arguments: {
      file_path: base, range: 'pages', content: [{ type: 'insert', pageIndex: 0, sourcePdfPath: insert }],
      options: { outputPath: output },
    }});
    // Both requests have reached the filesystem before releasing the writer.
    await waitForMarker(join(root, 'copy-requested'), next);
    await Promise.race([next, delay(150)]);
    await fs.writeFile(release, '');
    for (const reply of await Promise.all([first, next])) assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    assert.equal((await PDFDocument.load(await fs.readFile(output))).getPageCount(), 4);
  } finally {
    await fs.writeFile(release, '');
    await engine.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
