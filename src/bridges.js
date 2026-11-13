// 跨社群连接贡献分析。
// 所有路径类指标只在连通分量内部计算：跨分量距离为无穷大，显式跳过，绝不按零处理。
// 结论可追溯：每条跨社群边都带原始记录 id 列表。

// Tarjan 求割边（拓扑桥）：删除后会使连通分量数增加的边。
export function topologicalBridges(graph) {
  const timer = { value: 0 };
  const discovery = new Array(graph.nodes.length).fill(-1);
  const low = new Array(graph.nodes.length).fill(0);
  const bridgeKeys = new Set();

  for (const component of graph.components) {
    const start = component[0];
    const stack = [{ node: start, parent: -1, parentEdge: null, cursor: 0 }];
    discovery[start] = low[start] = timer.value;
    timer.value += 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = graph.adjacency[frame.node];
      if (frame.cursor < neighbors.length) {
        const { node: next, edge } = neighbors[frame.cursor];
        frame.cursor += 1;
        if (next === frame.parent) continue;
        if (discovery[next] !== -1) {
          low[frame.node] = Math.min(low[frame.node], discovery[next]);
        } else {
          discovery[next] = low[next] = timer.value;
          timer.value += 1;
          stack.push({ node: next, parent: frame.node, parentEdge: edge.key, cursor: 0 });
        }
      } else {
        stack.pop();
        if (frame.parent !== -1) {
          low[frame.parent] = Math.min(low[frame.parent], low[frame.node]);
          if (low[frame.node] > discovery[frame.parent]) {
            bridgeKeys.add(frame.parentEdge);
          }
        }
      }
    }
  }
  return bridgeKeys;
}

// 无权 Brandes 介数（跳数最短路径），按连通分量分别做 BFS。
// 输出节点介数与边介数，无向图最终统一除以 2；跨分量节点对不产生路径。
export function betweenness(graph) {
  const nodeBc = new Array(graph.nodes.length).fill(0);
  const edgeBc = new Map();
  for (const edge of graph.edges) edgeBc.set(edge.key, 0);

  for (const component of graph.components) {
    if (component.length <= 2) {
      // 两节点分量的唯一边仍需计数，走通用流程即可；这里无需特判跳过。
    }
    for (const source of component) {
      const predecessors = Array.from({ length: graph.nodes.length }, () => []);
      const sigma = new Array(graph.nodes.length).fill(0);
      const distance = new Array(graph.nodes.length).fill(-1);
      sigma[source] = 1;
      distance[source] = 0;
      const order = [];
      const queue = [source];
      while (queue.length > 0) {
        const node = queue.shift();
        order.push(node);
        for (const { node: neighbor, edge } of graph.adjacency[node]) {
          if (distance[neighbor] === -1) {
            distance[neighbor] = distance[node] + 1;
            queue.push(neighbor);
          }
          if (distance[neighbor] === distance[node] + 1) {
            sigma[neighbor] += sigma[node];
            predecessors[neighbor].push({ from: node, edgeKey: edge.key });
          }
        }
      }
      const delta = new Array(graph.nodes.length).fill(0);
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const node = order[i];
        for (const { from, edgeKey } of predecessors[node]) {
          const share = sigma[from] / sigma[node] * (1 + delta[node]);
          delta[from] += share;
          edgeBc.set(edgeKey, edgeBc.get(edgeKey) + share);
        }
        if (node !== source) nodeBc[node] += delta[node];
      }
    }
  }
  for (let i = 0; i < nodeBc.length; i += 1) nodeBc[i] /= 2;
  for (const key of edgeBc.keys()) edgeBc.set(key, edgeBc.get(key) / 2);
  return { nodeBc, edgeBc };
}

function round6(value) {
  return Number(value.toFixed(6));
}

// 完整桥贡献画像，绑定指定分区（节点 -> 稳定社群名）。
export function computeBridgeProfile(graph, assignment, communityNames) {
  const nameOfNode = assignment.map((label, node) => communityNames
    .find(community => community.members.includes(graph.nodes[node]))?.community ?? `X${label}`);

  const { nodeBc, edgeBc } = betweenness(graph);
  const bridgeKeys = topologicalBridges(graph);

  // 每节点对各社群的加权强度（参与系数用）。
  const strengthByCommunity = Array.from({ length: graph.nodes.length }, () => new Map());
  const totalStrength = new Array(graph.nodes.length).fill(0);
  for (const edge of graph.edges) {
    const u = graph.index.get(edge.endpoints[0]);
    const v = graph.index.get(edge.endpoints[1]);
    totalStrength[u] += edge.weight;
    totalStrength[v] += edge.weight;
    const mapU = strengthByCommunity[u];
    mapU.set(nameOfNode[v], (mapU.get(nameOfNode[v]) ?? 0) + edge.weight);
    const mapV = strengthByCommunity[v];
    mapV.set(nameOfNode[u], (mapV.get(nameOfNode[u]) ?? 0) + edge.weight);
  }

  const crossEdges = [];
  const crossDegree = new Array(graph.nodes.length).fill(0);
  const crossWeight = new Array(graph.nodes.length).fill(0);
  for (const edge of graph.edges) {
    const u = graph.index.get(edge.endpoints[0]);
    const v = graph.index.get(edge.endpoints[1]);
    const crosses = nameOfNode[u] !== nameOfNode[v];
    if (crosses) {
      crossDegree[u] += 1;
      crossDegree[v] += 1;
      crossWeight[u] += edge.weight;
      crossWeight[v] += edge.weight;
      crossEdges.push({
        key: edge.key,
        endpoints: edge.endpoints,
        communities: [nameOfNode[u], nameOfNode[v]].sort((a, b) => a.localeCompare(b, 'en')),
        weight: edge.weight,
        mergedRawAmount: edge.mergedRawAmount,
        parallelCount: edge.parallelCount,
        recordIds: edge.recordIds,
        relations: edge.relations,
        periods: edge.periods,
        edgeBetweenness: round6(edgeBc.get(edge.key) ?? 0),
        topologicalBridge: bridgeKeys.has(edge.key),
      });
    }
  }
  crossEdges.sort((a, b) =>
    (b.edgeBetweenness - a.edgeBetweenness) || a.key.localeCompare(b.key, 'en'));

  const nodes = graph.nodes.map((nodeId, node) => {
    let participation = 0;
    if (totalStrength[node] > 0) {
      const sumSquares = [...strengthByCommunity[node].values()]
        .reduce((sum, value) => sum + (value / totalStrength[node]) ** 2, 0);
      participation = 1 - sumSquares;
    }
    return {
      node: nodeId,
      community: nameOfNode[node],
      degree: graph.degrees[node],
      strength: round6(totalStrength[node]),
      crossCommunityDegree: crossDegree[node],
      crossCommunityWeight: round6(crossWeight[node]),
      crossWeightShare: totalStrength[node] > 0 ? round6(crossWeight[node] / totalStrength[node]) : 0,
      participation: round6(participation),
      nodeBetweenness: round6(nodeBc[node]),
      isIsolate: graph.degrees[node] === 0,
    };
  }).sort((a, b) =>
    (b.crossCommunityDegree - a.crossCommunityDegree)
    || (b.participation - a.participation)
    || a.node.localeCompare(b.node, 'en'));

  return {
    crossEdges,
    nodes,
    topologicalBridgeCount: bridgeKeys.size,
    crossEdgeCount: crossEdges.length,
  };
}
