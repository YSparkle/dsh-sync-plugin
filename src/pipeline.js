import { selected, categoryOf, fileBytes, checkAncestors } from './categories.js';
// pipeline.js —— push/pull 的共享编排：tools.js 的 execute 与 selfcheck 的
// 端到端联调都走这里，保证"测试过的就是工具跑的"。
// 顺序即守卫（design.md ③④）：收集 → 明文扫描（命中即停,不发任何请求）
// → 与远端比对 → 单 commit（push）/ 备份后原子覆盖（pull）。
import * as os from 'node:os';
import * as prof from './profile.js';
import { scanBundle } from './secrets.js';

const PLUGIN_VERSION = 'dsh-sync 0.2.2';

/**
 * 以本地为准推送。返回 {ok, stage, ...}；secret-scan 拒绝时 ok=false 且
 * 未发出任何网络请求（调用方可通过 client 的请求日志验证）。
 */
export async function performPush({ p, cfg, client, message }) {
  const raw = await prof.collectLocal({ p, sections: cfg?.sections || [], cfg });
  if (Array.isArray(cfg?.categories) && raw.length === 0) return { ok: false, stage: 'empty-selection', detail: '选中类别没有可同步的文件，请在设置中选择内容。' };
  const token = await prof.readToken(p);
  if (token && raw.some(f => fileBytes(f).includes(Buffer.from(token)))) throw new Error('选中内容包含当前 GitHub 同步令牌，请先移出同步文件。');
  const bundle = prof.buildBundle(raw, { p });
  const scan = scanBundle(bundle, { includeSecrets: cfg?.includeSecrets === true });
  if (Array.isArray(cfg?.categories) && !cfg.includeSecrets) {
    const approvedHits = scan.hits.filter(h => cfg.confirmedSensitive?.includes(categoryOf(h.file)));
    scan.warnings.push(...approvedHits.map(h => `${h.file}:${h.line} ${h.label}`));
    scan.hits = scan.hits.filter(h => !cfg.confirmedSensitive?.includes(categoryOf(h.file)));
    scan.rejected = scan.hits.length > 0;
  }
  if (scan.rejected) {
    return { ok: false, stage: 'secret-scan', scanned: bundle.files.length, hits: scan.hits };
  }
  const prefix = prof.normalizePrefix(cfg.remotePrefix);
  const remote = await client.listPrefix({ prefix });
  const deletions = [];
  if (cfg?.mirrorDeletes === true && !remote.emptyRepo) {
    const localSet = new Set(bundle.files.map((f) => f.path));
    for (const rf of remote.files) {
      if (rf.rel !== 'manifest.json' && rf.rel.startsWith('skills/') && !localSet.has(rf.rel) && (!Array.isArray(cfg.categories) || selected(rf.rel, cfg))) deletions.push(rf.rel);
    }
  }
  const manifest = Object.assign(prof.manifestFrom(bundle), {
    branch: cfg?.branch || 'main',
    remotePrefix: prefix,
    pushedVia: PLUGIN_VERSION,
  });
  const payload = [
    ...bundle.files.map((f) => ({ path: f.path, text: f.text, ...(f.encoding ? { encoding: f.encoding } : {}) })),
    { path: 'manifest.json', text: JSON.stringify(manifest, null, 2) },
  ];
  const res = await client.putFiles({
    prefix,
    files: payload,
    deletions,
    message: message || `dsh-sync: push ${p.profileName} @ ${os.hostname()} ${bundle.generatedAt}`,
  });
  return {
    ok: true,
    stage: 'pushed',
    scanned: bundle.files.length,
    commitUrl: res.commitUrl,
    commitSha: res.commitSha,
    pushed: payload.map((f) => ({ path: f.path, op: 'upsert' })),
    deletions,
    warnings: scan.warnings,
  };
}

/** 以远端为准拉取。返回 {ok, dryRun, toWrite/toAdd/toDelete 或 applied/backupDir}。 */
export async function performPull({ p, cfg, client, dryRun = false }) {
  const prefix = prof.normalizePrefix(cfg?.remotePrefix || 'dsh-sync');
  const remote = await client.listPrefix({ prefix });
  if (remote.emptyRepo) {
    return { ok: false, stage: 'remote-empty', dryRun };
  }
  const entries = remote.files.filter(f => f.rel !== 'manifest.json' && (!Array.isArray(cfg.categories) || selected(f.rel, cfg)));
  for (const f of entries) {
    if (!Array.isArray(cfg.categories)) prof.assertSyncPath(f.rel);
    await checkAncestors(p.profileDir, f.rel);
  }
  const files = await client.getFiles(entries);
  for (const f of files) if (!Array.isArray(cfg.categories)) prof.assertSyncPath(f.path); // 写盘前白名单校验
  const report = await prof.applyIncoming(p, files, {
    cfg,
    mirrorDelete: cfg?.mirrorDeletes === true,
    localSkillRels: (await prof.listLocalSkillRels(p)).filter(rel => !Array.isArray(cfg.categories) || selected(rel, cfg)),
    dryRun,
  });
  return { ok: true, stage: dryRun ? 'dry-run' : 'applied', ...report };
}
