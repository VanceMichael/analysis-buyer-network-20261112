import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArguments } from '../src/cli.js';

function run(args) {
  return spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
}

test('parseArguments 识别 analyze/recheck 并强制必需参数', () => {
  assert.equal(parseArguments(['analyze', '--policy', 'p.json']).command, 'analyze');
  assert.equal(parseArguments(['recheck', '--archive', 'a.json']).command, 'recheck');
  assert.throws(() => parseArguments(['analyze']), /policy/);
  assert.throws(() => parseArguments(['recheck']), /archive/);
  assert.throws(() => parseArguments(['frobnicate']), /命令/);
  assert.throws(() => parseArguments(['analyze', '--policy']), /参数/);
});

test('analyze 端到端：生成档案、落盘，recheck 读取后全部通过', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-analyze-'));
  try {
    const policy = {
      resolution: 1, seeds: [11, 23], hideAmounts: true,
      nullRealizations: 20, swapMultiplier: 8, maxAttemptsPerSwap: 500,
      nodes: ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6',
        'n7', 'n8', 'n9', 'n10', 'n11', 'n12'],
    };
    const policyPath = join(folder, 'policy.json');
    const archivePath = join(folder, 'archive.json');
    const recheckPath = join(folder, 'recheck.json');
    await writeFile(policyPath, JSON.stringify(policy));

    const analyzed = run(['analyze', '--input', 'data/records.json',
      '--policy', policyPath, '--out', archivePath]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const archive = JSON.parse(await readFile(archivePath, 'utf8'));
    assert.equal(archive.exportPolicy.hideAmounts, true);
    assert.ok(archive.nullModel.config.realizations === 20);

    const rechecked = run(['recheck', '--input', 'data/records.json',
      '--archive', archivePath, '--out', recheckPath]);
    assert.equal(rechecked.status, 0, rechecked.stderr);
    const report = JSON.parse(await readFile(recheckPath, 'utf8'));
    assert.equal(report.pass, true);
    assert.ok(report.checks.length >= 10);

    // 控制台输出与落盘内容一致。
    assert.deepEqual(JSON.parse(rechecked.stdout), report);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('analyze 隐藏金额：落盘档案不含单边金额字段', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-hidden-'));
  try {
    const policyPath = join(folder, 'policy.json');
    const archivePath = join(folder, 'archive.json');
    await writeFile(policyPath, JSON.stringify({
      resolution: 1, seeds: [11], hideAmounts: true, nullRealizations: 10,
    }));
    const result = run(['analyze', '--input', 'data/records.json',
      '--policy', policyPath, '--out', archivePath]);
    assert.equal(result.status, 0, result.stderr);
    const serialized = await readFile(archivePath, 'utf8');
    for (const forbidden of ['mergedRawAmount', 'rawAmount', 'crossCommunityWeight']) {
      assert.equal(serialized.includes(forbidden), false, `泄漏字段：${forbidden}`);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('错误输入返回非零退出码且不产出档案', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-err-'));
  try {
    const badInput = join(folder, 'bad.json');
    const policyPath = join(folder, 'policy.json');
    const outPath = join(folder, 'out.json');
    await writeFile(badInput, JSON.stringify({ version: 2, records: [] }));
    await writeFile(policyPath, JSON.stringify({ resolution: 1, seeds: [11] }));
    const result = run(['analyze', '--input', badInput, '--policy', policyPath, '--out', outPath]);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(outPath));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
