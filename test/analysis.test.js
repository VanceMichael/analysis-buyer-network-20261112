import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../src/dataset.js';
import { runAnalysis, recheckArchive } from '../src/analysis.js';
import { writeResult } from '../src/output.js';

let counter = 0;
function row(left, right, amount = 10, period = 1, relation = 'supply') {
  counter += 1;
  return { left, right, amount, period, relation, id: `a${String(counter).padStart(4, '0')}` };
}

function twoCliqueRecords() {
  const records = [];
  const A = ['a1', 'a2', 'a3', 'a4'];
  const B = ['b1', 'b2', 'b3', 'b4'];
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) records.push(row(A[i], A[j]));
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) records.push(row(B[i], B[j]));
  records.push(row('a4', 'b1', 5));
  return records;
}

const basePolicy = {
  resolution: 1, seeds: [11, 23, 37], hideAmounts: false,
  nullRealizations: 40, swapMultiplier: 10, maxAttemptsPerSwap: 1000,
};

test('档案包含图口径、种子、稳定性与零模型诊断，且带档案指纹', () => {
  const records = twoCliqueRecords();
  const archive = runAnalysis({ records, inputFingerprint: fingerprint(records), policy: basePolicy });
  assert.equal(archive.archiveVersion, 1);
  assert.ok(archive.archiveFingerprint.length === 64);
  assert.equal(archive.communityConfig.seeds.length, 3);
  assert.ok('pairwise' in archive.communities.stability);
  assert.ok('degreeSequence' in archive.nullConfig);
  assert.equal(archive.nullModel.config.weightPolicy, 'reshuffle');
  assert.ok(archive.nullModel.valid);
  assert.equal(archive.graphConfig.parallelPolicy, 'sum');
});

test('复查：同网络同口径重新读取档案，所有检查通过', () => {
  const records = twoCliqueRecords();
  const fp = fingerprint(records);
  const archive = runAnalysis({ records, inputFingerprint: fp, policy: basePolicy });
  const report = recheckArchive({ records, inputFingerprint: fp, archive });
  assert.equal(report.pass, true, report.checks.filter(c => !c.pass).map(c => c.name).join(','));
  assert.ok(report.checks.some(c => c.name === 'stabilityMatrix' && c.pass));
  assert.ok(report.checks.some(c => c.name === 'crossEdgeRecordIds' && c.pass));
});

test('复查失败：输入指纹不一致时被明确标记', () => {
  const records = twoCliqueRecords();
  const archive = runAnalysis({ records, inputFingerprint: fingerprint(records), policy: basePolicy });
  const report = recheckArchive({ records, inputFingerprint: 'deadbeef', archive });
  assert.equal(report.pass, false);
  assert.equal(report.checks.find(c => c.name === 'inputFingerprint').pass, false);
});

test('hideAmounts：导出中不含任何单边金额或权重，但记录 id 可追溯性保留', () => {
  const records = twoCliqueRecords();
  const hidden = runAnalysis({
    records, inputFingerprint: fingerprint(records),
    policy: { ...basePolicy, hideAmounts: true },
  });
  assert.equal(hidden.exportPolicy.hideAmounts, true);
  const serialized = JSON.stringify(hidden);
  for (const forbidden of ['mergedRawAmount', '"weight"', 'rawAmount', 'crossCommunityWeight', 'strength']) {
    assert.equal(serialized.includes(forbidden), false, `导出仍含脱敏字段：${forbidden}`);
  }
  assert.ok(hidden.bridgeProfile.crossEdges.every(e => Array.isArray(e.recordIds) && e.recordIds.length > 0));
  assert.equal(hidden.graphDigest.totalWeight, null);
});

test('非隐藏导出保留单边金额与权重', () => {
  const records = twoCliqueRecords();
  const visible = runAnalysis({
    records, inputFingerprint: fingerprint(records),
    policy: { ...basePolicy, hideAmounts: false },
  });
  assert.equal(visible.exportPolicy.hideAmounts, false);
  assert.ok(visible.bridgeProfile.crossEdges[0].mergedRawAmount === 5);
  assert.ok(typeof visible.bridgeProfile.crossEdges[0].weight === 'number');
});

test('分析过程不改原始记录', () => {
  const records = twoCliqueRecords();
  const snapshot = JSON.stringify(records);
  runAnalysis({ records, inputFingerprint: fingerprint(records), policy: basePolicy });
  assert.equal(JSON.stringify(records), snapshot);
});

test('零模型无效时档案如实标记，复查确认无效标记，绝不冒充显著', () => {
  // 星形图无可行保度交换。
  const records = [];
  for (const leaf of ['l1', 'l2', 'l3', 'l4']) records.push(row('hub', leaf));
  const archive = runAnalysis({
    records, inputFingerprint: fingerprint(records),
    policy: { ...basePolicy, nullRealizations: 15, swapMultiplier: 5, maxAttemptsPerSwap: 100 },
  });
  assert.equal(archive.nullModel.valid, false);
  assert.ok(archive.nullModel.reason.length > 0);
  assert.equal(archive.nullModel.nodeTests.length, 0);
  assert.equal(archive.nullModel.globalTests, null);
  const report = recheckArchive({
    records, inputFingerprint: fingerprint(records), archive,
  });
  assert.ok(report.checks.find(c => c.name === 'nullModelMarkedInvalid').pass);
});

test('档案可原子写入并重新读取复查', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'archive-'));
  try {
    const records = twoCliqueRecords();
    const fp = fingerprint(records);
    const archive = runAnalysis({ records, inputFingerprint: fp, policy: basePolicy });
    const path = join(folder, 'nested', 'archive.json');
    await writeResult(path, archive);
    const reread = JSON.parse(await readFile(path, 'utf8'));
    const report = recheckArchive({ records, inputFingerprint: fp, archive: reread });
    assert.equal(report.pass, true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('确定性：同输入同配置两次运行档案指纹一致', () => {
  const records = twoCliqueRecords();
  const fp = fingerprint(records);
  const a1 = runAnalysis({ records, inputFingerprint: fp, policy: basePolicy });
  const a2 = runAnalysis({ records, inputFingerprint: fp, policy: { ...basePolicy } });
  assert.equal(a1.archiveFingerprint, a2.archiveFingerprint);
});
