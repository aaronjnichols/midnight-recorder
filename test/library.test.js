import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Library } from '../src/adapters/library.js';

test('import copies source, saves edits, and loads records after restart', async () => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(path.resolve('.local', 'library-'));
  const source = path.join(root, 'input.webm');
  await writeFile(source, 'original');
  const library = new Library(path.join(root, 'data'));
  const video = await library.import(source, { duration: 10, hasAudio: true, width: 640, height: 360 }, 'Demo');
  assert.notEqual(video.path, source);
  assert.equal(await readFile(video.path, 'utf8'), 'original');
  await library.update(video.id, { title: 'New title' });
  const reopened = new Library(path.join(root, 'data'));
  assert.equal((await reopened.get(video.id)).title, 'New title');
  assert.equal((await reopened.list('title')).length, 1);
  await reopened.remove(video.id);
  assert.equal((await reopened.list()).length, 0);
  assert.equal(await readFile(source, 'utf8'), 'original');
});
