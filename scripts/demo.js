import { readFile } from 'node:fs/promises';
import { main } from '../src/cli.js';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有领域核算');
console.log(JSON.stringify(await main(['summary', '--out', 'var/summary.json']), null, 2));
console.log('业务配置');
const policy = JSON.parse(await readFile('data/policy.json', 'utf8'));
console.log(JSON.stringify(policy, null, 2));

console.log('\n关系网络分析（社群、跨社群桥贡献、保度零模型检验）');
const archive = await main([
  'analyze', '--input', 'data/records.json',
  '--policy', 'data/policy.json', '--out', 'var/network-archive.json',
]);
console.log('社群（稳定命名，孤立点独立成群）:');
for (const community of archive.communities.chosen) {
  console.log(`  ${community.community} (${community.size}${community.isIsolateCommunity ? ', 孤立' : ''}): ${community.members.join(', ')}`);
}
console.log('分区稳定性（多种子成对 ARI）:', JSON.stringify(archive.communities.stability.pairwise));
console.log('跨社群边（可追溯原始记录 id）:');
for (const edge of archive.bridgeProfile.crossEdges.slice(0, 5)) {
  console.log(`  ${edge.endpoints.join('-')} ${edge.communities.join('/')} records=[${edge.recordIds.join(',')}] 拓扑桥=${edge.topologicalBridge}`);
}
console.log('保度零模型:', archive.nullModel.valid
  ? `有效 ${archive.nullModel.validCount}/${archive.nullModel.config.realizations}，权重策略=${archive.nullConfig.weightPolicy}`
  : `无效（${archive.nullModel.reason}），不充当零模型`);

console.log('\n档案复查');
const recheck = await main([
  'recheck', '--input', 'data/records.json',
  '--archive', 'var/network-archive.json', '--out', 'var/recheck.json',
]);
console.log(`复查结论：${recheck.pass ? '全部通过' : '存在不一致'}（${recheck.checks.length} 项检查）`);
for (const check of recheck.checks) {
  console.log(`  ${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
}
console.log(`\n完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
