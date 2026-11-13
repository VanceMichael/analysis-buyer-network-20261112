import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/graph.js';
import {
  detectCommunities, adjustedRandIndex, stableNames,
} from '../src/community.js';

let counter = 0;
function row(left, right, amount = 10) {
  counter += 1;
  return { left, right, amount, relation: 'supply', period: 1, id: `c${String(counter).padStart(4, '0')}` };
}

function clique(nodes, records) {
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) records.push(row(nodes[i], nodes[j]));
}

test('两个稠密团加一条桥：Louvain 恢复两团，桥被识别为跨社群边', () => {
  const records = [];
  const A = ['a1', 'a2', 'a3', 'a4'];
  const B = ['b1', 'b2', 'b3', 'b4'];
  clique(A, records);
  clique(B, records);
  records.push(row('a4', 'b1', 5));
  const graph = buildGraph(records, {});
  const result = detectCommunities(graph, { resolution: 1, seeds: [11, 23, 37] });
  const groups = result.chosenCommunities.map(c => c.members).sort(g => g[0]);
  const setA = groups.find(g => g.includes('a1'));
  const setB = groups.find(g => g.includes('b1'));
  assert.deepEqual(setA.sort(), A);
  assert.deepEqual(setB.sort(), B);
  assert.equal(result.stability.pairwiseMin, 1);
});

test('星形图：单一社群，叶子不会被错误拆分，结果对种子稳定', () => {
  const records = [];
  for (const leaf of ['l1', 'l2', 'l3', 'l4', 'l5']) records.push(row('hub', leaf));
  const graph = buildGraph(records, {});
  const result = detectCommunities(graph, { resolution: 1, seeds: [11, 23, 37] });
  assert.equal(result.chosenCommunities.length, 1);
  assert.equal(result.chosenCommunities[0].size, 6);
  assert.equal(result.stability.pairwiseMean, 1);
});

test('全孤立点：每个孤立点单成社群，绝不被塞进大社群', () => {
  const graph = buildGraph([], { nodes: ['o1', 'o2', 'o3', 'o4'] });
  const result = detectCommunities(graph, { resolution: 1, seeds: [11] });
  assert.equal(result.chosenCommunities.length, 4);
  assert.ok(result.chosenCommunities.every(c => c.isIsolateCommunity && c.size === 1));
});

test('目标社群数只约束非孤立社群，孤立社群在合并与拆分中都豁免', () => {
  const records = [];
  clique(['a1', 'a2', 'a3', 'a4'], records);
  clique(['b1', 'b2', 'b3', 'b4'], records);
  // 一条弱连接把两团放进同一连通分量，target=1 的合并才在分量内合法；
  // 孤立点 lonely 始终独立于任何分量。
  records.push(row('a4', 'b1', 1));
  const graph = buildGraph(records, { nodes: ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'lonely'] });

  const one = detectCommunities(graph, { resolution: 1, targetCommunities: 1, seeds: [11] });
  const activeOne = one.chosenCommunities.filter(c => !c.isIsolateCommunity);
  const isolateOne = one.chosenCommunities.filter(c => c.isIsolateCommunity);
  assert.equal(activeOne.length, 1);
  assert.equal(isolateOne.length, 1);
  assert.deepEqual(isolateOne[0].members, ['lonely']);

  const three = detectCommunities(graph, { resolution: 1, targetCommunities: 3, seeds: [11, 23] });
  const activeThree = three.chosenCommunities.filter(c => !c.isIsolateCommunity);
  assert.equal(activeThree.length, 3);
  assert.ok(three.chosenCommunities.some(c => c.isIsolateCommunity && c.members[0] === 'lonely'));
});

test('目标社群数不跨连通分量合并：断开图的分量结构始终保持', () => {
  const records = [];
  clique(['a1', 'a2', 'a3'], records);
  clique(['b1', 'b2', 'b3'], records);
  const graph = buildGraph(records, {});
  const result = detectCommunities(graph, { resolution: 1, targetCommunities: 1, seeds: [11] });
  const active = result.chosenCommunities.filter(c => !c.isIsolateCommunity);
  assert.equal(active.length, 2, '两个断开分量不能被合并成一个社群');
});

test('社群名按成员集合稳定：相同分区在不同运行中得到相同名字', () => {
  const records = [];
  clique(['a', 'b', 'c'], records);
  clique(['x', 'y', 'z'], records);
  const graph = buildGraph(records, {});
  const r1 = detectCommunities(graph, { resolution: 1, seeds: [11] });
  const r2 = detectCommunities(graph, { resolution: 1, seeds: [99] });
  const sig1 = r1.chosenCommunities.map(c => c.members.join('|')).sort();
  const sig2 = r2.chosenCommunities.map(c => c.members.join('|')).sort();
  assert.deepEqual(sig1, sig2);
  assert.ok(r1.chosenCommunities.every(c => /^C\d{2}$/.test(c.community)));
});

test('调整兰德指数对相同分区为 1，退化情形不产出 NaN', () => {
  assert.equal(adjustedRandIndex([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  assert.equal(adjustedRandIndex([0], [0]), 1);
  const value = adjustedRandIndex([0, 0, 0, 0], [1, 1, 1, 1]);
  assert.ok(Number.isFinite(value));
  const singleton = adjustedRandIndex([0, 1, 2, 3], [0, 1, 2, 3]);
  assert.equal(singleton, 1);
});

test('分辨率越高倾向更多社群，分辨率参数被校验', () => {
  const records = [];
  clique(['a', 'b', 'c', 'd', 'e', 'f'], records);
  records.push(row('a', 'x'));
  records.push(row('x', 'y'));
  records.push(row('y', 'z'));
  const graph = buildGraph(records, {});
  const low = detectCommunities(graph, { resolution: 0.2, seeds: [11] });
  const high = detectCommunities(graph, { resolution: 3, seeds: [11] });
  assert.ok(high.chosenCommunities.length >= low.chosenCommunities.length);
  assert.throws(() => detectCommunities(graph, { resolution: 0, seeds: [11] }), /分辨率/);
  assert.throws(() => detectCommunities(graph, { resolution: 1, seeds: [] }), /种子/);
});

test('断开图按分量分别检测，跨分量节点不会被划入同一社群', () => {
  const records = [];
  clique(['a', 'b', 'c'], records);
  clique(['x', 'y', 'z'], records);
  const graph = buildGraph(records, {});
  assert.equal(graph.components.length, 2);
  const result = detectCommunities(graph, { resolution: 1, seeds: [11] });
  const membership = new Map(result.chosenCommunities.flatMap(c =>
    c.members.map(node => [node, c.community])));
  assert.notEqual(membership.get('a'), membership.get('x'));
});

test('stableNames 直接按成员集合签名排序命名', () => {
  const graph = buildGraph([row('a', 'b')], { nodes: ['a', 'b', 'iso'] });
  const names = stableNames(graph, [0, 0, 1]);
  assert.equal(names[0].community, 'C01');
  assert.deepEqual(names[0].members, ['a', 'b']);
  assert.equal(names[1].isIsolateCommunity, true);
});
