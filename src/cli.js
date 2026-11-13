import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { runAnalysis, recheckArchive } from './analysis.js';

const COMMANDS = ['summary', 'inspect', 'analyze', 'recheck'];
const OPTIONS = ['--input', '--out', '--policy', '--archive'];

export function parseArguments(args) {
  const [command = 'summary', ...tokens] = args;
  if (!COMMANDS.includes(command)) {
    throw new Error(`命令应为 ${COMMANDS.join('、')}`);
  }
  const result = { command, input: 'data/records.json' };
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!OPTIONS.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数应为 ${OPTIONS.join('、')} 路径 的成对形式`);
    }
    const key = name.slice(2);
    if (result[key] && name !== '--input') throw new Error('参数不可重复');
    result[key] = value;
  }
  if (command === 'recheck' && !result.archive) {
    throw new Error('recheck 需要 --archive 指向既有档案');
  }
  if (command === 'analyze' && !result.policy) {
    throw new Error('analyze 需要 --policy 指向分析配置');
  }
  return result;
}

async function loadPolicy(path) {
  const policy = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('分析配置必须是对象');
  }
  return policy;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);

  if (options.command === 'analyze') {
    const policy = await loadPolicy(options.policy);
    const archive = runAnalysis({
      records: dataset.records,
      inputFingerprint: dataset.fingerprint,
      policy,
    });
    if (options.out) await writeResult(options.out, archive);
    return archive;
  }

  if (options.command === 'recheck') {
    const archive = JSON.parse(await readFile(resolve(options.archive), 'utf8'));
    const report = recheckArchive({
      records: dataset.records,
      inputFingerprint: dataset.fingerprint,
      archive,
    });
    if (options.out) await writeResult(options.out, report);
    return report;
  }

  const result = options.command === 'summary' ? summarize(dataset.records)
    : { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
