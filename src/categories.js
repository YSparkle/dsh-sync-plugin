import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CATEGORIES = Object.freeze([
  { id: 'core', label: '模型、插件与界面设置', sensitive: false },
  { id: 'skills', label: '技能', sensitive: false },
  { id: 'install-policy', label: '安装策略与依赖清单', sensitive: false },
  { id: 'credentials', label: 'API Key / 登录凭证', sensitive: true },
  { id: 'sessions', label: '聊天记录', sensitive: true },
  { id: 'storages', label: '插件数据', sensitive: true },
  { id: 'packages', label: '插件程序与缓存', sensitive: true },
  { id: 'other', label: '其他文件', sensitive: true },
]);
export const WARNING = '此类别可能含 API Key、登录凭证或私人数据，同步后会保留在 GitHub 提交历史中。即使删除文件也不能清除历史。确认同步？';

export function safePath(rel) {
  if (typeof rel !== 'string' || !rel || /[\\\x00-\x1f:]/.test(rel) || rel.startsWith('/')) throw new Error('非法同步路径');
  const parts = rel.split('/');
  if (parts.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(\.git|\.dsh-sync)$/i.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s))) throw new Error('路径不允许同步（含插件自身令牌、备份或 Git 数据）');
  if (rel.endsWith('.dshsync-tmp') || rel === 'manifest.json') throw new Error('manifest.json 为同步元数据保留名称');
  return rel;
}
export function categoryOf(rel) {
  const lower = rel.toLowerCase();
  if (/(credential|secret|token|api[-_]?key|password)|(^|\/)\.env($|\.)|\.(pem|key|p12|pfx)$/.test(lower)) return 'credentials';
  if (['cordis.patch.yml', 'package.json'].includes(rel)) return 'core';
  if (rel.startsWith('skills/')) return 'skills';
  if (/^(pnpm-workspace.yaml|pnpm-lock.yaml|package-lock.json|yarn.lock)$/.test(rel)) return 'install-policy';
  if (/^sessions\//i.test(rel)) return 'sessions';
  if (/^storages\//i.test(rel)) return 'storages';
  if (/^(node_modules|\.plugin-manager|\.dsh-market)\//i.test(rel)) return 'packages';
  return 'other';
}
export function selected(rel, cfg) {
  safePath(rel);
  const category = categoryOf(rel);
  const info = CATEGORIES.find(c => c.id === category);
  return cfg.categories.includes(category) && (!info.sensitive || cfg.confirmedSensitive?.includes(category));
}
export function configureCategories(cfg, args) {
  if (!Array.isArray(args.categories) || args.categories.some(id => !CATEGORIES.some(c => c.id === id))) throw new Error('未知同步类别');
  const sensitive = args.categories.filter(id => CATEGORIES.find(c => c.id === id).sensitive);
  const previous = cfg.confirmedSensitive || [];
  if (sensitive.some(id => !previous.includes(id)) && args.confirmSensitive !== true) throw new Error(WARNING + ' 请在用户确认后传 confirmSensitive=true。');
  cfg.categories = [...new Set(args.categories)];
  cfg.confirmedSensitive = sensitive;
}
export async function checkAncestors(root, rel) {
  safePath(rel);
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.isSymbolicLink()) throw new Error('拒绝同步符号链接');
  }
}
export async function inventory(p) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      try { safePath(rel); } catch { continue; }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel + '/');
      else if (entry.isFile()) files.push({ path: rel, category: categoryOf(rel), bytes: (await fs.stat(path.join(dir, entry.name))).size });
    }
  }
  await walk(p.profileDir);
  return files;
}
export async function collectSelected(p, cfg) {
  const files = [];
  for (const f of await inventory(p)) {
    if (!selected(f.path, cfg)) continue;
    if (f.bytes > 50_000_000) throw new Error('选中类别中存在超过 50MB 的文件，请询问 Agent 排查');
    await checkAncestors(p.profileDir, f.path);
    const data = await fs.readFile(path.join(p.profileDir, f.path));
    const text = data.toString('utf8');
    files.push(Buffer.from(text).equals(data) ? { path: f.path, text } : { path: f.path, text: data.toString('base64'), encoding: 'base64' });
  }
  return files;
}
export function fileBytes(f) { return Buffer.from(f.text, f.encoding === 'base64' ? 'base64' : 'utf8'); }
