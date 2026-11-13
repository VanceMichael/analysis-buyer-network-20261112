// 按分析配置把原始记录投影为无向加权简单图。
// 该模块只读取记录，从不修改输入数组或记录对象（整个分析不改原始边）。

export const SCALE_POLICIES = new Set(['none', 'log1p']);
export const PARALLEL_POLICIES = new Set(['sum', 'count', 'max', 'mean']);

function undirectedKey(left, right) {
  return left < right ? `${left}\u0001${right}` : `${right}\u0001${left}`;
}

export function resolveGraphConfig(policy = {}) {
  const config = {
    fromPeriod: policy.fromPeriod ?? null,
    toPeriod: policy.toPeriod ?? null,
    relations: Array.isArray(policy.relations) ? policy.relations.map(String) : null,
    parallelPolicy: policy.parallelPolicy ?? 'sum',
    scale: policy.scale ?? 'none',
    selfLoops: policy.selfLoops ?? 'report-only',
    nodeUniverse: Array.isArray(policy.nodes) ? policy.nodes.map(String) : null,
  };
  if (config.fromPeriod !== null && !Number.isSafeInteger(config.fromPeriod)) {
    throw new Error('fromPeriod 必须为整数或留空');
  }
  if (config.toPeriod !== null && !Number.isSafeInteger(config.toPeriod)) {
    throw new Error('toPeriod 必须为整数或留空');
  }
  if (config.fromPeriod !== null && config.toPeriod !== null
      && config.fromPeriod > config.toPeriod) {
    throw new Error('时间窗口要求 fromPeriod <= toPeriod');
  }
  if (!PARALLEL_POLICIES.has(config.parallelPolicy)) {
    throw new Error(`平行边合并策略不支持：${config.parallelPolicy}`);
  }
  if (!SCALE_POLICIES.has(config.scale)) {
    throw new Error(`金额缩放策略不支持：${config.scale}`);
  }
  if (!['report-only', 'include'].includes(config.selfLoops)) {
    throw new Error('selfLoops 仅支持 report-only 或 include');
  }
  return config;
}

function scaleAmount(amount, scale) {
  if (scale === 'log1p') {
    if (amount < 0) throw new Error('log1p 缩放要求金额非负');
    return Math.log1p(amount);
  }
  return amount;
}

// 每条无向边保留：合并权重、参与合并的原始记录、合并前原始金额（复查用）。
export function buildGraph(records, policy = {}) {
  const config = resolveGraphConfig(policy);
  const accepted = [];
  for (const row of records) {
    if (config.fromPeriod !== null && row.period < config.fromPeriod) continue;
    if (config.toPeriod !== null && row.period > config.toPeriod) continue;
    if (config.relations !== null && !config.relations.includes(row.relation)) continue;
    accepted.push(row);
  }

  const nodeSet = new Set(config.nodeUniverse ?? []);
  const edgeMap = new Map();
  const selfLoops = [];
  let rejectedSelfLoops = 0;

  for (const row of accepted) {
    nodeSet.add(row.left);
    nodeSet.add(row.right);
    if (row.left === row.right) {
      // 自环始终单列；report-only 不参与任何拓扑与强度，include 仅额外计入节点强度，
      // 但永不进入普通边集合与邻接表（无向简单图里自环不贡献度）。
      selfLoops.push({
        node: row.left,
        recordId: row.id,
        period: row.period,
        relation: row.relation,
        rawAmount: row.amount,
        weight: scaleAmount(row.amount, config.scale),
      });
      rejectedSelfLoops += config.selfLoops === 'report-only' ? 1 : 0;
      continue;
    }
    const key = undirectedKey(row.left, row.right);
    const endpoints = row.left < row.right ? [row.left, row.right] : [row.right, row.left];
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        key,
        endpoints,
        recordIds: [],
        rawAmounts: [],
        relations: [],
        periods: [],
        sumRaw: 0,
        maxRaw: 0,
      });
    }
    const edge = edgeMap.get(key);
    edge.recordIds.push(row.id);
    edge.rawAmounts.push(row.amount);
    edge.relations.push(row.relation);
    edge.periods.push(row.period);
    edge.sumRaw += row.amount;
    edge.maxRaw = Math.max(edge.maxRaw, row.amount);
  }

  const nodes = [...nodeSet].sort((a, b) => a.localeCompare(b, 'en'));
  const edges = [...edgeMap.values()].map((edge) => {
    const count = edge.rawAmounts.length;
    let mergedRaw;
    switch (config.parallelPolicy) {
      case 'sum': mergedRaw = edge.sumRaw; break;
      case 'count': mergedRaw = count; break;
      case 'max': mergedRaw = edge.maxRaw; break;
      case 'mean': mergedRaw = edge.sumRaw / count; break;
      default: throw new Error(`平行边合并策略不支持：${config.parallelPolicy}`);
    }
    return {
      key: edge.key,
      endpoints: edge.endpoints,
      weight: scaleAmount(mergedRaw, config.scale),
      mergedRawAmount: mergedRaw,
      parallelCount: count,
      recordIds: edge.recordIds.slice(),
      rawAmounts: edge.rawAmounts.slice(),
      relations: [...new Set(edge.relations)].sort((a, b) => a.localeCompare(b, 'en')),
      periods: [...new Set(edge.periods)].sort((a, b) => a - b),
    };
  }).sort((a, b) => a.key.localeCompare(b.key, 'en'));

  const index = new Map(nodes.map((node, i) => [node, i]));
  const adjacency = nodes.map(() => []);
  for (const edge of edges) {
    const u = index.get(edge.endpoints[0]);
    const v = index.get(edge.endpoints[1]);
    adjacency[u].push({ node: v, edge });
    adjacency[v].push({ node: u, edge });
  }
  const degrees = adjacency.map(neighbors => neighbors.length);
  const strengths = adjacency.map((neighbors, i) =>
    neighbors.reduce((sum, { edge }) => sum + edge.weight, 0)
    + (config.selfLoops === 'include'
      ? selfLoops.filter(loop => loop.node === nodes[i]).reduce((sum, loop) => sum + loop.weight, 0)
      : 0));

  const components = connectedComponents(nodes, adjacency);

  return {
    config,
    nodes,
    index,
    edges,
    adjacency,
    degrees,
    strengths,
    components,
    selfLoops: selfLoops.sort((a, b) => a.recordId.localeCompare(b.recordId, 'en')),
    selfLoopsExcludedFromTopology: rejectedSelfLoops,
    windowRecordCount: accepted.length,
    totalWeight: edges.reduce((sum, edge) => sum + edge.weight, 0)
      + (config.selfLoops === 'include' ? selfLoops.reduce((sum, loop) => sum + loop.weight, 0) : 0),
  };
}

// 广度优先连通分量；孤立点各自为一个分量，不会被并入任何大分量。
export function connectedComponents(nodes, adjacency) {
  const seen = new Array(nodes.length).fill(false);
  const components = [];
  for (let start = 0; start < nodes.length; start += 1) {
    if (seen[start]) continue;
    const members = [];
    const queue = [start];
    seen[start] = true;
    while (queue.length > 0) {
      const current = queue.shift();
      members.push(current);
      for (const { node } of adjacency[current]) {
        if (!seen[node]) {
          seen[node] = true;
          queue.push(node);
        }
      }
    }
    components.push(members.sort((a, b) => nodes[a].localeCompare(nodes[b], 'en')));
  }
  return components.sort((a, b) =>
    (b.length - a.length) || nodes[a[0]].localeCompare(nodes[b[0]], 'en'));
}
