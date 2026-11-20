import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { LocalEngine } from '../dist/self-host/local-engine.js';
import { writeNewFileAtomic } from '../dist/utils/atomic-write.js';
import { callToolOnceLoaded } from './helpers/heavy-packages.js';
import { answerText } from './helpers/mcp-client.js';

test('private PDF page operations publish a separate new file', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jrc-pdf-source-')));
  const workspace = join(root, 'workspace');
  const inputs = join(workspace, 'inputs');
  const engine = new LocalEngine({ workspace, stateDir: join(root, 'engine') });
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  const original = Buffer.from(await doc.save());
  const content = [{ type: 'delete', pageIndexes: [0] }];
  const client = { callTool: ({ name, arguments: args }) => engine.call(name, args) };
  const modify = (path, outputPath) => callToolOnceLoaded(client, {
    name: 'write_pdf', arguments: { path, outputPath, content },
  });
  try {
    await mkdir(inputs, { recursive: true });
    await engine.start();
    const source = join(inputs, 'source.pdf');
    const aliasDir = join(workspace, 'alias');
    const hardLink = join(workspace, 'hard-link.pdf');
    const existing = join(workspace, 'existing.pdf');
    await writeFile(source, original);
    await link(source, hardLink);
    await symlink(inputs, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(existing, 'preserve this destination');

    for (const [label, outputPath] of [
      ['original filename', source],
      ['directory alias to the source', join(aliasDir, 'source.pdf')],
      ['hard link to the source', hardLink],
      ['existing distinct destination', existing],
    ]) {
      await t.test('refuses the ' + label, async () => {
        const result = await modify(source, outputPath);
        assert.equal(result.isError, true, answerText(result));
        assert.match(answerText(result), /new outputPath|already exists/i);
        assert.deepEqual(await readFile(source), original);
        assert.equal(await readFile(existing, 'utf8'), 'preserve this destination');
      });
    }

    await t.test('concurrent modifications to one new output have exactly one winner', async () => {
      const fresh = join(workspace, 'result.pdf');
      const before = await readdir(workspace);
      const results = await Promise.all([modify(source, fresh), modify(source, fresh)]);
      assert.equal(results.filter(result => !result.isError).length, 1);
      assert.match(answerText(results.find(result => result.isError)), /already exists/i);
      assert.equal((await PDFDocument.load(await readFile(fresh))).getPageCount(), 1);
      assert.deepEqual(await readFile(source), original);
      assert.deepEqual((await readdir(workspace)).sort(), [...before, 'result.pdf'].sort());
    });

    await t.test('a failed page operation leaves the destination free for a corrected request', async () => {
      const before = await readdir(workspace);
      const outputPath = join(workspace, 'corrected.pdf');
      const invalid = await callToolOnceLoaded(client, {
        name: 'write_pdf', arguments: { path: source, outputPath, content: [{ type: 'delete', pageIndexes: [8] }] },
      });
      assert.equal(invalid.isError, true);
      assert.match(answerText(invalid), /Invalid page index/);
      assert.deepEqual((await readdir(workspace)).sort(), before.sort());
      assert.deepEqual(await readFile(source), original);
      const corrected = await modify(source, outputPath);
      assert.ok(!corrected.isError, answerText(corrected));
      assert.equal((await PDFDocument.load(await readFile(outputPath))).getPageCount(), 1);
    });

    await t.test('losing the publication race after staging leaves only the winning file', async () => {
      const before = await readdir(workspace);
      await assert.rejects(writeNewFileAtomic(existing, original), { code: 'EEXIST' });
      assert.equal(await readFile(existing, 'utf8'), 'preserve this destination');
      assert.deepEqual((await readdir(workspace)).sort(), before.sort());
    });

    const editPages = outputPath => callToolOnceLoaded(client, {
      name: 'edit_block',
      arguments: { file_path: source, range: 'p', content, options: { outputPath } },
    });
    for (const [label, outputPath] of [
      ['missing destination', undefined],
      ['source alias', join(aliasDir, 'source.pdf')],
      ['occupied destination', existing],
    ]) {
      await t.test('private edit_block refuses PDF page operations with ' + label, async () => {
        const result = await editPages(outputPath);
        assert.equal(result.isError, true, answerText(result));
        assert.match(answerText(result), /new outputPath|already exists/i);
        assert.deepEqual(await readFile(source), original);
        assert.equal(await readFile(existing, 'utf8'), 'preserve this destination');
      });
    }
    await t.test('private edit_block writes PDF pages to a fresh copy', async () => {
      const outputPath = join(workspace, 'edited-copy.pdf');
      const result = await editPages(outputPath);
      assert.ok(!result.isError, answerText(result));
      assert.ok(answerText(result).includes('edited-copy.pdf'), answerText(result));
      assert.equal((await PDFDocument.load(await readFile(outputPath))).getPageCount(), 1);
      assert.deepEqual(await readFile(source), original);
    });
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});
