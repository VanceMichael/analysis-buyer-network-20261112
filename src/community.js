// 加权 Louvain 社群发现，全部随机顺序由注入的确定性 RNG 控制。
// 设计约束：
//   - 分辨率 gamma 可调；目标社群数 targetCommunities 为尽力目标，达不到时给诊断；
//   - 图断开时按连通分量分别检测，再合并结果，跨分量永远不会被分到一起；
//   - 孤立点（度为 0）始终单成社群，合并阶段禁止把它们塞进大社群；
//   - 社群标识按成员集合稳定命名，与运行序号无关。

import { mulberry32, shuffled } from './rng.js';

// 在单个连通分量的诱导子图上跑加权 Louvain。
// adjacency: 全图邻接表；members: 该分量的全局节点下标（已排序）。
// 返回全局节点下标 -> 局部分区标签 的 Map。
function louvainComponent(graph, members, rng, resolution) {
  const localIndex = new Map(members.map((globalNode, localNode) => [globalNode, localNode]));
  const n = members.length;
  if (n <= 1) return new Map(members.map(node => [node, 0]));

  // 构造局部加权邻接（无向边存两个方向），自环不参与拓扑，已在建图阶段单列。
  const adj = Array.from({ length: n }, () => []);
  let twiceWeight = 0;
  for (const globalNode of members) {
    const u = localIndex.get(globalNode);
    for (const { node: globalNeighbor, edge } of graph.adjacency[globalNode]) {
      if (!localIndex.has(globalNeighbor)) continue; // 理论上不会出现：分量内闭环
      const v = localIndex.get(globalNeighbor);
      adj[u].push({ node: v, weight: edge.weight });
      twiceWeight += edge.weight;
    }
  }
  if (twiceWeight === 0) {
    // 零权边构成的分量：退化为每点一群，避免除零。
    return new Map(members.map(node => [node, localIndex.get(node)]));
  }

  // meta 节点即当前层级节点；partition 记录每个原始节点归属的 meta 根。
  // 标准 Louvain 约定：聚合后社区内部边变成元节点自环，自环权重在节点强度与
  // 总权重中按 2 倍计数；总权重 2m 在所有层级保持为原图值，绝不随聚合缩小。
  let metaAdj = adj;
  let metaSelf = new Array(n).fill(0);
  let metaCount = n;
  let rootOf = Array.from({ length: n }, (_, i) => i);
  const fixedTwiceWeight = twiceWeight;

  for (let level = 0; level < n; level += 1) {
    let community = Array.from({ length: metaCount }, (_, i) => i);
    const strength = metaAdj.map((neighbors, i) =>
      neighbors.reduce((sum, link) => sum + link.weight, 0) + 2 * metaSelf[i]);
    let moved = true;
    let passes = 0;
    while (moved && passes < 100) {
      moved = false;
      passes += 1;
      const order = shuffled(rng, Array.from({ length: metaCount }, (_, i) => i));
      for (const node of order) {
        const current = community[node];
        const linkToCommunity = new Map();
        for (const { node: neighbor, weight } of metaAdj[node]) {
          if (neighbor === node) continue;
          const target = community[neighbor];
          linkToCommunity.set(target, (linkToCommunity.get(target) ?? 0) + weight);
        }
        // 社区总强度；移除 node 后当前社区强度要减去 node 强度。
        const communityStrength = new Map();
        for (let i = 0; i < metaCount; i += 1) {
          communityStrength.set(community[i],
            (communityStrength.get(community[i]) ?? 0) + strength[i]);
        }
        let bestCommunity = current;
        let bestGain = 0; // 只接受严格正增益，平局保持原社区，保证确定性
        for (const candidate of [...linkToCommunity.keys()].sort((a, b) => a - b)) {
          if (candidate === current) continue;
          const kiIn = linkToCommunity.get(candidate);
          const sigmaTot = communityStrength.get(candidate);
          const gain = kiIn - (resolution * sigmaTot * strength[node]) / fixedTwiceWeight;
          if (gain > bestGain) {
            bestGain = gain;
            bestCommunity = candidate;
          }
        }
        if (bestCommunity !== current) {
          community[node] = bestCommunity;
          moved = true;
        }
      }
    }

    // 压缩标签到连续区间。
    const remap = new Map();
    for (const label of community) {
      if (!remap.has(label)) remap.set(label, remap.size);
    }
    const compressed = community.map(label => remap.get(label));
    const nextCount = remap.size;
    if (nextCount === metaCount || nextCount === 1) {
      rootOf = rootOf.map(meta => compressed[meta]);
      break;
    }

    // 聚合为加权元图：跨社区边累加，社区内部边（含旧自环）转为新元节点自环。
    const nextAdj = Array.from({ length: nextCount }, () => []);
    const nextSelf = new Array(nextCount).fill(0);
    const linkMap = Array.from({ length: nextCount }, () => new Map());
    for (let u = 0; u < metaCount; u += 1) {
      nextSelf[compressed[u]] += metaSelf[u];
      for (const { node: v, weight } of metaAdj[u]) {
        const cu = compressed[u];
        const cv = compressed[v];
        if (cu === cv) {
          nextSelf[cu] += weight; // 每条内部边在此计一次，强度端再以 2 倍计入
        } else {
          linkMap[cu].set(cv, (linkMap[cu].get(cv) ?? 0) + weight);
        }
      }
    }
    for (let u = 0; u < nextCount; u += 1) {
      nextAdj[u] = [...linkMap[u].entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([node, weight]) => ({ node, weight }));
    }
    rootOf = rootOf.map(meta => compressed[meta]);
    metaAdj = nextAdj;
    metaSelf = nextSelf;
    metaCount = nextCount;
  }

  return new Map(members.map((globalNode, localNode) => [globalNode, rootOf[localNode]]));
}

// 加权模块度（Blondel 定义，分辨率 gamma），直接在原图上核算，不依赖迭代中间量。
export function modularity(graph, assignment, resolution) {
  const twiceWeight = 2 * graph.edges.reduce((sum, edge) => sum + edge.weight, 0);
  if (twiceWeight === 0) return 0;
  let internal = 0;
  const communityStrength = new Map();
  const nodeStrength = new Map();
  for (const edge of graph.edges) {
    const u = graph.index.get(edge.endpoints[0]);
    const v = graph.index.get(edge.endpoints[1]);
    const cu = assignment[u];
    const cv = assignment[v];
    nodeStrength.set(u, (nodeStrength.get(u) ?? 0) + edge.weight);
    nodeStrength.set(v, (nodeStrength.get(v) ?? 0) + edge.weight);
    communityStrength.set(cu, (communityStrength.get(cu) ?? 0) + edge.weight);
    communityStrength.set(cv, (communityStrength.get(cv) ?? 0) + edge.weight);
    if (cu === cv) internal += 2 * edge.weight;
  }
  let penalty = 0;
  for (const strength of communityStrength.values()) {
    penalty += (strength / twiceWeight) ** 2;
  }
  return internal / twiceWeight - resolution * penalty;
}

function communityMembers(assignment, nodeCount) {
  const groups = new Map();
  for (let node = 0; node < nodeCount; node += 1) {
    const label = assignment[node];
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(node);
  }
  return [...groups.values()].map(members => members.sort((a, b) => a - b));
}

// 社群数偏多：按模块度合并增益贪心合并；isolateLabels 中的社群（孤立点）禁止参与。
function mergeToTarget(graph, assignment, target, resolution, isolateLabels) {
  let current = assignment.slice();
  const merges = [];
  const twiceWeight = 2 * graph.edges.reduce((sum, edge) => sum + edge.weight, 0);

  const activeLabelCount = () =>
    new Set(current.filter(label => !isolateLabels.has(label))).size;

  while (activeLabelCount() > target && twiceWeight > 0) {
    // 社区间权重与社区强度（每轮基于当前分区线性扫描一次）。
    const between = new Map();
    const strength = new Map();
    for (const edge of graph.edges) {
      const u = graph.index.get(edge.endpoints[0]);
      const v = graph.index.get(edge.endpoints[1]);
      const cu = current[u];
      const cv = current[v];
      strength.set(cu, (strength.get(cu) ?? 0) + edge.weight);
      strength.set(cv, (strength.get(cv) ?? 0) + edge.weight);
      if (cu === cv) continue;
      const key = cu < cv ? `${cu}\u0001${cv}` : `${cv}\u0001${cu}`;
      between.set(key, (between.get(key) ?? 0) + edge.weight);
    }
    let bestPair = null;
    let bestDelta = -Infinity;
    for (const [key, crossWeight] of between) {
      const [a, b] = key.split('\u0001').map(Number);
      if (isolateLabels.has(a) || isolateLabels.has(b)) continue; // 孤立社群受保护
      const delta = crossWeight / twiceWeight
        - resolution * (strength.get(a) * strength.get(b)) / (twiceWeight ** 2);
      if (delta > bestDelta
          || (delta === bestDelta && bestPair && key < `${bestPair[0]}\u0001${bestPair[1]}`)) {
        bestDelta = delta;
        bestPair = [a, b];
      }
    }
    if (!bestPair) break; // 剩余可合并社群之间已无边，无法继续
    const [keep, drop] = bestPair;
    current = current.map(label => (label === drop ? keep : label));
    merges.push({ absorbed: drop, into: keep, delta: Number(bestDelta.toFixed(6)) });
  }
  return { assignment: relabel(current), merges };
}

// 社群数偏少：对最大的非孤立社群在诱导子图上提高分辨率再跑 Louvain 尝试拆分。
// 孤立社群永不作为拆分对象，也不占用目标名额。
function splitToTarget(graph, assignment, target, resolution, rng, isolateLabels) {
  let current = assignment.slice();
  const splits = [];
  const activeCount = () =>
    new Set(current.filter(label => !isolateLabels.has(label))).size;
  let guard = 0;
  while (activeCount() < target && guard < graph.nodes.length * 4) {
    guard += 1;
    const groups = communityMembers(current, graph.nodes.length)
      .filter(group => !isolateLabels.has(current[group[0]]))
      .sort((a, b) => (b.length - a.length) || (a[0] - b[0]));
    const candidate = groups.find(group => group.length > 1);
    if (!candidate) break;
    const subResult = louvainComponent(
      graph,
      candidate.slice().sort((a, b) => a - b),
      rng,
      resolution * 2,
    );
    const subLabels = [...new Set([...subResult.values()])];
    if (subLabels.length <= 1) break;
    const nextLabel = Math.max(...current) + 1;
    const localRemap = new Map();
    subLabels.forEach((label, i) =>
      localRemap.set(label, i === 0 ? current[candidate[0]] : nextLabel + i - 1));
    for (const [node, label] of subResult) {
      current[node] = localRemap.get(label);
    }
    splits.push({ community: current[candidate[0]], pieces: subLabels.length, factor: 2 });
    current = relabel(current);
  }
  return { assignment: relabel(current), splits };
}

function relabel(assignment) {
  const order = [];
  const seen = new Set();
  for (const label of assignment) {
    if (!seen.has(label)) {
      seen.add(label);
      order.push(label);
    }
  }
  const remap = new Map(order.map((label, i) => [label, i]));
  return assignment.map(label => remap.get(label));
}

// 按成员集合稳定命名：社群按成员最小节点排序后给 C01、C02…，
// 成员集合相同的分区在任何运行中都得到相同名字。
export function stableNames(graph, assignment) {
  const groups = communityMembers(assignment, graph.nodes.length)
    .map(members => ({
      members,
      signature: members.map(node => graph.nodes[node])
        .sort((a, b) => a.localeCompare(b, 'en'))
        .join('|'),
    }))
    .sort((a, b) => a.signature.localeCompare(b.signature, 'en'));
  const nameByLabel = new Map();
  groups.forEach((group, i) => {
    nameByLabel.set(assignment[group.members[0]],
      `C${String(i + 1).padStart(2, '0')}`);
  });
  return groups.map((group, i) => ({
    community: `C${String(i + 1).padStart(2, '0')}`,
    members: group.signature.split('|'),
    size: group.members.length,
    isIsolateCommunity: group.members.every(node => graph.degrees[node] === 0),
  }));
}

// 调整兰德指数；对全单点、全单群等退化情形显式定义，不产出 NaN。
export function adjustedRandIndex(left, right) {
  const n = left.length;
  if (n < 2) return 1;
  const contingency = new Map();
  const rowSum = new Map();
  const colSum = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = `${left[i]}\u0001${right[i]}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    rowSum.set(left[i], (rowSum.get(left[i]) ?? 0) + 1);
    colSum.set(right[i], (colSum.get(right[i]) ?? 0) + 1);
  }
  const choose2 = x => (x * (x - 1)) / 2;
  let index = 0;
  for (const count of contingency.values()) index += choose2(count);
  const expected = [...rowSum.values()].reduce((sum, a) => sum + choose2(a), 0)
    * [...colSum.values()].reduce((sum, b) => sum + choose2(b), 0) / choose2(n);
  const maxIndex = 0.5 * (
    [...rowSum.values()].reduce((sum, a) => sum + choose2(a), 0)
    + [...colSum.values()].reduce((sum, b) => sum + choose2(b), 0));
  const denominator = maxIndex - expected;
  if (denominator === 0) return index === expected ? 1 : 0;
  return (index - expected) / denominator;
}

// 完整单次运行：分分量 Louvain -> 目标数调整 -> 模块度复核。
function detectOnce(graph, resolution, target, rng) {
  const assignment = new Array(graph.nodes.length).fill(-1);
  for (const component of graph.components) {
    const partial = louvainComponent(graph, component, rng, resolution);
    for (const [node, label] of partial) assignment[node] = label;
  }
  // 各分量局部标签可能撞号，按（分量首节点, 局部标签）全局重标号。
  const globalLabels = new Map();
  for (const component of graph.components) {
    for (const node of component) {
      const localKey = `${component[0]}:${assignment[node]}`;
      if (!globalLabels.has(localKey)) globalLabels.set(localKey, globalLabels.size);
      assignment[node] = globalLabels.get(localKey);
    }
  }
  let targetMet = true;
  let adjustment = { merges: [], splits: [] };
  // 目标社群数只约束非孤立社群；孤立点社群在拆并两个方向上都豁免。
  const isolateLabels = new Set(
    graph.components.filter(component => component.length === 1
      && graph.degrees[component[0]] === 0)
      .map(component => assignment[component[0]]));
  const activeLabels = new Set(assignment.filter(label => !isolateLabels.has(label)));
  const activeCount = activeLabels.size;
  if (target !== null && activeCount > target) {
    const result = mergeToTarget(graph, assignment, target, resolution, isolateLabels);
    adjustment.merges = result.merges;
    result.assignment.forEach((label, node) => { assignment[node] = label; });
    targetMet = new Set(assignment.filter(label => !isolateLabels.has(label))).size === target;
  } else if (target !== null && activeCount < target) {
    const result = splitToTarget(graph, assignment, target, resolution, rng, isolateLabels);
    adjustment.splits = result.splits;
    result.assignment.forEach((label, node) => { assignment[node] = label; });
    // 拆分可能一次跳跃越过目标（最小社群无法再细分），用受保护合并回收到精确目标。
    if (new Set(assignment.filter(label => !isolateLabels.has(label))).size > target) {
      const merged = mergeToTarget(graph, assignment, target, resolution, isolateLabels);
      adjustment.merges = merged.merges;
      merged.assignment.forEach((label, node) => { assignment[node] = label; });
    }
    targetMet = new Set(assignment.filter(label => !isolateLabels.has(label))).size === target;
  }
  return {
    assignment: relabel(assignment),
    modularity: modularity(graph, relabel(assignment), resolution),
    targetMet,
    communityCount: new Set(assignment).size,
    adjustment,
  };
}

// 多种子运行 + 成对稳定性 + 全票共识分区（只合并在每次运行中都同群的节点）。
export function detectCommunities(graph, options) {
  const resolution = options.resolution ?? 1;
  if (!(resolution > 0) || !Number.isFinite(resolution)) {
    throw new Error('分辨率 resolution 必须为正数');
  }
  const target = options.targetCommunities ?? null;
  if (target !== null && (!Number.isSafeInteger(target) || target < 1)) {
    throw new Error('目标社群数 targetCommunities 必须为正整数或留空');
  }
  const seeds = (options.seeds ?? [11, 23, 37]).map(seed => {
    if (!Number.isSafeInteger(seed)) throw new Error('种子必须为安全整数');
    return seed;
  });
  if (seeds.length === 0) throw new Error('至少需要一个种子');

  const runs = seeds.map((seed) => {
    const rng = mulberry32(seed);
    const result = detectOnce(graph, resolution, target, rng);
    return { seed, ...result, communities: stableNames(graph, result.assignment) };
  });

  // 成对 ARI 稳定性矩阵。
  const pairMatrix = [];
  const values = [];
  for (let i = 0; i < runs.length; i += 1) {
    const row = [];
    for (let j = 0; j < runs.length; j += 1) {
      const ari = i === j ? 1 : adjustedRandIndex(runs[i].assignment, runs[j].assignment);
      row.push(Number(ari.toFixed(6)));
      if (i < j) values.push(ari);
    }
    pairMatrix.push(row);
  }
  const stability = values.length === 0
    ? { pairwiseMean: 1, pairwiseMin: 1, pairwise: pairMatrix }
    : {
      pairwiseMean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)),
      pairwiseMin: Number(Math.min(...values).toFixed(6)),
      pairwise: pairMatrix,
    };

  // 全票共识：共现频率 100% 的节点归入同一共识社群。
  const alwaysTogether = Array.from({ length: graph.nodes.length }, () => []);
  for (let a = 0; a < graph.nodes.length; a += 1) {
    for (let b = a + 1; b < graph.nodes.length; b += 1) {
      const always = runs.every(run => run.assignment[a] === run.assignment[b]);
      if (always) {
        alwaysTogether[a].push(b);
        alwaysTogether[b].push(a);
      }
    }
  }
  const consensusAssignment = new Array(graph.nodes.length).fill(-1);
  let consensusCount = 0;
  for (let start = 0; start < graph.nodes.length; start += 1) {
    if (consensusAssignment[start] !== -1) continue;
    const queue = [start];
    consensusAssignment[start] = consensusCount;
    while (queue.length > 0) {
      const node = queue.shift();
      for (const neighbor of alwaysTogether[node]) {
        if (consensusAssignment[neighbor] === -1) {
          consensusAssignment[neighbor] = consensusCount;
          queue.push(neighbor);
        }
      }
    }
    consensusCount += 1;
  }

  // 选择模块度最高的运行作为代表分区（平局取种子最小者，确定且可复核）。
  const chosen = runs.reduce((best, run) =>
    (run.modularity > best.modularity
      || (run.modularity === best.modularity && run.seed < best.seed) ? run : best));

  return {
    resolution,
    targetCommunities: target,
    seeds: runs.map(run => run.seed),
    runs: runs.map(({ assignment, ...run }) => ({
      seed: run.seed,
      modularity: run.modularity,
      communityCount: run.communityCount,
      targetMet: run.targetMet,
      adjustment: run.adjustment,
      communities: run.communities,
    })),
    stability,
    consensus: {
      communityCount: consensusCount,
      communities: stableNames(graph, consensusAssignment),
    },
    chosenSeed: chosen.seed,
    chosenAssignment: chosen.assignment,
    chosenCommunities: stableNames(graph, chosen.assignment),
  };
}
