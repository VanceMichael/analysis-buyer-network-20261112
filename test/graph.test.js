import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, resolveGraphConfig, connectedComponents } from '../src/graph.js';

let counter = 0;
function row(partial) {
  counter += 1;
  return {
    left: 'a', right: 'b', period: 1, amount: 10, relation: 'supply',
    id: `g${String(counter).padStart(4, '0')}`, ...partial,
  };
}

test('无向化：左右顺序不影响边身份，平行边按策略合并并保留全部记录 id', () => {
  const records = [
    row({ left: 'x', right: 'y', amount: 10, id: 'r1' }),
    row({ left: 'y', right: 'x', amount: 5, id: 'r2' }),
    row({ left: 'x', right: 'y', amount: 7, relation: 'cooperation', id: 'r3' }),
  ];
  const sum = buildGraph(records, { parallelPolicy: 'sum' });
  assert.equal(sum.edges.length, 1);
  assert.equal(sum.edges[0].weight, 22);
  assert.deepEqual(sum.edges[0].recordIds, ['r1', 'r2', 'r3']);
  assert.equal(sum.edges[0].parallelCount, 3);

  const max = buildGraph(records, { parallelPolicy: 'max' });
  assert.equal(max.edges[0].weight, 10);
  const mean = buildGraph(records, { parallelPolicy: 'mean' });
  assert.equal(mean.edges[0].weight, 22 / 3);
  const count = buildGraph(records, { parallelPolicy: 'count' });
  assert.equal(count.edges[0].weight, 3);
});

test('log1p 缩放规则作用于合并后的金额且写入配置', () => {
  const records = [
    row({ left: 'x', right: 'y', amount: 10, id: 'r1' }),
    row({ left: 'y', right: 'x', amount: 5, id: 'r2' }),
  ];
  const graph = buildGraph(records, { parallelPolicy: 'sum', scale: 'log1p' });
  assert.equal(graph.config.scale, 'log1p');
  assert.ok(Math.abs(graph.edges[0].weight - Math.log1p(15)) < 1e-12);
});

test('自环单列：默认不进入拓扑，度为零但节点保留；include 时计入强度', () => {
  const records = [
    row({ left: 's', right: 's', amount: 99, id: 'loop' }),
    row({ left: 's', right: 't', amount: 10, id: 'edge' }),
  ];
  const reportOnly = buildGraph(records, {});
  assert.equal(reportOnly.selfLoops.length, 1);
  assert.equal(reportOnly.selfLoops[0].recordId, 'loop');
  assert.equal(reportOnly.edges.length, 1);
  assert.equal(reportOnly.degrees[reportOnly.index.get('s')], 1);
  assert.equal(reportOnly.selfLoopsExcludedFromTopology, 1);

  const included = buildGraph(records, { selfLoops: 'include' });
  assert.equal(included.edges.length, 1);
  assert.ok(included.strengths[included.index.get('s')] >= 99);
});

test('时间窗口与关系类型过滤，窗口外记录不进图', () => {
  const records = [
    row({ period: 1, id: 'p1' }),
    row({ period: 2, id: 'p2' }),
    row({ period: 3, id: 'p3' }),
    row({ period: 2, relation: 'cooperation', id: 'c2' }),
  ];
  const windowed = buildGraph(records, { fromPeriod: 2, toPeriod: 3 });
  assert.equal(windowed.windowRecordCount, 3);
  const typed = buildGraph(records, { relations: ['cooperation'] });
  assert.equal(typed.windowRecordCount, 1);
  assert.equal(typed.edges[0].relations[0], 'cooperation');
});

test('节点 universe 中的孤立点保留为独立分量，不被并入连通部分', () => {
  const records = [row({ left: 'a', right: 'b', id: 'e1' })];
  const graph = buildGraph(records, { nodes: ['a', 'b', 'lonely'] });
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(graph.components.map(c => c.length).sort((x, y) => y - x), [2, 1]);
  const lonely = graph.index.get('lonely');
  assert.equal(graph.degrees[lonely], 0);
});

test('全孤立图：每个节点一个分量，边集合为空', () => {
  const graph = buildGraph([], { nodes: ['o1', 'o2', 'o3'] });
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.components.length, 3);
  assert.ok(graph.degrees.every(d => d === 0));
});

test('建图不修改原始记录对象', () => {
  const records = [row({ left: 'y', right: 'x', id: 'r1' }), row({ id: 'r2' })];
  const snapshot = JSON.stringify(records);
  buildGraph(records, {});
  assert.equal(JSON.stringify(records), snapshot);
});

test('非法配置被拒绝', () => {
  assert.throws(() => resolveGraphConfig({ fromPeriod: 3, toPeriod: 1 }), /窗口/);
  assert.throws(() => resolveGraphConfig({ parallelPolicy: 'bogus' }), /平行边/);
  assert.throws(() => resolveGraphConfig({ scale: 'sqrt' }), /缩放/);
  assert.throws(() => resolveGraphConfig({ selfLoops: 'drop' }), /selfLoops/);
});

test('connectedComponents 对断开图分别给出分量', () => {
  const records = [
    row({ left: 'a', right: 'b', id: '1' }),
    row({ left: 'c', right: 'd', id: '2' }),
    row({ left: 'd', right: 'e', id: '3' }),
  ];
  const graph = buildGraph(records, {});
  assert.deepEqual(graph.components.map(c => c.length).sort((x, y) => y - x), [3, 2]);
  assert.equal(connectedComponents(graph.nodes, graph.adjacency).length, 2);
});
