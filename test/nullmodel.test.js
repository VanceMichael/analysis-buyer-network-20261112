import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/graph.js';
import {
  generateNullEnsemble, graphFromRealization, benjaminiHochberg,
} from '../src/nullmodel.js';

let counter = 0;
function row(left, right, amount = 10) {
  counter += 1;
  return { left, right, amount, relation: 'supply', period: 1, id: `n${String(counter).padStart(4, '0')}` };
}

function denseRecords() {
  const records = [
    row('a', 'b', 100), row('a', 'c', 2), row('a', 'd', 3), row('b', 'c', 4), row('b', 'e', 50),
    row('c', 'd', 6), row('c', 'f', 7), row('d', 'e', 8), row('e', 'f', 9), row('a', 'f', 11),
    row('b', 'd', 12), row('c', 'e', 13), row('d', 'f', 14),
  ];
  return records;
}

test('reshuffle：度序列逐节点保持且边权多重集合不变，但权重-度耦合被打断', () => {
  const graph = buildGraph(denseRecords(), {});
  const ensemble = generateNullEnsemble(graph, {
    realizations: 40, swapMultiplier: 10, weightPolicy: 'reshuffle', seedBase: 42,
  });
  assert.equal(ensemble.allValid, true);
  const originalWeightMultiset = graph.edges.map(e => e.weight).sort((x, y) => x - y);
  let couplingBroken = 0;
  for (const realization of ensemble.validResults) {
    const nullGraph = graphFromRealization(graph, realization);
    // 度序列逐节点保持
    assert.ok(nullGraph.degrees.every((d, i) => d === graph.degrees[i]));
    // 边权多重集合保持
    const multiset = nullGraph.edges.map(e => e.weight).sort((x, y) => x - y);
    assert.deepEqual(multiset, originalWeightMultiset);
    if (!nullGraph.strengths.every((s, i) => Math.abs(s - graph.strengths[i]) < 1e-9)) {
      couplingBroken += 1;
    }
  }
  assert.ok(couplingBroken > 0, '重洗应至少在部分实现中改变节点强度');
});

test('attached：逐节点加权强度严格保持，且度序列保持', () => {
  const graph = buildGraph(denseRecords(), {});
  const ensemble = generateNullEnsemble(graph, {
    realizations: 40, swapMultiplier: 10, weightPolicy: 'attached', seedBase: 42,
  });
  assert.equal(ensemble.allValid, true);
  for (const realization of ensemble.validResults) {
    assert.equal(realization.strengthPreserved, true);
    const nullGraph = graphFromRealization(graph, realization);
    assert.ok(nullGraph.degrees.every((d, i) => d === graph.degrees[i]));
    assert.ok(nullGraph.strengths.every((s, i) => Math.abs(s - graph.strengths[i]) < 1e-9));
  }
});

test('零模型始终是简单图：无自环、无重复边', () => {
  const graph = buildGraph(denseRecords(), {});
  const ensemble = generateNullEnsemble(graph, { realizations: 20, weightPolicy: 'reshuffle' });
  for (const realization of ensemble.validResults) {
    const keys = new Set();
    for (const { u, v } of realization.edges) {
      assert.notEqual(u, v);
      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      assert.equal(keys.has(key), false);
      keys.add(key);
    }
    assert.equal(keys.size, graph.edges.length);
  }
});

test('星形图交换空间为空：所有实现判无效并给出明确诊断，不得充当有效零模型', () => {
  const records = [];
  for (const leaf of ['l1', 'l2', 'l3', 'l4', 'l5']) records.push(row('hub', leaf));
  const graph = buildGraph(records, {});
  const ensemble = generateNullEnsemble(graph, { realizations: 20, swapMultiplier: 5 });
  assert.equal(ensemble.validCount, 0);
  assert.equal(ensemble.invalidCount, 20);
  assert.ok(ensemble.invalidReasons['max-attempts-without-feasible-swap'] === 20);
});

test('全孤立与单边图：诊断为 edges-below-two，零模型判无效', () => {
  const isolates = buildGraph([], { nodes: ['o1', 'o2', 'o3'] });
  const e1 = generateNullEnsemble(isolates, { realizations: 5 });
  assert.equal(e1.validCount, 0);
  assert.equal(e1.invalidReasons['edges-below-two'], 5);

  const single = buildGraph([row('a', 'b')], {});
  const e2 = generateNullEnsemble(single, { realizations: 5 });
  assert.equal(e2.validCount, 0);
  assert.equal(e2.invalidReasons['edges-below-two'], 5);
});

test('高度重复边合并成三角形等小图：交换受限时如实报告无效而非伪造', () => {
  // 三个节点的完全图只有 3 条边，任意双边交换都会产生自环，无可行交换。
  const graph = buildGraph([row('x', 'y'), row('y', 'z'), row('x', 'z')], {});
  const ensemble = generateNullEnsemble(graph, { realizations: 10, swapMultiplier: 5 });
  assert.equal(ensemble.validCount, 0);
  assert.ok(ensemble.invalidCount === 10);
});

test('诊断记录尝试与成功交换次数；成功交换不足阈值时判无效', () => {
  const graph = buildGraph(denseRecords(), {});
  // 极小尝试预算使部分实现无法在预算内完成 minSwaps。
  const ensemble = generateNullEnsemble(graph, {
    realizations: 15, minSwaps: 1000, maxAttemptsPerSwap: 3, weightPolicy: 'reshuffle',
  });
  assert.equal(ensemble.validCount, 0);
  assert.ok(ensemble.invalidReasons['max-attempts-without-feasible-swap'] >= 1);
});

test('同种子逐位复现：两次生成的边集合完全相同', () => {
  const graph = buildGraph(denseRecords(), {});
  const opts = { realizations: 10, swapMultiplier: 10, seedBase: 7919, weightPolicy: 'reshuffle' };
  const run1 = generateNullEnsemble(graph, opts);
  const run2 = generateNullEnsemble(graph, { ...opts });
  assert.deepEqual(
    run1.validResults.map(r => r.edges),
    run2.validResults.map(r => r.edges),
  );
});

test('默认禁止跨分量交换：分量大小序列保持', () => {
  const records = [
    row('a', 'b'), row('b', 'c'), row('c', 'a'),
    row('x', 'y'), row('y', 'z'), row('z', 'x'),
    row('a', 'c'),
  ];
  const graph = buildGraph(records, {});
  const before = graph.components.map(c => c.length).sort((x, y) => y - x);
  const ensemble = generateNullEnsemble(graph, { realizations: 15, allowCrossComponent: false });
  for (const realization of ensemble.validResults) {
    const nullGraph = graphFromRealization(graph, realization);
    const after = nullGraph.components.map(c => c.length).sort((x, y) => y - x);
    assert.deepEqual(after, before);
  }
});

test('Benjamini-Hochberg：全显著输入保持有序调整，输出长度与输入一致', () => {
  const adjusted = benjaminiHochberg([0.01, 0.02, 0.03, 0.9]);
  assert.equal(adjusted.length, 4);
  assert.ok(adjusted.every(Number.isFinite));
  assert.ok(adjusted[0] <= adjusted[1]);
  const trivial = benjaminiHochberg([0.5]);
  assert.equal(trivial[0], 0.5);
});

test('边权处置策略参数被校验', () => {
  const graph = buildGraph(denseRecords(), {});
  assert.throws(
    () => generateNullEnsemble(graph, { weightPolicy: 'random' }),
    /边权处置/,
  );
  assert.throws(
    () => generateNullEnsemble(graph, { realizations: 0 }),
    /realizations/,
  );
});
