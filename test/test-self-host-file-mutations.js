import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalEngine } from '../dist/self-host/local-engine.js';
import { withFileMutation } from '../dist/utils/file-mutation.js';

test('concurrent edits and appends through aliases preserve changes and report conflicts', { timeout: 45000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jrc-file-mutations-')));
  const workspace = join(root, 'work');
  const file = join(workspace, 'original.txt');
  const alias = join(workspace, 'another name.txt');
  await mkdir(workspace);
  await writeFile(file, 'first: old\nsecond: old\n');
  await link(file, alias);

  const engine = new LocalEngine({ workspace, stateDir: join(root, 'state') });
  try {
    await engine.start();
    const results = await Promise.all([
      engine.call('edit_block', { file_path: file, old_string: 'first: old', new_string: 'first: new' }),
      engine.call('edit_block', { file_path: alias, old_string: 'second: old', new_string: 'second: new' }),
      engine.call('write_file', { path: alias, content: 'appended\n', mode: 'append' }),
    ]);
    for (const result of results) assert.equal(Boolean(result.isError), false, JSON.stringify(result));
    const expected = 'first: new\nsecond: new\nappended\n';
    assert.equal(await readFile(file, 'utf8'), expected);
    assert.equal(await readFile(alias, 'utf8'), expected);

    const competing = await Promise.all(['alpha', 'beta'].map(replacement =>
      engine.call('edit_block', { file_path: file, old_string: 'first: new', new_string: replacement })));
    const winners = competing.map((result, index) => result.isError ? null : ['alpha', 'beta'][index]).filter(Boolean);
    assert.equal(winners.length, 1, 'Only the edit whose original text still matches may report success');
    assert.equal(await readFile(alias, 'utf8'), winners[0] + '\nsecond: new\nappended\n');
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent edit_block range changes to one workbook both persist', { timeout: 45000 }, async () => {
  const { default: ExcelJS } = await import('exceljs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jrc-workbook-mutations-')));
  const workspace = join(root, 'work');
  const file = join(workspace, 'book.xlsx');
  const engine = new LocalEngine({ workspace, stateDir: join(root, 'state') });
  try {
    await mkdir(workspace);
    const initial = new ExcelJS.Workbook();
    initial.addWorksheet('Sheet1').addRow(['old A', 'old B']);
    await initial.xlsx.writeFile(file);
    await engine.start();

    // Warm the optional package with a read before submitting either edit.
    const deadline = Date.now() + 10000;
    while (true) {
      const read = await engine.call('read_file', { path: file });
      if (!read.isError) break;
      assert.match(JSON.stringify(read.content), /still loading/);
      assert.ok(Date.now() < deadline, 'spreadsheet support should finish loading');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const updated = ['A1', 'B1'];
    const edits = await Promise.all(updated.map(cell => engine.call('edit_block', {
      file_path: file, range: 'Sheet1!' + cell, content: [[cell]],
    })));
    for (const edit of edits) assert.equal(Boolean(edit.isError), false, JSON.stringify(edit));
    const saved = new ExcelJS.Workbook();
    await saved.xlsx.readFile(file);
    assert.deepEqual(updated.map(cell => saved.getWorksheet('Sheet1').getCell(cell).value), updated);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed file mutation releases its waiter and leaves other files independent', { timeout: 10000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jrc-mutation-queue-')));
  const firstPath = join(root, 'first.txt');
  const otherPath = join(root, 'other.txt');
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  try {
    await writeFile(firstPath, 'original');
    const first = withFileMutation([firstPath], async () => {
      started.resolve();
      await release.promise;
      throw new Error('fixture write failed');
    });
    const rejection = assert.rejects(first, /fixture write failed/);
    await started.promise;
    const next = withFileMutation([firstPath], () => writeFile(firstPath, 'next'));
    try {
      await withFileMutation([otherPath], () => writeFile(otherPath, 'independent'));
      assert.equal(await readFile(firstPath, 'utf8'), 'original');
    } finally {
      release.resolve();
      await Promise.all([rejection, next]);
    }
    assert.equal(await readFile(firstPath, 'utf8'), 'next');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
