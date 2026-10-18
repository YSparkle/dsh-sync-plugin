import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as prof from '../src/profile.js';
import { CATEGORIES, configureCategories, inventory, selected, safePath, fileBytes } from '../src/categories.js';
import { performPush, performPull } from '../src/pipeline.js';
import { makeTools } from '../src/tools.js';
import { makeSettingsRoute } from '../src/settings.js';
import { GitHubClient } from '../src/github.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-categories-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = prof.profilePaths({ DSH_HOME: root });
  await fs.mkdir(p.profileDir, { recursive: true });
  for (const [rel, text] of Object.entries({ 'cordis.patch.yml': 'settings: true', 'package.json': '{}', '.credentials.yaml': 'key: sk-abcdefghijklmnopqrstuvwx', 'sessions/a.json': '{"chat":1}', 'storages/a.bin': Buffer.from([0xff, 0x80, 0, 1]), 'custom.txt': 'misc' })) {
    const abs = path.join(p.profileDir, rel); await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, text);
  }
  return p;
}
test('分类覆盖、自身数据排除、敏感确认、空选择', async t => {
  const p = await fixture(t);
  await fs.mkdir(p.dataDir, { recursive: true }); await fs.writeFile(p.tokenFile, 'never-sync');
  const files = await inventory(p);
  assert.equal(files.length, 6); assert.equal(files.find(f => f.path === '.credentials.yaml').category, 'credentials');
  const cfg = {};
  assert.throws(() => configureCategories(cfg, { categories: ['credentials'] }), /确认/);
  configureCategories(cfg, { categories: ['credentials'], confirmSensitive: true });
  assert(selected('.credentials.yaml', cfg)); assert(!selected('package.json', cfg));
  assert.equal((await prof.collectLocal({ p, cfg })).length, 1);
  configureCategories(cfg, { categories: [] }); assert.deepEqual(await prof.collectLocal({ p, cfg }), []);
  assert.throws(() => configureCategories(cfg, { categories: ['unknown'] }));
});
test('全类别 push/pull 保留二进制、备份与取消勾选', async t => {
  const p = await fixture(t);
  const cfg = { repo: 'me/test', remotePrefix: 'sync' };
  configureCategories(cfg, { categories: CATEGORIES.map(c => c.id), confirmSensitive: true });
  let payload;
  const client = { listPrefix: async () => ({ emptyRepo: false, files: [] }), putFiles: async args => { payload = args.files; return { commitUrl: 'test' }; } };
  const result = await performPush({ p, cfg, client }); assert(result.ok); assert(result.warnings.length);
  const binary = payload.find(f => f.path === 'storages/a.bin'); assert.equal(binary.encoding, 'base64');
  const original = fileBytes(binary); await fs.writeFile(path.join(p.profileDir, binary.path), Buffer.from([9, 8]));
  await fs.writeFile(path.join(p.profileDir, '.credentials.yaml'), 'keep-local');
  configureCategories(cfg, { categories: ['storages'], confirmSensitive: true });
  const incoming = { listPrefix: async () => ({ files: payload.map(f => ({ rel: f.path })) }), getFiles: async entries => payload.filter(f => entries.some(e => e.rel === f.path)) };
  const preview = await performPull({ p, cfg, client: incoming, dryRun: true }); assert.deepEqual(preview.toWrite, [binary.path]);
  const applied = await performPull({ p, cfg, client: incoming });
  assert.deepEqual(await fs.readFile(path.join(p.profileDir, binary.path)), original);
  assert.deepEqual(await fs.readFile(path.join(applied.backupDir, binary.path)), Buffer.from([9, 8]));
  assert.equal(await fs.readFile(path.join(p.profileDir, '.credentials.yaml'), 'utf8'), 'keep-local');
});
test('遍历、符号链接与未选中 skills 删除被阻止', async t => {
  const p = await fixture(t); const cfg = { remotePrefix: 'sync', categories: ['core'], mirrorDeletes: true };
  for (const rel of ['../x', '/etc/x', 'skills/../../x', 'C:/x', 'skills\\x', '.dsh-sync/token', 'skills/.git/x', 'CON', 'skills/x.']) assert.throws(() => safePath(rel));
  const outside = path.join(p.home, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'a'), 'untouched');
  await fs.symlink(outside, path.join(p.profileDir, 'linked'));
  assert(!(await inventory(p)).some(f => f.path.startsWith('linked/')));
  const all = { ...cfg, categories: ['other'], confirmedSensitive: ['other'] };
  await assert.rejects(prof.applyIncoming(p, [{ path: 'linked/a', text: 'overwrite' }], { cfg: all }), /符号链接/);
  await fs.mkdir(path.join(p.profileDir, 'skills')); await fs.writeFile(path.join(p.profileDir, 'skills/a'), 'retain');
  const client = { listPrefix: async () => ({ files: [{ rel: 'package.json' }, { rel: '.credentials.yaml' }] }), getFiles: async entries => { assert.deepEqual(entries.map(e => e.rel), ['package.json']); return [{ path: 'package.json', text: '{}' }]; } };
  const result = await performPull({ p, cfg, client, dryRun: true }); assert.deepEqual(result.toDelete, []);
});
test('无配置与传输错误返回可供 Agent 排查的信息', async t => {
  const p = await fixture(t); const old = process.env.DSH_HOME; process.env.DSH_HOME = p.home;
  t.after(() => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; });
  const tools = makeTools();
  const failed = await tools.find(t => t.name === 'sync_push').execute({}); assert.equal(failed.ok, false); assert.match(failed.detail, /Agent/);
  const configured = await tools.find(t => t.name === 'sync_config').execute({ repo: 'me/repo', categories: ['core'] }); assert(configured.ok);
  const update = await tools.find(t => t.name === 'sync_config').execute({ categories: [] }); assert(update.ok); assert.deepEqual((await prof.readConfig(p)).categories, []);
});
test('GitHub 二进制 blob 原字节往返', async () => {
  const original = Buffer.from([255, 128, 0, 65]); const requests = [];
  const client = new GitHubClient({ repo: 'me/repo', token: 'token', fetchImpl: async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; requests.push({ url, body });
    if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'head' } });
    if (url.endsWith('/git/commits/head')) return Response.json({ tree: { sha: 'base' } });
    if (url.endsWith('/git/blobs/binary')) return Response.json({ content: original.toString('base64') });
    if (url.endsWith('/git/blobs')) { assert.equal(body.encoding, 'base64'); assert.deepEqual(Buffer.from(body.content, 'base64'), original); return Response.json({ sha: 'binary' }); }
    return Response.json({ sha: 'new' });
  } });
  const files = await client.getFiles([{ rel: 'storages/a', sha: 'binary' }]);
  await client.putFiles({ prefix: 'sync', files, message: 'test' });
  assert(requests.find(r => r.url.endsWith('/git/trees')).body.tree.some(e => e.sha === 'binary'));
});
test('设置 API 拒绝跨站与非 JSON 请求', async () => {
  const route = makeSettingsRoute();
  for (const [method, headers, expected] of [['GET', {}, 405], ['POST', {}, 415], ['POST', { 'content-type': 'application/json', origin: 'https://evil.test', host: 'localhost:8000' }, 403]]) {
    let status; await route.handler({ method, headers }, { writeHead(code) { status = code; }, end() {} }); assert.equal(status, expected);
  }
});
test('浏览器入口注册设置与插件页；敏感勾选取消不生效', async () => {
  let entry; let registration; const state = []; let cursor = 0; let confirmResult = false;
  const React = { createElement(type, props, ...children) { return { type, props, children }; }, useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; }, useEffect() {} };
  const sandbox = { window: { __ModuleLoader__: { load(value) { entry = value; } }, confirm() { return confirmResult; } } };
  vm.runInNewContext(await fs.readFile(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  const plugin = entry.factory(() => React); const slots = [];
  plugin.apply({ slots: { inject(name, fn) { slots.push(name); fn(); }, register(options, component) { registration = component; } } });
  assert.deepEqual(slots, ['settings.section', 'settings.plugins.tab']);
  cursor = 0; registration(); state[1] = [{ id: 'credentials', label: 'API Key', sensitive: true, count: 1, bytes: 0 }]; state[5] = true;
  function checkbox(tree) { if (!tree || typeof tree !== 'object') return null; if (tree.type === 'input' && tree.props.type === 'checkbox') return tree; for (const child of tree.children || []) { for (const element of Array.isArray(child) ? child : [child]) { const found = checkbox(element); if (found) return found; } } return null; }
  cursor = 0; checkbox(registration()).props.onChange({ target: { checked: true } }); assert(!state[2].includes('credentials'));
  confirmResult = true; cursor = 0; checkbox(registration()).props.onChange({ target: { checked: true } }); assert(state[2].includes('credentials')); assert(state[3].includes('credentials'));
});
test('未确认敏感类别不能读取，空选择不能创建远端提交', async t => {
  const p = await fixture(t);
  const cfg = { categories: ['credentials'], confirmedSensitive: [] };
  assert.deepEqual(await prof.collectLocal({ p, cfg }), []);
  let network = false;
  const result = await performPush({ p, cfg, client: { listPrefix() { network = true; throw new Error('unexpected'); } } });
  assert.equal(result.ok, false); assert.equal(result.stage, 'empty-selection'); assert.equal(network, false);
});
test('网络失败向 Agent 返回提示并遮盖当前令牌', async t => {
  const p = await fixture(t); const previous = { home: process.env.DSH_HOME, token: process.env.DSH_SYNC_TOKEN, fetch: globalThis.fetch };
  process.env.DSH_HOME = p.home; process.env.DSH_SYNC_TOKEN = 'fixture-token-private-123456';
  globalThis.fetch = async () => { throw new Error('connection failed: fixture-token-private-123456'); };
  t.after(() => { if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home; if (previous.token === undefined) delete process.env.DSH_SYNC_TOKEN; else process.env.DSH_SYNC_TOKEN = previous.token; globalThis.fetch = previous.fetch; });
  await prof.saveConfig(p, { repo: 'me/repo', categories: ['core'], remotePrefix: 'sync' });
  const failed = await makeTools().find(t => t.name === 'sync_push').execute({});
  assert.equal(failed.ok, false); assert.match(failed.detail, /Agent/); assert(!failed.detail.includes('fixture-token-private-123456'));
});
test('设置 API 无需等待 Agent tools 服务即可加载', async () => {
  const plugin = await import('../src/index.js');
  assert.deepEqual(plugin.inject, []);
  let route; let disposed = false; let cleanup; const requested = [];
  plugin.apply({ inject(dependencies, callback) {
    requested.push(dependencies[0]);
    if (dependencies[0] === 'webServer') callback({ webServer: { register(value) { route = value; return () => { disposed = true; }; } }, effect(effect) { cleanup = effect(); } });
    // No tools service: its callback is intentionally not invoked.
  } });
  assert(route); assert.equal(route.path, '/api/dsh-sync');
  assert.deepEqual(requested, ['webServer', 'tools']); cleanup(); assert(disposed);
});
