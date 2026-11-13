// 保度零模型：配置模型（configuration model）思路的双边交换（double-edge swap）实现。
//
// 严格约束（每张实现都显式校验，不满足即判无效，绝不计入零分布）：
//   1. 度序列逐节点保持不变：交换两条独立边的配对，四个端点度都不变；
//   2. 保持简单图：禁止产生自环、禁止产生重复边；
//   3. 默认仅在同一连通分量内交换，分量结构（分量大小序列）一并保持；
//   4. 每次交换的尝试次数与成功次数都记录；成功交换不足 minSwaps 的实现判无效。
//
// 边权处置（写入图配置/档案，结论可复查）：
//   - reshuffle（默认）：拓扑随机化后，把原图边权多重集合用同种子随机重洗再整体挂载，
//     边权分布（多重集合）不变，但权重与度的耦合被打断，用于检验“桥地位是否仅由拓扑造成”；
//   - attached：在桩（stub）层面交换。每个节点持有与度等长、带权的桩；交换只改桩之间的
//     配对、不动桩上的权重，因此逐节点加权强度严格保持，用于检验“加权强度也锁定时拓扑的贡献”。

import { mulberry32, mixSeed, shuffled, intBelow } from './rng.js';
import { connectedComponents } from './graph.js';

function edgeSetKey(u, v) {
  return u < v ? `${u}\u0001${v}` : `${v}\u0001${u}`;
}

// 一次完整的零模型实现。返回有效性与诊断，调用方负责只收集 valid 实现。
function oneRealization(graph, seed, options) {
  const {
    minSwaps,
    maxAttemptsPerSwap,
    allowCrossComponent,
    weightPolicy,
  } = options;
  const rng = mulberry32(seed);
  const n = graph.nodes.length;
  const edgeCount = graph.edges.length;

  const componentOf = new Array(n).fill(-1);
  graph.components.forEach((members, componentId) => {
    for (const node of members) componentOf[node] = componentId;
  });

  // 当前边：每条边记录两个端点（节点下标）。attached 模式额外维护每节点的带权桩，
  // 边权重等于其两端桩权重（交换中桩不动，两端桩始终同源同值）。
  let currentEdges = graph.edges.map(edge => [
    graph.index.get(edge.endpoints[0]),
    graph.index.get(edge.endpoints[1]),
  ]);
  const present = new Set(currentEdges.map(([u, v]) => edgeSetKey(u, v)));

  // 带权桩：stubWeight[node] 是该节点各桩上的固定权重，交换中永不改变。
  // edgeSlots 记录每条当前边两端占用的节点槽位；槽位在 push 当刻捕获，
  // 不能用事后的 length-1 推断（同一节点的边与其他节点交错出现）。
  const stubWeight = graph.nodes.map(() => []);
  const edgeSlots = graph.edges.map((edge) => {
    const u = graph.index.get(edge.endpoints[0]);
    const v = graph.index.get(edge.endpoints[1]);
    const slotU = stubWeight[u].length;
    stubWeight[u].push(edge.weight);
    const slotV = stubWeight[v].length;
    stubWeight[v].push(edge.weight);
    return { u, slotU, v, slotV };
  });

  let successfulSwaps = 0;
  let attempts = 0;
  let stopReason = edgeCount < 2 ? 'edges-below-two' : null;

  while (successfulSwaps < minSwaps && stopReason === null) {
    let found = false;
    for (let attempt = 0; attempt < maxAttemptsPerSwap; attempt += 1) {
      attempts += 1;
      const i = intBelow(rng, edgeCount);
      let j = intBelow(rng, edgeCount);
      if (j === i) j = (j + 1) % edgeCount;
      const ei = edgeSlots[i];
      const ej = edgeSlots[j];
      const [a, b] = currentEdges[i];
      const [c, d] = currentEdges[j];
      if (new Set([a, b, c, d]).size !== 4) continue; // 四端必须独立
      if (!allowCrossComponent
          && new Set([componentOf[a], componentOf[b], componentOf[c], componentOf[d]]).size !== 1) {
        continue;
      }
      const flip = rng() < 0.5;
      // 边 j：c 占槽 ej.slotU，d 占槽 ej.slotV。a 配其中一端、b 配另一端。
      const x = flip ? c : d;
      const y = flip ? d : c;
      const slotX = flip ? ej.slotU : ej.slotV;
      const slotY = flip ? ej.slotV : ej.slotU;
      if (a === x || b === y) continue;
      const key1 = edgeSetKey(a, x);
      const key2 = edgeSetKey(b, y);
      if (present.has(key1) || present.has(key2)) continue;

      // 执行拓扑交换：(a,b)+(c,d) -> (a,x)+(b,y)。
      present.delete(edgeSetKey(a, b));
      present.delete(edgeSetKey(c, d));
      currentEdges[i] = [a, x];
      currentEdges[j] = [b, y];
      // a 仍用自己原来的槽 ei.slotU，b 仍用 ei.slotV；x、y 带回各自在边 j 上的槽。
      // 桩权重完全不动，只是换了配对，因此逐节点加权强度严格守恒。
      edgeSlots[i] = { u: a, slotU: ei.slotU, v: x, slotV: slotX };
      edgeSlots[j] = { u: b, slotU: ei.slotV, v: y, slotV: slotY };
      present.add(key1);
      present.add(key2);
      successfulSwaps += 1;
      found = true;
      break;
    }
    if (!found) stopReason = 'max-attempts-without-feasible-swap';
  }

  // 权重挂载。
  // attached：边两端各保留自己桩上的权重（交换中桩不动），节点强度按端权重严格守恒；
  // reshuffle：把原图边权多重集合整体随机重洗，两端挂同一标量，边权分布不变但与度解耦。
  const rebuilt = currentEdges.map(([u, v]) => ({ u, v, weightU: 0, weightV: 0 }));
  if (weightPolicy === 'attached') {
    rebuilt.forEach((edge, index) => {
      const slot = edgeSlots[index];
      edge.weightU = stubWeight[slot.u][slot.slotU];
      edge.weightV = stubWeight[slot.v][slot.slotV];
    });
  } else {
    const shuffledWeights = shuffled(rng, graph.edges.map(edge => edge.weight));
    rebuilt.forEach((edge, index) => {
      edge.weightU = shuffledWeights[index];
      edge.weightV = shuffledWeights[index];
    });
  }

  // 显式度序列校验。
  const nullDegree = new Array(n).fill(0);
  for (const { u, v } of rebuilt) {
    nullDegree[u] += 1;
    nullDegree[v] += 1;
  }
  const degreePreserved = nullDegree.every((degree, node) => degree === graph.degrees[node]);
  const swapTargetMet = successfulSwaps >= minSwaps;
  const simpleGraph = rebuilt.length === present.size
    && rebuilt.every(({ u, v }) => u !== v)
    && new Set(rebuilt.map(({ u, v }) => edgeSetKey(u, v))).size === rebuilt.length;
  const valid = degreePreserved && swapTargetMet && stopReason !== 'edges-below-two' && simpleGraph;

  // attached 模式额外自证：逐节点加权强度必须与原图完全一致，否则判坏实现。
  // 每个节点按自己名下桩槽上的权重求和（边方向无关），这是 attached 不变量的核心。
  let strengthPreserved = true;
  if (weightPolicy === 'attached') {
    const nullStrength = new Array(n).fill(0);
    edgeSlots.forEach(({ u, slotU, v, slotV }) => {
      nullStrength[u] += stubWeight[u][slotU];
      nullStrength[v] += stubWeight[v][slotV];
    });
    strengthPreserved = nullStrength.every((value, node) =>
      Math.abs(value - graph.strengths[node]) < 1e-9);
  }

  return {
    seed,
    valid: valid && (weightPolicy === 'reshuffle' || strengthPreserved),
    degreePreserved,
    strengthPreserved,
    swapTargetMet,
    successfulSwaps,
    minSwaps,
    attempts,
    maxAttemptsPerSwap,
    stopReason,
    weightPolicy,
    allowCrossComponent,
    edges: rebuilt,
  };
}

// 用实现边重建与原图同形状的图对象（同节点集、同配置、同分量处理规则）。
// attached 实现的边带两端桩权重，无向标量权重取均值：边权总和守恒，
// 且 reshuffle 下两端相等，均值即原标量。
export function graphFromRealization(baseGraph, realization) {
  const edges = realization.edges.map(({ u, v, weightU, weightV }) => {
    const endpoints = u < v ? [baseGraph.nodes[u], baseGraph.nodes[v]]
      : [baseGraph.nodes[v], baseGraph.nodes[u]];
    return {
      key: `${endpoints[0]}\u0001${endpoints[1]}`,
      endpoints,
      weight: (weightU + weightV) / 2,
      endWeights: { [baseGraph.nodes[u]]: weightU, [baseGraph.nodes[v]]: weightV },
      mergedRawAmount: null, // 零模型边不对应真实合作，金额一律置空
      parallelCount: 1,
      recordIds: [],
      rawAmounts: [],
      relations: [],
      periods: [],
      synthetic: true,
    };
  }).sort((a, b) => a.key.localeCompare(b.key, 'en'));

  const adjacency = baseGraph.nodes.map(() => []);
  for (const edge of edges) {
    const u = baseGraph.index.get(edge.endpoints[0]);
    const v = baseGraph.index.get(edge.endpoints[1]);
    adjacency[u].push({ node: v, edge });
    adjacency[v].push({ node: u, edge });
  }
  const degrees = adjacency.map(neighbors => neighbors.length);
  // 强度按端权重核对：与 attached 的逐节点守恒自证口径一致。
  const strengths = new Array(baseGraph.nodes.length).fill(0);
  for (const edge of realization.edges) {
    strengths[edge.u] += edge.weightU;
    strengths[edge.v] += edge.weightV;
  }
  const components = connectedComponents(baseGraph.nodes, adjacency);
  return {
    ...baseGraph,
    edges,
    adjacency,
    degrees,
    strengths,
    components,
    selfLoops: [],
    synthetic: true,
  };
}

export function generateNullEnsemble(graph, options = {}) {
  const realizations = options.realizations ?? 200;
  const swapMultiplier = options.swapMultiplier ?? 10;
  const minSwaps = options.minSwaps ?? Math.max(10, swapMultiplier * graph.edges.length);
  const maxAttemptsPerSwap = options.maxAttemptsPerSwap ?? 1000;
  const allowCrossComponent = options.allowCrossComponent ?? false;
  const weightPolicy = options.weightPolicy ?? 'reshuffle';
  const seedBase = options.seedBase ?? 7919;
  if (!['reshuffle', 'attached'].includes(weightPolicy)) {
    throw new Error('边权处置策略仅支持 reshuffle 或 attached');
  }
  if (!Number.isSafeInteger(realizations) || realizations < 1) {
    throw new Error('realizations 必须为不小于 1 的安全整数');
  }

  const results = [];
  for (let k = 0; k < realizations; k += 1) {
    const seed = mixSeed(seedBase, k + 1);
    results.push(oneRealization(graph, seed, {
      minSwaps, maxAttemptsPerSwap, allowCrossComponent, weightPolicy,
    }));
  }

  const validResults = results.filter(result => result.valid);
  const invalidResults = results.filter(result => !result.valid);
  const reasons = {};
  for (const result of invalidResults) {
    const reason = result.stopReason
      ?? (result.degreePreserved ? 'swap-target-not-met' : 'degree-sequence-broken');
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  return {
    config: {
      realizations,
      minSwaps,
      swapMultiplier,
      maxAttemptsPerSwap,
      allowCrossComponent,
      weightPolicy,
      seedBase,
      method: 'double-edge-swap',
      degreeSequence: graph.nodes.map((node, index) => ({ node, degree: graph.degrees[index] })),
    },
    validCount: validResults.length,
    invalidCount: invalidResults.length,
    invalidReasons: reasons,
    diagnostics: {
      meanAttemptsPerValidRealization: validResults.length
        ? Number((validResults.reduce((sum, result) => sum + result.attempts, 0)
          / validResults.length).toFixed(2))
        : null,
      meanSuccessfulSwaps: validResults.length
        ? Number((validResults.reduce((sum, result) => sum + result.successfulSwaps, 0)
          / validResults.length).toFixed(2))
        : null,
    },
    validResults,
    allValid: invalidResults.length === 0,
  };
}

// Benjamini-Hochberg 错误发现率控制；p 值按升序调整，保持与输入同序返回。
export function benjaminiHochberg(pValues) {
  const indexed = pValues.map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p);
  const m = pValues.length;
  const adjusted = new Array(m).fill(1);
  let previous = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const value = Math.min(previous, indexed[rank - 1].p * m / rank);
    adjusted[indexed[rank - 1].index] = Number(value.toFixed(6));
    previous = value;
  }
  return adjusted;
}
