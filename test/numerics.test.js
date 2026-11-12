import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('合作边两端合并为节点集合，自环不产生两个节点', () => {

  assert.equal(probe([{left: 'a', right: 'b'}, {left: 'b', right: 'c'}]).nodes, 3);
  assert.equal(probe([{left: 'a', right: 'a'}]).nodes, 1);
});
