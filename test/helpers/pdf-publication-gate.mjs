// Test-only preload for the disposable PDF engine. Hold publication of its
// intermediate input, and signal when the next tool validates its output.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.JRC_TEST_PDF_QUEUE_DIR;
if (root && process.env.JRC_SELF_HOSTED === '1') {
  const insert = join(root, 'work', 'insert.pdf');
  const output = join(root, 'work', 'copy.pdf');
  const matches = (value, expected) => typeof value === 'string' && relative(value, expected) === '';
  const link = fs.link;
  fs.link = async (from, to) => {
    if (matches(to, insert)) {
      await fs.writeFile(join(root, 'publishing'), '');
      const deadline = Date.now() + 15000;
      while (!existsSync(join(root, 'release'))) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the PDF test to release publication');
        await delay(25);
      }
    }
    return link(from, to);
  };
  const lstat = fs.lstat;
  let observedCopy = false;
  fs.lstat = async (file, ...args) => {
    if (!observedCopy && matches(file, output)) {
      observedCopy = true;
      await fs.writeFile(join(root, 'copy-requested'), '');
    }
    return lstat(file, ...args);
  };
}
