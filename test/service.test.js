import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service, commands } from '../src/application/service.js';
import { Library } from '../src/adapters/library.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('record commands enforce state and keep a failed stop available for retry', async () => {
  let fail = true;
  const service = new Service({
    capture: {
      sources: async () => [{ id: 'screen:1', name: 'Screen 1' }],
      devices: async () => [],
      start: async () => ({}), pause: async () => ({}), resume: async () => ({}),
      stop: async () => { if (fail) throw new Error('Disk full'); return 'recording.webm'; },
      cancel: async () => ({})
    },
    media: { probe: async () => ({ duration: 10 }) },
    library: { import: async () => ({ id: 'saved' }) }
  });
  assert.equal((await service.execute('recording.start', { sourceId: 'screen:1' })).state, 'recording');
  await assert.rejects(() => service.execute('recording.start', { sourceId: 'screen:1' }), /active/);
  assert.equal((await service.execute('recording.pause')).state, 'paused');
  assert.equal((await service.execute('recording.resume')).state, 'recording');
  await assert.rejects(() => service.execute('recording.stop'), /Disk full/);
  assert.equal((await service.execute('app.status')).recording.state, 'recording');
  fail = false;
  assert.equal((await service.execute('recording.stop')).id, 'saved');
  assert.equal((await service.execute('app.status')).recording.state, 'idle');
  await assert.rejects(() => service.execute('recording.pause'), /No recording/);
  await assert.rejects(() => service.execute('recording.start', { unknown: true }), /Unknown/);
  assert.ok(commands.every(command => command.inputSchema.type === 'object'));
});

test('shared commands import, edit, undo, export, rename, and delete a video', async () => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(path.resolve('.local', 'service-'));
  const source = path.join(root, 'input.webm');
  await writeFile(source, 'video');
  const service = new Service({ library: new Library(path.join(root, 'data')), media: {
    probe: async () => ({ duration: 10 }),
    export: async (video, output) => ({ path: output, seconds: video.timeline.segments[0].end - video.timeline.segments[0].start })
  } });
  const video = await service.execute('library.import', { path: source, title: 'First' });
  await service.execute('edit.trim', { id: video.id, start: 2, end: 8 });
  assert.equal((await service.execute('library.get', { id: video.id })).timeline.segments[0].start, 2);
  await service.execute('edit.undo', { id: video.id });
  assert.equal((await service.execute('library.get', { id: video.id })).timeline.segments[0].start, 0);
  await service.execute('edit.redo', { id: video.id });
  const job = await service.execute('export.start', { id: video.id, path: path.join(root, 'out.mp4') });
  await new Promise(resolve => setImmediate(resolve));
  const done = await service.execute('export.status', { jobId: job.id });
  assert.equal(done.state, 'complete');
  assert.equal(done.result.seconds, 6);
  await service.execute('library.rename', { id: video.id, title: 'Renamed' });
  assert.equal((await service.execute('library.list', { query: 'named' })).length, 1);
  await service.execute('library.delete', { id: video.id });
  assert.deepEqual(await service.execute('library.list'), []);
});
