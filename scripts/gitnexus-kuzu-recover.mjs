#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

function parseArgs(argv) {
  const args = { force: false, embeddings: false, repoPath: null };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') {
      args.force = true;
      continue;
    }
    if (arg === '--embeddings') {
      args.embeddings = true;
      continue;
    }
    if (!arg.startsWith('-') && !args.repoPath) {
      args.repoPath = path.resolve(arg);
    }
  }
  return args;
}

function getGitnexusPackageRoot() {
  const gitnexusBin = execFileSync('which', ['gitnexus'], { encoding: 'utf8' }).trim();
  const realBin = execFileSync('python3', ['-c', 'import os,sys; print(os.path.realpath(sys.argv[1]))', gitnexusBin], {
    encoding: 'utf8',
  }).trim();

  if (!realBin.endsWith('/dist/cli/index.js')) {
    throw new Error(`无法定位 GitNexus 包目录: ${realBin}`);
  }

  return path.resolve(realBin, '../../..');
}

async function importFrom(packageRoot, relativePath) {
  const target = pathToFileURL(path.join(packageRoot, relativePath)).href;
  return import(target);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageRoot = getGitnexusPackageRoot();

  const [
    pipelineMod,
    kuzuMod,
    repoManagerMod,
    gitMod,
  ] = await Promise.all([
    importFrom(packageRoot, 'dist/core/ingestion/pipeline.js'),
    importFrom(packageRoot, 'dist/core/kuzu/kuzu-adapter.js'),
    importFrom(packageRoot, 'dist/storage/repo-manager.js'),
    importFrom(packageRoot, 'dist/storage/git.js'),
  ]);

  const repoPath = args.repoPath || gitMod.getGitRoot(process.cwd());
  if (!repoPath || !gitMod.isGitRepo(repoPath)) {
    throw new Error('当前目录不是 Git 仓库，且未提供有效路径。');
  }

  const { storagePath, kuzuPath } = repoManagerMod.getStoragePaths(repoPath);
  const currentCommit = gitMod.getCurrentCommit(repoPath);
  const existingMeta = await repoManagerMod.loadMeta(storagePath);
  const hasKuzu = await fileExists(kuzuPath);

  if (existingMeta && existingMeta.lastCommit === currentCommit && hasKuzu && !args.force) {
    console.log('GitNexus 已可用，未检测到缺失的 .gitnexus/kuzu。');
    return;
  }

  console.log('');
  console.log('GitNexus Kuzu Recovery');
  console.log(`Repo: ${repoPath}`);
  console.log(`GitNexus: ${packageRoot}`);
  console.log(`Mode: full rebuild${args.embeddings ? ' + embeddings' : ''}`);

  await kuzuMod.closeKuzu().catch(() => {});
  for (const target of [kuzuPath, `${kuzuPath}.wal`, `${kuzuPath}.lock`]) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }

  const pipelineResult = await pipelineMod.runPipelineFromRepo(repoPath, progress => {
    const percent = String(Math.round(progress.percent)).padStart(3, ' ');
    console.log(`[pipeline ${percent}%] ${progress.phase}`);
  });

  await kuzuMod.initKuzu(kuzuPath);

  await kuzuMod.loadGraphToKuzu(
    pipelineResult.graph,
    pipelineResult.repoPath,
    storagePath,
    message => console.log(`[kuzu] ${message}`)
  );

  for (const [tableName, indexName, properties] of [
    ['File', 'file_fts', ['name', 'content']],
    ['Function', 'function_fts', ['name', 'content']],
    ['Class', 'class_fts', ['name', 'content']],
    ['Method', 'method_fts', ['name', 'content']],
    ['Interface', 'interface_fts', ['name', 'content']],
  ]) {
    try {
      await kuzuMod.createFTSIndex(tableName, indexName, properties);
    } catch (error) {
      console.warn(`[fts] ${tableName} 索引创建失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let embeddingCount = 0;
  if (args.embeddings) {
    const { runEmbeddingPipeline } = await importFrom(packageRoot, 'dist/core/embeddings/embedding-pipeline.js');
    await runEmbeddingPipeline(
      kuzuMod.executeQuery,
      kuzuMod.executeWithReusedStatement,
      progress => {
        if (progress.phase === 'loading-model') {
          console.log('[embed] loading model');
          return;
        }
        console.log(`[embed] ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`);
      }
    );
    try {
      const rows = await kuzuMod.executeQuery('MATCH (e:CodeEmbedding) RETURN count(e) AS cnt');
      embeddingCount = Number(rows?.[0]?.cnt ?? 0);
    } catch {
      embeddingCount = 0;
    }
  }

  const stats = await kuzuMod.getKuzuStats();
  const meta = {
    repoPath,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    stats: {
      files: pipelineResult.totalFileCount,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities ?? 0,
      processes: pipelineResult.processResult?.stats.totalProcesses ?? 0,
      embeddings: embeddingCount,
    },
  };

  await repoManagerMod.saveMeta(storagePath, meta);
  await repoManagerMod.registerRepo(repoPath, meta);
  await repoManagerMod.addToGitignore(repoPath);

  const persisted = await fileExists(kuzuPath);
  if (!persisted) {
    throw new Error(`恢复流程结束后仍未发现 ${kuzuPath}`);
  }

  console.log('');
  console.log('Recovery finished.');
  console.log(`Kuzu: ${kuzuPath}`);
  console.log(
    `Stats: ${stats.nodes} nodes | ${stats.edges} edges | ${meta.stats.communities} communities | ${meta.stats.processes} processes`
  );
  console.log('');

  // 不显式 closeKuzu。当前环境下 close/exit 阶段会触发原生崩溃并导致 kuzu 文件丢失。
  process.exit(0);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
