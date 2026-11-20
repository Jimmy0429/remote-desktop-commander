import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { withEnv } from './helpers/test-env.js';

test('a private PDF edit waits for a PDF still being published as an insert source', {timeout: 30000}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'jrc-pdf-queue-')));
  const work = join(root, 'work');
  await fs.mkdir(work);
  try {
    await withEnv({ JRC_SELF_HOSTED:'1', JRC_CONFIG_DIR:join(root, 'state'), JRC_WORKSPACE:work, DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1' }, async () => {
      const { writePdf } = await import('../dist/tools/filesystem.js');
      const { handleEditBlock } = await import('../dist/tools/edit.js');
      const makePages = async (file, pages) => {
        const doc = await PDFDocument.create();
        for (let page = 0; page < pages; page++) doc.addPage();
        await fs.writeFile(file, await doc.save());
      };
      const original = join(work, 'original.pdf');
      const insert = join(work, 'insert.pdf');
      const base = join(work, 'base.pdf');
      const output = join(work, 'copy.pdf');
      await makePages(original, 2);
      await makePages(base, 3);

      // Hold the first tool immediately before its fresh output becomes visible.
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const link = fs.link;
      t.mock.method(fs, 'link', async (from, to) => {
        if (to === insert) { entered.resolve(); await release.promise; }
        return link(from, to);
      });
      const first = writePdf(original, [{type:'delete', pageIndexes:[1]}], insert);
      await Promise.race([entered.promise, first.then(() => assert.fail('publication gate was not reached'))]);
      const next = handleEditBlock({ file_path:base, range:'pages', content:[
        {type:'insert', pageIndex:0, sourcePdfPath:insert}
      ], options:{outputPath:output} });
      try {
        // Give an uncoordinated caller the chance to read the still-absent input.
        await Promise.race([next, new Promise(resolve => setTimeout(resolve, 150))]);
      } finally {
        release.resolve();
      }
      const [, answer] = await Promise.all([first, next]);
      assert.notEqual(answer.isError, true, JSON.stringify(answer.content));
      assert.equal((await PDFDocument.load(await fs.readFile(output))).getPageCount(), 4);
    });
  } finally {
    await fs.rm(root, {recursive:true,force:true});
  }
});
