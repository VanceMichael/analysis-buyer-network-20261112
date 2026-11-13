import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/graph.js';
import { detectCommunities } from '../src/community.js';
import { computeBridgeProfile, topologicalBridges, betweenness } from '../src/bridges.js';

let counter = 0;
function row(left, right, amount = 10, id) {
  counter += 1;
  return { left, right, amount, relation: 'supply', period: 1, id: id ?? `b${String(counter).padStart(4, '0')}` };
}

test('Tarjan 桥：两团之间的唯一连接被标记为拓扑割边，团内边不是', () => {
  const records = [];
  for (const [u, v] of [['a', 'b'], ['b', 'c'], ['c', 'a']]) records.push(row(u, v));
  for (const [u, v] of [['x', 'y'], ['y', 'z'], ['z', 'x']]) records.push(row(u, v));
  records.push(row('a', 'x'));
  const graph = buildGraph(records, {});
  const bridges = topologicalBridges(graph);
  assert.equal(bridges.size, 1);
  const bridgeKey = [...bridges][0];
  assert.ok(bridgeKey.includes('a') && bridgeKey.includes('x'));
});

test('纯环没有拓扑桥；断开图各分量分别计算', () => {
  const records = [row('a', 'b'), row('b', 'c'), row('c', 'd'), row('d', 'a')];
  const graph = buildGraph(records, {});
  assert.equal(topologicalBridges(graph).size, 0);

  const disconnected = buildGraph([row('a', 'b'), row('x', 'y')], {});
  assert.equal(topologicalBridges(disconnected).size, 2);
});

test('Brandes 介数：两团一桥的桥边介数等于两团节点数乘积', () => {
  const records = [];
  const A = ['a1', 'a2', 'a3'];
  const B = ['b1', 'b2', 'b3'];
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) records.push(row(A[i], A[j]));
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) records.push(row(B[i], B[j]));
  records.push(row('a1', 'b1'));
  const graph = buildGraph(records, {});
  const { edgeBc } = betweenness(graph);
  const bridge = graph.edges.find(e => e.endpoints.includes('a1') && e.endpoints.includes('b1'));
  assert.equal(edgeBc.get(bridge.key), 9); // 3 x 3 条跨团最短路径
});

test('跨社群边可追溯到具体原始记录 id，平行边保留全部 id', () => {
  const records = [];
  for (const [u, v] of [['a', 'b'], ['b', 'c'], ['c', 'a']]) records.push(row(u, v));
  for (const [u, v] of [['x', 'y'], ['y', 'z'], ['z', 'x']]) records.push(row(u, v));
  records.push(row('a', 'x', 10, 'bridge-1'));
  records.push(row('x', 'a', 7, 'bridge-2')); // 平行边，合并为同一条无向边
  const graph = buildGraph(records, { parallelPolicy: 'sum' });
  const detection = detectCommunities(graph, { resolution: 1, seeds: [11] });
  const profile = computeBridgeProfile(
    graph, detection.chosenAssignment, detection.chosenCommunities);
  assert.equal(profile.crossEdgeCount, 1);
  const cross = profile.crossEdges[0];
  assert.deepEqual(cross.recordIds.sort(), ['bridge-1', 'bridge-2']);
  assert.equal(cross.topologicalBridge, true);
  assert.equal(cross.parallelCount, 2);
});

test('参与系数：纯团内节点为 0，连接多个社群的节点大于 0', () => {
  const records = [];
  for (const [u, v] of [['a', 'b'], ['b', 'c'], ['c', 'a']]) records.push(row(u, v));
  for (const [u, v] of [['x', 'y'], ['y', 'z']]) records.push(row(u, v));
  records.push(row('c', 'x'));
  const graph = buildGraph(records, {});
  const detection = detectCommunities(graph, { resolution: 1, seeds: [11] });
  const profile = computeBridgeProfile(
    graph, detection.chosenAssignment, detection.chosenCommunities);
  const nodeC = profile.nodes.find(n => n.node === 'c');
  const nodeA = profile.nodes.find(n => n.node === 'a');
  assert.ok(nodeC.participation > 0);
  assert.equal(nodeA.participation, 0);
});

test('孤立点不产生介数或跨群贡献，且被显式标记', () => {
  const graph = buildGraph([row('a', 'b')], { nodes: ['a', 'b', 'iso'] });
  const detection = detectCommunities(graph, { resolution: 1, seeds: [11] });
  const profile = computeBridgeProfile(
    graph, detection.chosenAssignment, detection.chosenCommunities);
  const iso = profile.nodes.find(n => n.node === 'iso');
  assert.equal(iso.isIsolate, true);
  assert.equal(iso.nodeBetweenness, 0);
  assert.equal(iso.crossCommunityDegree, 0);
  assert.equal(iso.participation, 0);
});

test('度匹配对照：度相同的桥位与团内节点，介数差异显著而度数相同', () => {
  const records = [];
  for (const [u, v] of [['a1', 'a2'], ['a2', 'a3'], ['a3', 'a1'], ['a1', 'a4'], ['a2', 'a4'], ['a3', 'a4']]) {
    records.push(row(u, v));
  }
  for (const [u, v] of [['b1', 'b2'], ['b2', 'b3'], ['b3', 'b1'], ['b1', 'b4'], ['b2', 'b4'], ['b3', 'b4']]) {
    records.push(row(u, v));
  }
  records.push(row('bridge', 'a1'));
  records.push(row('bridge', 'a2'));
  records.push(row('bridge', 'b1'));
  records.push(row('inside', 'a1'));
  records.push(row('inside', 'a2'));
  records.push(row('inside', 'a3'));
  const graph = buildGraph(records, {});
  const detection = detectCommunities(graph, { resolution: 1, seeds: [11] });
  const profile = computeBridgeProfile(
    graph, detection.chosenAssignment, detection.chosenCommunities);
  const bridgeNode = profile.nodes.find(n => n.node === 'bridge');
  const insideNode = profile.nodes.find(n => n.node === 'inside');
  assert.equal(bridgeNode.degree, insideNode.degree);
  assert.ok(bridgeNode.nodeBetweenness > insideNode.nodeBetweenness);
  assert.ok(bridgeNode.crossCommunityDegree > insideNode.crossCommunityDegree);
});
