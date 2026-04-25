#!/usr/bin/env node

import { execFileSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

function parseArgs(argv) {
  const parsed = {
    repo: undefined,
    scope: 'unstaged',
    base_ref: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      parsed.repo = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--scope' && argv[i + 1]) {
      parsed.scope = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--base-ref' && argv[i + 1]) {
      parsed.base_ref = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
  }

  return parsed;
}

function resolveGitnexusPackageRoot() {
  const gitnexusBin = execFileSync('which', ['gitnexus'], { encoding: 'utf8' }).trim();
  const realBin = execFileSync(
    'python3',
    ['-c', 'import os,sys; print(os.path.realpath(sys.argv[1]))', gitnexusBin],
    { encoding: 'utf8' }
  ).trim();

  if (!realBin.endsWith('/dist/cli/index.js')) {
    throw new Error(`无法定位 GitNexus 安装目录: ${realBin}`);
  }

  return path.resolve(realBin, '../../..');
}

function resolveCurrentRepoPath() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
}

async function importFrom(packageRoot, relativePath) {
  return import(pathToFileURL(path.join(packageRoot, relativePath)).href);
}

function printHelp() {
  console.log(`用法:
  node scripts/gitnexus-detect-changes.mjs [--repo <repo>] [--scope <unstaged|staged|all|compare>] [--base-ref <ref>]

示例:
  node scripts/gitnexus-detect-changes.mjs
  node scripts/gitnexus-detect-changes.mjs --scope staged
  node scripts/gitnexus-detect-changes.mjs --scope compare --base-ref main
  npm run gitnexus:detect-changes -- --scope unstaged
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const packageRoot = resolveGitnexusPackageRoot();
  const { LocalBackend } = await importFrom(packageRoot, 'dist/mcp/local/local-backend.js');

  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    throw new Error('没有可用的 GitNexus 索引，请先运行 analyze / recover。');
  }

  const inferredRepo = args.repo || resolveCurrentRepoPath();
  const result = await backend.callTool('detect_changes', {
    repo: inferredRepo,
    scope: args.scope,
    ...(args.base_ref ? { base_ref: args.base_ref } : {}),
  });

  console.log(JSON.stringify(result, null, 2));

  if (typeof backend.dispose === 'function') {
    await backend.dispose().catch(() => {});
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
