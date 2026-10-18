import { collectSelected, configureCategories, checkAncestors, selected, fileBytes } from './categories.js';
// profile.js —— DSH Profile 定位、分类/旧版白名单收集、bundle 与备份写回。
// 只依赖 node 内置模块；GitHub 传输在 github.js；明文扫描在 secrets.js。
//
// 新配置使用 categories.js；无 categories 的旧配置继续使用原有白名单。

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 相对 profile 的必选白名单文件（顺序即推送顺序）。 */
export const CORE_FILES = Object.freeze(['cordis.patch.yml', 'package.json']);

/** 仅存在于远端的文件（不下写本地）。 */
export const REMOTE_EXTRA = Object.freeze(['manifest.json']);

/** 可选同步的单文件：sections 含 "install-policy" 时收集（评估者指出的第三持久化面：pnpm 安装策略）。 */
export const OPTIONAL_FILES = Object.freeze(['pnpm-workspace.yaml']);

/** 路径黑名单：任何阶段都不允许出现在收集/写回集合中（按段匹配，大小写不敏感）。 */
export const DENIED_SEGMENTS = Object.freeze([
  '.credentials.yaml',
  'node_modules',
  'sessions',
  'storages',
  '.plugin-manager',
  '.dsh-market',
  '.dsh-sync',
]);

/** profile 相关路径。DSH_HOME / DSH_PROFILE 环境变量可覆盖（自检用它们注入 fixture）。 */
export function profilePaths(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profileName = env.DSH_PROFILE || 'desktop';
  const profileDir = path.join(home, 'profiles', profileName);
  const dataDir = path.join(profileDir, '.dsh-sync');
  return Object.freeze({
    home,
    profileName,
    profileDir,
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    tokenFile: path.join(dataDir, 'token'),
    backupsDir: path.join(dataDir, 'backups'),
  });
}

/** 白名单/黑名单校验。返回标准化后的 POSIX 相对路径；不合法直接抛错。 */
export function assertSyncPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('非法路径:空字符串');
  const norm = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
  const segs = norm.split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..') throw new Error(`非法路径段:${rel}`);
    if (DENIED_SEGMENTS.includes(s.toLowerCase())) throw new Error(`禁区路径,拒绝同步:${rel}`);
  }
  if (CORE_FILES.includes(norm)) return norm;
  if (REMOTE_EXTRA.includes(norm)) return norm;
  if (OPTIONAL_FILES.includes(norm)) return norm;
  if (segs[0] === 'skills' && segs.length >= 2) return norm;
  throw new Error(`不在同步白名单(仅 cordis.patch.yml、package.json、pnpm-workspace.yaml、skills/**):${rel}`);
}

export function sha256Text(t) {
  return createHash('sha256').update(t, 'utf8').digest('hex');
}

/** 前缀规范化：去首尾斜杠、禁 '..' 与黑名单段。 */
export function normalizePrefix(prefix) {
  const p = String(prefix == null ? 'dsh-sync' : prefix).replace(/^\/+|\/+$/g, '');
  if (!p) throw new Error('remotePrefix 不能为空');
  for (const seg of p.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error(`非法 remotePrefix 段:${prefix}`);
    if (DENIED_SEGMENTS.includes(seg.toLowerCase())) throw new Error(`remotePrefix 命中禁区段:${prefix}`);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* 本地收集                                                            */
/* ------------------------------------------------------------------ */

async function listSkillFiles(p, { maxSkillBytes }) {
  const skillsDir = path.join(p.profileDir, 'skills');
  const dirents = await fs.readdir(skillsDir, { recursive: true, withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of dirents) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath || e.path || skillsDir, e.name);
    const rel = path.relative(p.profileDir, abs).replace(/\\/g, '/');
    let ok;
    try {
      ok = assertSyncPath(rel);
    } catch {
      continue; // 黑名单/白名单外的文件直接跳过,不收集
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st || st.size > maxSkillBytes) continue;
    out.push({ abs, rel: ok, size: st.size });
  }
  return out;
}

/**
 * 收集白名单文件的原文。CORE 两个文件缺失或 package.json 非法 JSON 时抛带诊断的错。
 * @returns {Promise<Array<{path: string, text: string}>>}
 */
export async function collectLocal({ p, sections = [], maxSkillBytes = 1_000_000, cfg } = {}) {
  if (Array.isArray(cfg?.categories)) return collectSelected(p, cfg);
  const files = [];
  for (const rel of CORE_FILES) {
    let text;
    try {
      text = await fs.readFile(path.join(p.profileDir, rel), 'utf8');
    } catch (e) {
      throw new Error(`本地缺少白名单文件 ${rel}(${e.code === 'ENOENT' ? '不存在' : e.message}),profile 目录:${p.profileDir}`);
    }
    if (rel === 'package.json') {
      try {
        JSON.parse(text);
      } catch (e) {
        throw new Error(`package.json 不是合法 JSON(拒绝同步):${e.message}`);
      }
    }
    files.push({ path: rel, text });
  }
  if (sections.includes('skills')) {
    for (const s of await listSkillFiles(p, { maxSkillBytes })) {
      // 读不到(刚被删/权限收紧)的技能文件跳过,不放大为整轮 push 失败:
      const text = await fs.readFile(s.abs, 'utf8').catch(() => null);
      if (text !== null) files.push({ path: s.rel, text });
    }
  }
  if (sections.includes('install-policy')) {
    for (const rel of OPTIONAL_FILES) {
      const text = await fs.readFile(path.join(p.profileDir, rel), 'utf8').catch(() => null);
      if (text !== null) files.push({ path: rel, text });
    }
  }
  return files;
}

/** 便于 pull 的镜像删除：列出本地 skills 下的白名单相对路径。 */
export async function listLocalSkillRels(p) {
  return (await listSkillFiles(p, { maxSkillBytes: 1_000_000 })).map((s) => s.rel);
}

/* ------------------------------------------------------------------ */
/* bundle / diff                                                       */
/* ------------------------------------------------------------------ */

/** 给收集到的文件加 sha256，附机器元数据。 */
export function buildBundle(rawFiles, { p }) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    host: { profile: p.profileName, platform: os.platform(), node: process.version, dshHome: p.home },
    files: rawFiles.map((f) => ({ path: f.path, text: f.text, ...(f.encoding ? { encoding: f.encoding } : {}), sha256: createHash('sha256').update(fileBytes(f)).digest('hex') })),
  };
}

/** 远端仓库里的 manifest.json 内容（审计与人工 diff 用，运行时不依赖它）。 */
export function manifestFrom(bundle) {
  // 安装清单快照：dependencies + bundles 就是新机器"要装哪些包/启用哪些包"的 checklist；
  // localPathDeps 列出指向原机器本地路径的 file:/link: 依赖（新机需手工重建）。
  let installList = null;
  const pkgFile = (bundle.files || []).find((f) => f.path === 'package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.text);
      installList = {
        dependencies: pkg?.dependencies || {},
        bundles: pkg?.dsh?.profile?.bundles || [],
        localPathDeps: Object.entries(pkg?.dependencies || {})
          .filter(([, spec]) => /^(file|link):/i.test(String(spec)))
          .map(([name]) => name),
      };
    } catch {
      installList = null;
    }
  }
  return {
    version: 1,
    plugin: 'dsh-sync 0.2.2',
    generatedAt: bundle.generatedAt,
    host: bundle.host,
    files: bundle.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: fileBytes(f).length, ...(f.encoding ? { encoding: f.encoding } : {}) })),
    installList,
  };
}

/** 逐文件比对两份 sha 映射。state: same | changed | only-local | only-remote */
export function diffMaps(localMap, remoteMap) {
  const all = new Set([...Object.keys(localMap || {}), ...Object.keys(remoteMap || {})]);
  const states = [];
  for (const p of [...all].sort()) {
    const l = localMap[p];
    const r = remoteMap[p];
    states.push({ path: p, state: l && r ? (l === r ? 'same' : 'changed') : l ? 'only-local' : 'only-remote' });
  }
  return states;
}

/* ------------------------------------------------------------------ */
/* 备份与写回                                                          */
/* ------------------------------------------------------------------ */

/** 原子写：temp 文件 + rename。 */
export async function atomicWriteText(absPath, text) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${randomUUID()}.dshsync-tmp`;
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, absPath);
  } finally { await fs.rm(tmp, { force: true }); }
}

/**
 * 在覆盖前把每个将被改动的本地文件复制到 backups/<时间戳>/<原相对路径>，
 * 复制后逐字节核对（sha256 不一致即抛错,pull_backup_rollback 的落点）。
 * 备份目录创建失败时直接抛错，调用方须中止覆盖。
 */
export async function backupExisting(p, rels, nowIso = new Date().toISOString()) {
  const ts = nowIso.replace(/[:.]/g, '-');
  const backupDir = path.join(p.backupsDir, ts);
  await fs.mkdir(backupDir, { recursive: true });
  const backed = [];
  for (const rel of rels) {
    const src = path.join(p.profileDir, rel);
    const text = await fs.readFile(src).catch(() => null); // 本来就不存在的文件无需备份
    if (text === null) continue;
    const dst = path.join(backupDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, text, { encoding: 'utf8', mode: 0o600 });
    const roundtrip = await fs.readFile(dst);
    if (!roundtrip.equals(text)) throw new Error(`备份核对不一致,中止覆盖:${rel}`);
    backed.push({ path: rel, backupPath: dst });
  }
  return { backupDir, backed };
}

/**
 * 备份保留提示(体验项,绝不自动删除):backups/ 下时间戳目录超过 threshold 份时返回一句
 * 人工清理提示,否则返回 null。目录不存在(从未实写 pull)或读不了时静默返回 null。
 * @param {object} p profilePaths(用到 backupsDir)
 * @param {number} [threshold=20] 份数阈值
 * @returns {Promise<string|null>}
 */
export async function backupRetentionNote(p, threshold = 20) {
  try {
    const entries = await fs.readdir(p.backupsDir, { withFileTypes: true });
    const n = entries.filter((e) => e.isDirectory()).length;
    if (n <= threshold) return null;
    return `profile/.dsh-sync/backups/ 已累积 ${n} 份备份(提示阈值 ${threshold});插件从不自动删除备份,回滚确认无需保留后可手工清理较旧的时间戳目录。`;
  } catch {
    return null;
  }
}

/**
 * 两个同步开关的一行可读描述(供 sync_status 等回执使用),on/off 形式。
 * @param {Record<string, any>|null} cfg 配置对象(可为 null)
 * @returns {string}
 */
export function describeSwitches(cfg) {
  const on = (v) => (v === true ? 'on' : 'off');
  return `includeSecrets=${on(cfg && cfg.includeSecrets)} / mirrorDeletes=${on(cfg && cfg.mirrorDeletes)}`;
}

/**
 * 把远端内容应用到本地。所有写入前先完成全部备份。
 * @param {Array<{path: string, text: string}>} incoming 已下载的远端文件（相对前缀路径）
 * @param {object} o { mirrorDelete, localSkillRels, dryRun, nowIso }
 */
export async function applyIncoming(p, incoming, { mirrorDelete = false, localSkillRels = [], dryRun = false, nowIso, cfg } = {}) {
  const writes = [];
  const adds = [];
  for (const f of incoming) {
    const rel = Array.isArray(cfg?.categories) ? (selected(f.path, cfg) ? f.path : null) : assertSyncPath(f.path);
    if (!rel) continue;
    await checkAncestors(p.profileDir, rel); // 白名单/黑名单校验,越界直接抛
    const exists = await fs
      .access(path.join(p.profileDir, rel))
      .then(() => true)
      .catch(() => false);
    (exists ? writes : adds).push({ rel, text: f.encoding === 'base64' ? fileBytes(f) : f.text });
  }
  const deletes = [];
  if (mirrorDelete) {
    for (const rel of localSkillRels) {
      if (!incoming.some((f) => f.path === rel)) deletes.push(rel);
    }
  }
  if (dryRun) {
    return {
      dryRun: true,
      toWrite: writes.map((w) => w.rel),
      toAdd: adds.map((a) => a.rel),
      toDelete: deletes,
      backupDir: null,
    };
  }
  for (const rel of deletes) await checkAncestors(p.profileDir, rel);
  const needBackup = [...writes.map((w) => w.rel), ...deletes];
  const backup = needBackup.length > 0 ? await backupExisting(p, needBackup, nowIso) : { backupDir: null, backed: [] };
  for (const w of writes) { await checkAncestors(p.profileDir, w.rel); await atomicWriteText(path.join(p.profileDir, w.rel), w.text); }
  for (const a of adds) { await checkAncestors(p.profileDir, a.rel); await atomicWriteText(path.join(p.profileDir, a.rel), a.text); }
  for (const rel of deletes) await fs.rm(path.join(p.profileDir, rel), { force: true });
  const retentionNote = backup.backupDir ? await backupRetentionNote(p) : null;
  return {
    dryRun: false,
    backupDir: backup.backupDir,
    retentionNote,
    backed: backup.backed,
    written: [...writes, ...adds].map((w) => ({ path: w.rel, backedUp: needBackup.includes(w.rel) })),
    deleted: deletes,
  };
}

/* ------------------------------------------------------------------ */
/* 本机配置与令牌（token 绝不进 config.json,更不进同步集）              */
/* ------------------------------------------------------------------ */

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** git ref 分支名校验:挡下 GitHub 会拒绝的形态(`..`、`.lock` 结尾、非法字符),让错误发生在保存配置时,而不是 POST /git/refs 时。 */
export function validBranch(branch) {
  return typeof branch === 'string' && BRANCH_RE.test(branch) && !branch.includes('..') && !branch.endsWith('.lock');
}

const TOKENREF_RE = /^(env|file):(.+)$/;

/** tokenRef 引用校验:必须以 env:VAR 或 file:PATH 形式给出,指向令牌本体的存放处(本体不进配置)。 */
export function validTokenRef(ref) {
  if (typeof ref !== 'string') return false;
  const m = TOKENREF_RE.exec(ref);
  return m != null && m[2].trim().length > 0;
}

/**
 * 把 tokenRef 引用解析成令牌本体:env:NAME 读环境变量;file:PATH 读文本文件(一行,trim)。
 * 即用即取——本体绝不落盘、不进配置、不进任何回执;解析不出返回 null(变量未设/文件缺失)。
 */
export async function resolveTokenRef(ref, env = process.env) {
  if (!validTokenRef(ref)) return null;
  const m = TOKENREF_RE.exec(ref);
  if (m[1] === 'env') {
    const v = env[m[2].trim()];
    return typeof v === 'string' && v.trim() ? v : null;
  }
  try {
    const v = (await fs.readFile(m[2].trim(), 'utf8')).trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 把一次 sync_config 的参数合并进既有配置(原地修改并返回)。仅当参数为真值时覆盖;
 * includeSecrets / mirrorDeletes 只有显式传 boolean 才翻位,省略则保留既有值(缺省与 false 等价)。
 * @param {Record<string, any>} cfg 既有配置对象(可为 {})
 * @param {Record<string, any>} args sync_config 参数
 * @returns {Record<string, any>} 同一个 cfg
 */
export function mergeConfigArgs(cfg, args) {
  const a = args || {};
  if (a.categories !== undefined) configureCategories(cfg, a);
  cfg.repo = String(a.repo);
  cfg.branch = typeof a.branch === 'string' && a.branch ? a.branch : cfg.branch || 'main';
  if (typeof a.remotePrefix === 'string' && a.remotePrefix) cfg.remotePrefix = a.remotePrefix;
  else if (!cfg.remotePrefix) cfg.remotePrefix = 'dsh-sync';
  cfg.sections = Array.isArray(a.sections) && a.sections.length > 0 ? a.sections.map(String) : cfg.sections || ['core'];
  if (typeof a.includeSecrets === 'boolean') cfg.includeSecrets = a.includeSecrets;
  else cfg.includeSecrets = cfg.includeSecrets === true;
  if (typeof a.mirrorDeletes === 'boolean') cfg.mirrorDeletes = a.mirrorDeletes;
  else cfg.mirrorDeletes = cfg.mirrorDeletes === true;
  if (a.tokenRef != null) {
    if (typeof a.tokenRef !== 'string' || !a.tokenRef.trim()) {
      throw new Error(`tokenRef 必须为 "env:变量名" 或 "file:路径",收到:${JSON.stringify(a.tokenRef)}`);
    }
    if (!validTokenRef(a.tokenRef)) {
      throw new Error('tokenRef 必须以 env: 或 file: 开头(如 "env:DSH_SYNC_TOKEN" 或 "file:C:\\path\\pat.txt"),推荐用引用把令牌本体挡在对话之外,收到:' + JSON.stringify(a.tokenRef));
    }
    cfg.tokenRef = a.tokenRef.trim();
  }
  return cfg;
}

export async function readConfig(p) {
  try {
    return JSON.parse(await fs.readFile(p.configFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveConfig(p, cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('配置为空');
  if (!REPO_RE.test(cfg.repo || '')) throw new Error(`repo 必须形如 owner/name,收到:${JSON.stringify(cfg.repo)}`);
  if (typeof cfg.branch !== 'string' || !cfg.branch) cfg.branch = 'main';
  else if (!validBranch(cfg.branch)) throw new Error(`branch 不是合法的 git 分支名(GitHub 会直接拒绝):${JSON.stringify(cfg.branch)}`);
  cfg.remotePrefix = normalizePrefix(cfg.remotePrefix);
  if (cfg.tokenRef != null && !validTokenRef(cfg.tokenRef)) {
    throw new Error(`tokenRef 必须为 "env:变量名" 或 "file:路径",收到:${JSON.stringify(cfg.tokenRef)}`);
  }
  await fs.mkdir(p.dataDir, { recursive: true, mode: 0o700 });
  await atomicWriteText(p.configFile, JSON.stringify(cfg, null, 2));
}

export async function saveToken(p, token) {
  if (typeof token !== 'string' || token.trim().length < 10) throw new Error('token 看起来不像有效令牌(太短)');
  await fs.mkdir(p.dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(p.tokenFile, token, { encoding: 'utf8', mode: 0o600 });
}

/** 令牌读取顺序:DSH_SYNC_TOKEN > GITHUB_TOKEN > config.tokenRef(env:/file: 引用,即用即取)> 本机 token 文件。 */
export async function readToken(p, env = process.env) {
  if (env.DSH_SYNC_TOKEN) return env.DSH_SYNC_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const cfg = await readConfig(p);
  if (cfg && typeof cfg.tokenRef === 'string') {
    const viaRef = await resolveTokenRef(cfg.tokenRef, env);
    if (viaRef) return viaRef;
  }
  try {
    const t = (await fs.readFile(p.tokenFile, 'utf8')).trim();
    return t || null;
  } catch {
    return null;
  }
}

export async function eraseAll(p) {
  await fs.rm(p.configFile, { force: true });
  await fs.rm(p.tokenFile, { force: true });
}
