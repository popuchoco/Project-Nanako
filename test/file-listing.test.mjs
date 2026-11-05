import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortFiles } from '../public/file-listing.mjs';

const items = [
  { name: 'Zoo', isDirectory: true, size: null, modifiedAt: '2026-11-04T12:00:00.000Z' },
  { name: 'image10.png', isDirectory: false, size: 20, modifiedAt: '2026-11-03T12:00:00.000Z' },
  { name: 'video.mp4', isDirectory: false, size: 80, modifiedAt: '2026-11-05T12:00:00.000Z' },
  { name: 'note.TXT', isDirectory: false, size: 5, modifiedAt: '2026-11-02T12:00:00.000Z' },
  { name: 'image2.jpg', isDirectory: false, size: 40, modifiedAt: '2026-11-01T12:00:00.000Z' },
];

test('file classification and search stay within the supplied current-folder items', () => {
  assert.deepEqual(filterAndSortFiles(items, { category: 'image' }).map((item) => item.name), ['image2.jpg', 'image10.png']);
  assert.deepEqual(filterAndSortFiles(items, { category: 'document' }).map((item) => item.name), ['note.TXT']);
  assert.deepEqual(filterAndSortFiles(items, { search: 'IMAGE' }).map((item) => item.name), ['image2.jpg', 'image10.png']);
  assert.deepEqual(filterAndSortFiles(items, { category: 'video', search: 'missing' }), []);
});

test('file sorting keeps folders first and supports name, modified-time and size order', () => {
  assert.deepEqual(filterAndSortFiles(items).map((item) => item.name), ['Zoo', 'image2.jpg', 'image10.png', 'note.TXT', 'video.mp4']);
  assert.deepEqual(filterAndSortFiles(items, { sort: 'modified-asc' }).map((item) => item.name), ['Zoo', 'image2.jpg', 'note.TXT', 'image10.png', 'video.mp4']);
  assert.deepEqual(filterAndSortFiles(items, { sort: 'size-desc' }).map((item) => item.name), ['Zoo', 'video.mp4', 'image2.jpg', 'image10.png', 'note.TXT']);
});

