import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPool,
  folderCounts,
  hasProperty,
  hasTag,
  inFolder,
  parseList,
  pickRandom,
  propertyPairs,
  pushRecent,
  tagCounts,
} from '../src/logic.ts';
import type { Candidate } from '../src/logic.ts';

const note = (path: string, extra: Partial<Candidate> = {}): Candidate => ({ path, tags: [], backlinks: 1, props: {}, ...extra });
const none = { folders: [], tags: [] };

test('parseList splits commas and lines and trims', () => {
  assert.deepEqual(parseList(' a, b\n\nc ,'), ['a', 'b', 'c']);
  assert.deepEqual(parseList(''), []);
});

test('inFolder respects the folder boundary', () => {
  assert.equal(inFolder('Projects/a.md', 'Projects'), true);
  assert.equal(inFolder('Projects/x/a.md', '/Projects/'), true);
  assert.equal(inFolder('Projects2/a.md', 'Projects'), false);
  assert.equal(inFolder('a.md', ''), true);
});

test('hasTag matches nested tags and ignores case and the hash', () => {
  assert.equal(hasTag(['#Project/x'], 'project'), true);
  assert.equal(hasTag(['#project'], '#PROJECT'), true);
  assert.equal(hasTag(['#projects'], 'project'), false);
  assert.equal(hasTag([], 'project'), false);
  assert.equal(hasTag(['#a'], ''), false);
});

test('hasProperty handles scalars, lists, case and missing keys', () => {
  assert.equal(hasProperty({ Status: 'Draft' }, 'status', 'draft'), true);
  assert.equal(hasProperty({ tags: ['a', 'b'] }, 'tags', 'b'), true);
  assert.equal(hasProperty({ n: 3 }, 'n', '3'), true);
  assert.equal(hasProperty({ done: false }, 'done', 'false'), true);
  assert.equal(hasProperty({}, 'status', 'draft'), false);
  assert.equal(hasProperty({ status: 'done' }, 'status', 'draft'), false);
});

test('buildPool applies filter, exclusions and leaves the current note out', () => {
  const all = [
    note('A/one.md', { tags: ['#x'] }),
    note('A/two.md'),
    note('B/three.md', { tags: ['#x', '#private'] }),
    note('B/four.md', { backlinks: 0 }),
  ];
  assert.deepEqual(buildPool(all, { folder: 'A' }, none).map((c) => c.path), ['A/one.md', 'A/two.md']);
  assert.deepEqual(buildPool(all, { tag: 'x' }, { folders: [], tags: ['private'] }).map((c) => c.path), ['A/one.md']);
  assert.deepEqual(buildPool(all, {}, { folders: ['B'], tags: [] }, 'A/one.md').map((c) => c.path), ['A/two.md']);
  assert.deepEqual(buildPool(all, { orphansOnly: true }, none).map((c) => c.path), ['B/four.md']);
  assert.deepEqual(buildPool(all, { paths: new Set(['B/three.md']) }, none).map((c) => c.path), ['B/three.md']);
});

test('pickRandom avoids recent notes while others remain', () => {
  const pool = ['a', 'b', 'c'];
  assert.equal(pickRandom([], [], () => 0), undefined);
  for (const r of [0, 0.4, 0.99]) assert.equal(pickRandom(pool, ['a', 'b'], () => r), 'c');
  assert.equal(pickRandom(pool, [], () => 0), 'a');
  assert.equal(pickRandom(pool, [], () => 0.99), 'c');
});

test('pickRandom cycles a small pool, oldest seen first', () => {
  assert.equal(pickRandom(['a', 'b'], ['b', 'a'], () => 0.5), 'b');
  assert.equal(pickRandom(['a', 'b'], ['a', 'b'], () => 0.5), 'a');
  // A note not in the recent list always beats listed ones, even when it is the only one.
  assert.equal(pickRandom(['a', 'z'], ['a'], () => 0), 'z');
});

test('every note comes up before any repeats', () => {
  const pool = ['a', 'b', 'c', 'd'];
  let recent: string[] = [];
  const got: string[] = [];
  let seed = 7;
  const rng = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 4; i++) {
    const p = pickRandom(pool, recent, rng)!;
    got.push(p);
    recent = pushRecent(recent, p, 10);
  }
  assert.deepEqual([...got].sort(), pool);
});

test('pushRecent keeps the last N without duplicates and 0 turns it off', () => {
  assert.deepEqual(pushRecent(['a', 'b'], 'a', 5), ['b', 'a']);
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
  assert.deepEqual(pushRecent(['a'], 'b', 0), []);
});

test('the pickers list tags, folders and properties with counts', () => {
  const all = [
    note('A/x/1.md', { tags: ['#p/q', '#p'], props: { status: 'draft', tags: ['p'] } }),
    note('A/2.md', { tags: ['#p'], props: { status: 'Draft' } }),
    note('3.md'),
  ];
  assert.deepEqual(tagCounts(all), [{ tag: 'p', count: 2 }, { tag: 'p/q', count: 1 }]);
  assert.deepEqual(folderCounts(all), [{ folder: 'A', count: 2 }, { folder: 'A/x', count: 1 }]);
  assert.deepEqual(propertyPairs(all)[0], { key: 'status', value: 'draft', count: 2 });
});
