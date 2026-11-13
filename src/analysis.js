// 分析编排：建图 -> 社群发现 -> 桥贡献 -> 保度零模型检验 -> 档案。
// 档案保存图口径、种子、稳定性与零模型诊断；同一网络可凭档案重新读取复查。
// 原始记录在整个流程中只读，所有派生图都来自副本结构。

import { createHash } from 'node:crypto';
import { fingerprint, canonical } from './dataset.js';
import { buildGraph } from './graph.js';
import { detectCommunities } from './community.js';
import { computeBridgeProfile } from './bridges.js';
import { generateNullEnsemble, graphFromRealization, benjaminiHochberg } from './nullmodel.js';

export const ARCHIVE_VERSION = 1;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

// 图的可复查摘要：度序列、分量、自环、权重多重集合指纹（隐藏金额时后者仍可用于内部核对，
// 但不直接暴露金额）。所有序列按图节点数组的规范索引序输出，复查时逐位可比。
function graphDigest(graph) {
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    degreeSequence: graph.nodes.map((node, index) => ({ node, degree: graph.degrees[index] })),
    componentSizes: graph.components.map(component => component.length),
    componentMembers: graph.components.map(component =>
      component.map(node => graph.nodes[node])),
    selfLoopCount: graph.selfLoops.length,
    selfLoopsExcludedFromTopology: graph.selfLoopsExcludedFromTopology,
    weightMultisetFingerprint: digest(graph.edges.map(edge => edge.weight).sort((a, b) => a - b)),
    totalWeight: Number(graph.totalWeight.toFixed(6)),
    windowRecordCount: graph.windowRecordCount,
  };
}

function empiricalP(observed, nullValues) {
  const exceed = nullValues.reduce((count, value) => count + (value >= observed ? 1 : 0), 0);
  return Number(((1 + exceed) / (1 + nullValues.length)).toFixed(6));
}

function nullModelTest(graph, communityOptions, ensembleOptions, chosenAssignment, chosenCommunities) {
  const ensemble = generateNullEnsemble(graph, ensembleOptions);
  const minValid = ensembleOptions.minValidRealizations
    ?? Math.max(20, Math.floor(ensembleOptions.realizations * 0.5));

  const observedProfile = computeBridgeProfile(graph, chosenAssignment, chosenCommunities);
  const observedByNode = new Map(observedProfile.nodes.map(row => [row.node, row]));

  const test = {
    valid: ensemble.validCount >= minValid,
    minValidRealizations: minValid,
    reason: null,
    config: ensemble.config,
    validCount: ensemble.validCount,
    invalidCount: ensemble.invalidCount,
    invalidReasons: ensemble.invalidReasons,
    diagnostics: ensemble.diagnostics,
    nodeTests: [],
    globalTests: null,
  };
  if (!test.valid) {
    test.reason = ensemble.validCount === 0
      ? 'no-valid-null-realization-feasible-swap-space-exhausted'
      : 'valid-realizations-below-minimum';
    return { test, observedProfile };
  }

  const nullRowsByNode = new Map(graph.nodes.map(node => [node, []]));
  const nullCrossEdgeCounts = [];
  for (const realization of ensemble.validResults) {
    const nullGraph = graphFromRealization(graph, realization);
    const nullDetection = detectCommunities(nullGraph, communityOptions);
    const nullProfile = computeBridgeProfile(
      nullGraph, nullDetection.chosenAssignment, nullDetection.chosenCommunities);
    for (const row of nullProfile.nodes) nullRowsByNode.get(row.node).push(row);
    nullCrossEdgeCounts.push(nullProfile.crossEdgeCount);
  }

  for (const node of graph.nodes) {
    const observed = observedByNode.get(node);
    const rows = nullRowsByNode.get(node);
    test.nodeTests.push({
      node,
      observedCrossCommunityDegree: observed.crossCommunityDegree,
      observedParticipation: observed.participation,
      observedNodeBetweenness: observed.nodeBetweenness,
      pCrossDegree: empiricalP(observed.crossCommunityDegree,
        rows.map(row => row.crossCommunityDegree)),
      pParticipation: empiricalP(observed.participation,
        rows.map(row => row.participation)),
      pNodeBetweenness: empiricalP(observed.nodeBetweenness,
        rows.map(row => row.nodeBetweenness)),
    });
  }
  const adjustedCross = benjaminiHochberg(test.nodeTests.map(row => row.pCrossDegree));
  test.nodeTests.forEach((row, index) => {
    row.fdrCrossDegree = adjustedCross[index];
  });
  test.nodeTests.sort((a, b) => a.pCrossDegree - b.pCrossDegree
    || a.node.localeCompare(b.node, 'en'));
  test.globalTests = {
    observedCrossEdgeCount: observedProfile.crossEdgeCount,
    pCrossEdgeCount: empiricalP(observedProfile.crossEdgeCount, nullCrossEdgeCounts),
  };
  return { test, observedProfile };
}

// 按配置隐藏单边金额：删除一切可还原单条合作金额的字段，保留拓扑与记录 id 可追溯性。
function applyHiding(archive) {
  const hidden = structuredClone(archive);
  hidden.exportPolicy = { ...hidden.exportPolicy, hideAmounts: true };
  hidden.graphDigest.totalWeight = null;
  hidden.graphDigest.weightMultisetFingerprint = null;
  hidden.graphDigest.selfLoopAmountsRemoved = true;
  hidden.selfLoops = hidden.selfLoops.map(({ rawAmount, weight, ...rest }) => rest);
  hidden.bridgeProfile.crossEdges = hidden.bridgeProfile.crossEdges
    .map(({ weight, mergedRawAmount, ...rest }) => rest);
  hidden.bridgeProfile.nodes = hidden.bridgeProfile.nodes
    .map(({ strength, crossCommunityWeight, ...rest }) => rest);
  return hidden;
}

export function runAnalysis({ records, inputFingerprint, policy }) {
  const graphConfig = {
    fromPeriod: policy.fromPeriod ?? null,
    toPeriod: policy.toPeriod ?? null,
    relations: policy.relations ?? null,
    parallelPolicy: policy.parallelPolicy ?? 'sum',
    scale: policy.scale ?? 'none',
    selfLoops: policy.selfLoops ?? 'report-only',
    nodes: policy.nodes ?? null,
  };
  const graph = buildGraph(records, graphConfig);

  const communityOptions = {
    resolution: policy.resolution ?? 1,
    targetCommunities: policy.targetCommunities ?? null,
    seeds: policy.seeds ?? [11, 23, 37],
  };
  const detection = detectCommunities(graph, communityOptions);

  const ensembleOptions = {
    realizations: policy.nullRealizations ?? 100,
    swapMultiplier: policy.swapMultiplier ?? 10,
    maxAttemptsPerSwap: policy.maxAttemptsPerSwap ?? 1000,
    allowCrossComponent: policy.allowCrossComponentSwaps ?? false,
    weightPolicy: policy.nullWeightPolicy ?? 'reshuffle',
    seedBase: policy.nullSeedBase ?? 7919,
    minValidRealizations: policy.minValidRealizations,
  };
  const { test, observedProfile } = nullModelTest(
    graph, communityOptions, ensembleOptions,
    detection.chosenAssignment, detection.chosenCommunities);

  const assignment = graph.nodes.map((nodeId, node) => {
    const community = detection.chosenCommunities
      .find(entry => entry.members.includes(nodeId));
    return { node: nodeId, community: community.community };
  });

  const archive = {
    archiveVersion: ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    inputFingerprint,
    exportPolicy: { hideAmounts: policy.hideAmounts === true },
    graphConfig,
    communityConfig: {
      resolution: communityOptions.resolution,
      targetCommunities: communityOptions.targetCommunities,
      seeds: communityOptions.seeds,
    },
    nullConfig: test.config,
    graphDigest: graphDigest(graph),
    selfLoops: graph.selfLoops,
    communities: {
      chosenSeed: detection.chosenSeed,
      chosen: detection.chosenCommunities,
      consensus: detection.consensus,
      stability: detection.stability,
      seeds: detection.seeds,
      runs: detection.runs,
      assignment,
    },
    bridgeProfile: {
      crossEdgeCount: observedProfile.crossEdgeCount,
      topologicalBridgeCount: observedProfile.topologicalBridgeCount,
      crossEdges: observedProfile.crossEdges,
      nodes: observedProfile.nodes,
    },
    nullModel: test,
  };
  archive.archiveFingerprint = digest({
    inputFingerprint: archive.inputFingerprint,
    graphConfig: archive.graphConfig,
    communityConfig: archive.communityConfig,
    nullConfig: archive.nullConfig,
    graphDigest: archive.graphDigest,
    communities: archive.communities,
    bridgeProfile: archive.bridgeProfile,
    nullModel: archive.nullModel,
  });

  return policy.hideAmounts === true ? applyHiding(archive) : archive;
}

// 复查：用档案里的图口径重建图并核对指纹、度序列、分量、自环，
// 再用同样的种子重跑社群发现与零模型，比对关键结果。
export function recheckArchive({ records, inputFingerprint, archive }) {
  const checks = [];
  const record = (name, pass, detail) => checks.push({ name, pass: pass === true, detail });

  record('archiveVersion', archive.archiveVersion === ARCHIVE_VERSION,
    `archive=${archive.archiveVersion} expected=${ARCHIVE_VERSION}`);
  record('inputFingerprint', archive.inputFingerprint === inputFingerprint,
    '原始记录指纹与档案一致');
  const graph = buildGraph(records, archive.graphConfig);
  const rebuiltDigest = graphDigest(graph);
  record('degreeSequence',
    JSON.stringify(canonical(rebuiltDigest.degreeSequence))
      === JSON.stringify(canonical(archive.graphDigest.degreeSequence)),
    '逐节点度序列一致');
  record('componentSizes',
    JSON.stringify(rebuiltDigest.componentSizes) === JSON.stringify(archive.graphDigest.componentSizes),
    '连通分量大小序列一致');
  record('componentMembers',
    JSON.stringify(rebuiltDigest.componentMembers) === JSON.stringify(archive.graphDigest.componentMembers),
    '连通分量成员一致');
  record('selfLoops',
    rebuiltDigest.selfLoopCount === archive.graphDigest.selfLoopCount,
    `自环数量 rebuilt=${rebuiltDigest.selfLoopCount} archive=${archive.graphDigest.selfLoopCount}`);
  if (archive.exportPolicy.hideAmounts !== true) {
    record('weightMultiset',
      rebuiltDigest.weightMultisetFingerprint === archive.graphDigest.weightMultisetFingerprint,
      '边权多重集合指纹一致');
  }

  const detection = detectCommunities(graph, {
    resolution: archive.communityConfig.resolution,
    targetCommunities: archive.communityConfig.targetCommunities,
    seeds: archive.communityConfig.seeds,
  });
  const rebuiltNames = detection.chosenCommunities.map(entry => entry.members.join('|')).sort();
  const archiveNames = archive.communities.chosen.map(entry => entry.members.join('|')).sort();
  record('communityPartition', JSON.stringify(rebuiltNames) === JSON.stringify(archiveNames),
    `社群成员集合一致（${rebuiltNames.length} 群）`);
  record('stabilitySeeds',
    JSON.stringify(detection.seeds) === JSON.stringify(archive.communities.seeds),
    '种子集合一致');
  record('stabilityMatrix',
    JSON.stringify(detection.stability.pairwise) === JSON.stringify(archive.communities.stability.pairwise),
    '成对 ARI 稳定性矩阵逐位复现');

  const profile = computeBridgeProfile(
    graph, detection.chosenAssignment, detection.chosenCommunities);
  record('crossEdgeRecordIds',
    JSON.stringify(profile.crossEdges.map(edge => edge.recordIds).sort())
      === JSON.stringify(archive.bridgeProfile.crossEdges.map(edge => edge.recordIds).sort()),
    '跨社群边追溯到的原始记录 id 集合一致');
  record('topologicalBridges',
    profile.topologicalBridgeCount === archive.bridgeProfile.topologicalBridgeCount,
    `拓扑割边数 rebuilt=${profile.topologicalBridgeCount}`);

  if (archive.nullModel.valid) {
    const ensemble = generateNullEnsemble(graph, archive.nullConfig);
    record('nullEnsembleValidity', ensemble.allValid
      || ensemble.validCount >= archive.nullModel.minValidRealizations,
      `valid=${ensemble.validCount}/${ensemble.config.realizations}`);
    record('nullDiagnostics',
      JSON.stringify(ensemble.invalidReasons) === JSON.stringify(archive.nullModel.invalidReasons),
      '零模型无效原因分布一致');
  } else {
    record('nullModelMarkedInvalid', archive.nullModel.valid === false,
      `档案已正确标记零模型无效：${archive.nullModel.reason}`);
  }

  return {
    pass: checks.every(check => check.pass),
    checks,
    archiveFingerprint: archive.archiveFingerprint,
    recomputedFingerprint: fingerprint(records),
  };
}
