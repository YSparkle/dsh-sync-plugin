// selfcheck.js —— dsh-sync 离线自检：不依赖 @deepseek-ai/dsh-tools、不联网。
// 覆盖：白名单收集/黑名单拒收、bundle sha、明文扫描正负例、push 的 mock
// 调用序与单 commit 形状、pull 的备份-覆盖-逐字节一致、配置与令牌分离、
// ref 冲突拒推，以及对**本机真实 profile** 的 config_layout 复原断言
// （模型供应商/默认模型/插件 bundles 确实由 cordis.patch.yml + package.json 承载）。
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as prof from '../src/profile.js';
import { GitHubClient, humanizeStatus } from '../src/github.js';
import { scanBundle, scanText } from '../src/secrets.js';
import { performPull, performPush } from '../src/pipeline.js';

const PASS = [];
const FAIL = [];
/** @param {string} name @param {boolean} cond @param {string} [detail] */
function check(name, cond, detail = '') {
  (cond ? PASS : FAIL).push({ name, detail: cond ? '' : detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
}

/* ------------------------------------------------------------------ */
/* mock GitHub                                                         */
/* ------------------------------------------------------------------ */

const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');

/**
 * 极简 mock：按 (方法, 路径) 路由的 canned 网关，并把每次请求记录下来。
 * @param {(method: string, p: string, body: any) => {status?: number, body?: any} | undefined} route
 */
function mockGithub(route) {
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '') + u.search;
    log.push({ method: init.method || 'GET', path: p, body: init.body ? JSON.parse(init.body) : null });
    const r = route(init.method || 'GET', p, init.body ? JSON.parse(init.body) : null);
    if (!r) return Response.json({}, { status: 404 });
    return Response.json(r.body ?? {}, { status: r.status ?? 200 });
  };
  return { log, fetchImpl };
}

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const FIX_PATCH = [
  '# dsh profile patch — fixture',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: x666',
  '    model: glm-5.3-flash',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      x666:',
  '        displayName: x666',
  '        apiKeyEnv: X666_API_KEY',
  '        baseURL: https://x666.me/v1',
  '        models:',
  '          - id: glm-5.3-flash',
  '            name: glm-5.3-flash',
  '      elysia:',
  '        displayName: elysia',
  '        apiKeyEnv: ELYSIA_API_KEY',
  '        baseURL: https://elysia.example/v1',
  '        models:',
  '          - id: glm-5.3',
  '            name: glm-5.3',
  '',
].join('\n');

const FIX_PKG = JSON.stringify(
  {
    name: 'dsh-profile-fixture',
    private: true,
    dependencies: { '@leisureyu/dsh-smart-dl': '1.4.6' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@leisureyu/dsh-smart-dl'] } },
  },
  null,
  2,
);

// 远端 fixture:与本地真正**不同**的 package.json(此前 B2 是 FIX_PKG 的恒等替换,package.json 覆盖路径未被有效检验):
const FIX_PKG_REMOTE = FIX_PKG.replace('1.4.6', '1.4.7');
const FIX_PATCH_NEW = FIX_PATCH.replace('model: glm-5.3-flash', 'model: glm-5.3');
const SKILL_A = '# skill A\nhello\n';
const SKILL_B = '# skill B\nworld\n';

const FIX_WORKSPACE = ['packages:', '  - .', 'nodeLinker: hoisted', 'allowBuilds:', '  protobufjs: false', '  koffi: false', ''].join('\n');

async function makeFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-check-'));
  const env = { DSH_HOME: home, DSH_PROFILE: 'desktop' };
  const p = prof.profilePaths(env);
  await fs.mkdir(path.join(p.profileDir, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(path.join(p.profileDir, 'cordis.patch.yml'), FIX_PATCH, 'utf8');
  await fs.writeFile(path.join(p.profileDir, 'package.json'), FIX_PKG, 'utf8');
  await fs.writeFile(path.join(p.profileDir, 'pnpm-workspace.yaml'), FIX_WORKSPACE, 'utf8');
  await fs.writeFile(path.join(p.profileDir, 'skills', 'demo', 'a.md'), SKILL_A, 'utf8');
  await fs.writeFile(path.join(p.profileDir, 'skills', 'demo', 'b.md'), SKILL_B, 'utf8');
  await fs.mkdir(path.join(p.profileDir, 'skills', 'demo', 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(p.profileDir, 'skills', 'demo', 'node_modules', 'junk.js'), 'junk', 'utf8');
  return { home, env, p };
}

/* ------------------------------------------------------------------ */
/* 1. 路径解析 / 白名单 / 黑名单                                        */
/* ------------------------------------------------------------------ */

async function testPaths(fx) {
  check('paths-injection', fx.p.profileDir === path.join(fx.home, 'profiles', 'desktop'), JSON.stringify(fx.p));

  let denied = null;
  try {
    prof.assertSyncPath('.credentials.yaml');
  } catch (e) {
    denied = e;
  }
  check('denied-credentials-yaml', denied !== null, 'assertSyncPath 应该拒绝 .credentials.yaml');

  for (const bad of ['skills/../.credentials.yaml', '../escape.yml', 'package.json/x', 'node_modules/a/b']) {
    denied = null;
    try {
      prof.assertSyncPath(bad);
    } catch (e) {
      denied = e;
    }
    check(`path-reject:${bad}`, denied !== null, '应拒绝越界/黑名单路径');
  }
  denied = null;
  try {
    prof.assertSyncPath('cordis.patch.yml');
  } catch (e) {
    denied = e;
  }
  check('white-core-path-ok', denied === null, 'cordis.patch.yml 应在白名单内');

  const coreOnly = await prof.collectLocal({ p: fx.p, sections: [] });
  check('collect-core-twofiles', coreOnly.length === 2 && coreOnly.map((f) => f.path).join(',') === 'cordis.patch.yml,package.json');

  const withSkills = await prof.collectLocal({ p: fx.p, sections: ['skills'] });
  const skillRels = withSkills.filter((f) => f.path.startsWith('skills/')).map((f) => f.path).sort();
  check('collect-skills-whitelist', JSON.stringify(skillRels) === JSON.stringify(['skills/demo/a.md', 'skills/demo/b.md']), JSON.stringify(skillRels));

  const withPolicy = await prof.collectLocal({ p: fx.p, sections: ['install-policy'] });
  check(
    'collect-install-policy-optional',
    withPolicy.length === 3 && withPolicy.some((f) => f.path === 'pnpm-workspace.yaml') && withPolicy.find((f) => f.path === 'pnpm-workspace.yaml').text.includes('koffi: false'),
    JSON.stringify(withPolicy.map((f) => f.path)),
  );

  check('bundle-sha-stable', prof.sha256Text(FIX_PKG) === prof.sha256Text(coreOnly.find((f) => f.path === 'package.json').text));
}

/* ------------------------------------------------------------------ */
/* 2. 明文扫描                                                          */
/* ------------------------------------------------------------------ */

function testSecrets(fx) {
  const evil = 'providers:\n  bad:\n    apiKey: sk-SUPERSECRET0987654321abcdef\n';
  const hits = scanText(evil);
  check('scan-positive-sk', hits.length >= 1 && hits[0].line === 3, JSON.stringify(hits));

  const clean = scanText(FIX_PATCH + FIX_PKG);
  check('scan-negative-fixture', clean.length === 0, JSON.stringify(clean));

  const realScan = scanBundle({ files: fx.p ? [{ path: 'cordis.patch.yml', text: FIX_PATCH }] : [] }, { includeSecrets: false });
  check('scan-rejected-default', realScan.hits.length === 0 && realScan.rejected === false);

  const withKey = scanBundle({ files: [{ path: 'cordis.patch.yml', text: evil }] }, { includeSecrets: false });
  check('secret-rejected-flag', withKey.rejected === true && withKey.hits[0].file === 'cordis.patch.yml' && withKey.hits[0].line === 3);

  const allow = scanBundle({ files: [{ path: 'cordis.patch.yml', text: evil }] }, { includeSecrets: true });
  check('secret-allowed-with-warning', allow.rejected === false && allow.warnings.length === 1);
}

/* ------------------------------------------------------------------ */
/* 3. push：mock 调用序与单 commit 形状                                  */
/* ------------------------------------------------------------------ */

async function testPush(fx) {
  const remotePatch = FIX_PATCH + '# edited remotely\n';
  let routeCalls = { patchRef: 0 };
  const { log, fetchImpl } = mockGithub((method, p) => {
    if (method === 'GET' && p === '/git/ref/heads/main') return { body: { object: { sha: 'C1' } } };
    if (method === 'GET' && p === '/git/commits/C1') return { body: { tree: { sha: 'T1' } } };
    if (method === 'POST' && p === '/git/trees') {
      return { body: { sha: 'T2' } };
    }
    if (method === 'POST' && p === '/git/commits') return { body: { sha: 'C2', html_url: 'https://example.test/commit/C2' } };
    if (method === 'PATCH' && p === '/git/refs/heads/main') {
      routeCalls.patchRef++;
      return { body: {} };
    }
    return undefined;
  });
  const c = new GitHubClient({ repo: 'me/private-dsh', token: 'github_pat_' + 'x'.repeat(30), branch: 'main', fetchImpl });

  const raw = await prof.collectLocal({ p: fx.p, sections: ['skills'] });
  const bundle = prof.buildBundle(raw, { p: fx.p });
  const scan = scanBundle(bundle, { includeSecrets: false });
  const manifest = Object.assign(prof.manifestFrom(bundle), { pushedVia: 'selfcheck' });
  const res = await c.putFiles({
    prefix: 'dsh-sync',
    files: [...bundle.files.map((f) => ({ path: f.path, text: f.text })), { path: 'manifest.json', text: JSON.stringify(manifest) }],
    deletions: ['skills/demo/gone.md'],
    message: 'selfcheck push',
  });

  const seq = log.map((e) => `${e.method} ${e.path}`);
  check('push-call-order', JSON.stringify(seq) === JSON.stringify([
    'GET /git/ref/heads/main',
    'GET /git/commits/C1',
    'POST /git/trees',
    'POST /git/commits',
    'PATCH /git/refs/heads/main',
  ]), JSON.stringify(seq));

  const tree = log.find((e) => e.method === 'POST' && e.path === '/git/trees');
  const paths = tree.body.tree.map((t) => t.path);
  check('push-tree-prefixed', paths.every((t) => t.startsWith('dsh-sync/')), JSON.stringify(paths));
  check('push-tree-has-manifest', paths.includes('dsh-sync/manifest.json'));
  check(
    'manifest-install-list',
    Array.isArray(manifest.installList?.bundles) && manifest.installList.bundles.length > 0 &&
      Object.keys(manifest.installList.dependencies || {}).length > 0 &&
      Array.isArray(manifest.installList.localPathDeps),
    `bundles=${manifest.installList?.bundles?.length} deps=${Object.keys(manifest.installList?.dependencies || {}).length}`,
  );
  check('push-deletion-sha-null', tree.body.tree.some((t) => t.path === 'dsh-sync/skills/demo/gone.md' && t.sha === null));
  const patchEntry = tree.body.tree.find((t) => t.path === 'dsh-sync/cordis.patch.yml');
  check('push-content-is-plain-text', patchEntry.content === FIX_PATCH, '树条目直接携带内容');
  check('push-single-commit-parents', JSON.stringify(log.find((e) => e.method === 'POST' && e.path === '/git/commits').body.parents) === JSON.stringify(['C1']));
  check('push-ref-not-forced', tree && routeCalls.patchRef === 1 && log.find((e) => e.method === 'PATCH').body.force === false);
  check('push-commit-url', res.commitUrl === 'https://example.test/commit/C2');
  return remotePatch;
}

/* ------------------------------------------------------------------ */
/* 4. pull：备份-覆盖-逐字节一致回滚                                     */
/* ------------------------------------------------------------------ */

async function testPull(fx, remotePatch) {
  const blobs = {
    B1: b64(remotePatch),
    B2: b64(FIX_PKG_REMOTE),
  };
  const { log, fetchImpl } = mockGithub((method, p) => {
    if (method === 'GET' && p === '/git/ref/heads/main') return { body: { object: { sha: 'C1' } } };
    if (method === 'GET' && p === '/git/commits/C1') return { body: { tree: { sha: 'T1' } } };
    if (method === 'GET' && p.startsWith('/git/trees/T1')) {
      return {
        body: {
          sha: 'T1',
          tree: [
            { path: 'dsh-sync/cordis.patch.yml', type: 'blob', sha: 'B1', size: 10 },
            { path: 'dsh-sync/package.json', type: 'blob', sha: 'B2', size: 10 },
            { path: 'dsh-sync/manifest.json', type: 'blob', sha: 'B3', size: 10 },
            { path: 'other-repo-file.md', type: 'blob', sha: 'B4', size: 1 },
          ],
        },
      };
    }
    if (method === 'GET' && p.startsWith('/git/blobs/B1')) return { body: { content: blobs.B1, encoding: 'base64' } };
    if (method === 'GET' && p.startsWith('/git/blobs/B2')) return { body: { content: blobs.B2, encoding: 'base64' } };
    return undefined;
  });
  const c = new GitHubClient({ repo: 'me/private-dsh', token: 'github_pat_' + 'y'.repeat(30), branch: 'main', fetchImpl });

  const oldPatchSha = prof.sha256Text(await fs.readFile(path.join(fx.p.profileDir, 'cordis.patch.yml'), 'utf8'));
  const oldPkgSha = prof.sha256Text(await fs.readFile(path.join(fx.p.profileDir, 'package.json'), 'utf8'));

  const remote = await c.listPrefix({ prefix: 'dsh-sync' });
  check('pull-listing-filters-prefix', remote.files.every((f) => f.rel !== 'other-repo-file.md') && remote.files.length === 3);

  const files = await c.getFiles(remote.files.filter((f) => f.rel !== 'manifest.json'));
  check('pull-skips-manifest', files.every((f) => f.path !== 'manifest.json') && files.length === 2);

  const dry = await prof.applyIncoming(fx.p, files, { dryRun: true });
  check('pull-dryrun-writes-nothing', dry.dryRun === true && dry.toWrite.length === 2 && (await fs.readFile(path.join(fx.p.profileDir, 'cordis.patch.yml'), 'utf8')) === FIX_PATCH);

  const apply = await prof.applyIncoming(fx.p, files, { mirrorDelete: false, localSkillRels: await prof.listLocalSkillRels(fx.p) });
  check(
    'pull-apply-overwrites',
    (await fs.readFile(path.join(fx.p.profileDir, 'cordis.patch.yml'), 'utf8')) === remotePatch &&
      (await fs.readFile(path.join(fx.p.profileDir, 'package.json'), 'utf8')) === FIX_PKG_REMOTE,
    '两个白名单文件都被远端内容逐字节覆盖',
  );

  const backupDir = apply.backupDir;
  const backupPatch = await fs.readFile(path.join(backupDir, 'cordis.patch.yml'), 'utf8');
  const backupPkg = await fs.readFile(path.join(backupDir, 'package.json'), 'utf8');
  check('backup-content-match', prof.sha256Text(backupPatch) === oldPatchSha && prof.sha256Text(backupPkg) === oldPkgSha, `备份与覆盖前逐字节一致(${backupDir})`);
  check('backup-no-skill-copies', (await fs.stat(path.join(backupDir, 'skills', 'demo', 'a.md')).catch(() => null)) === null);

  // 回滚演练：把备份复制回去,内容恢复为覆盖前
  await fs.copyFile(path.join(backupDir, 'cordis.patch.yml'), path.join(fx.p.profileDir, 'cordis.patch.yml'));
  check('rollback-restores', prof.sha256Text(await fs.readFile(path.join(fx.p.profileDir, 'cordis.patch.yml'), 'utf8')) === oldPatchSha, '手工复制回滚可行');

  // 镜像删除走备份 + 白名单外不删
  const mirror = await prof.applyIncoming(fx.p, [{ path: 'package.json', text: FIX_PKG }], {
    mirrorDelete: true,
    localSkillRels: await prof.listLocalSkillRels(fx.p),
  });
  check('mirror-delete-backuped', mirror.deleted.length === 2 && mirror.deleted[0].startsWith('skills/'), JSON.stringify(mirror.deleted));
  check('skills-deleted', !(await fs.stat(path.join(fx.p.profileDir, 'skills/demo/a.md')).catch(() => null)));
}

/* ------------------------------------------------------------------ */
/* 5. 配置存储 / 令牌分离 / 冲突                                        */
/* ------------------------------------------------------------------ */

async function testConfigAndConflict(fx) {
  await prof.saveConfig(fx.p, { repo: 'me/private-dsh', branch: 'main', remotePrefix: 'dsh-sync' });
  await prof.saveToken(fx.p, 'github_pat_' + 'z'.repeat(30));
  const cfg = await prof.readConfig(fx.p);
  check('config-roundtrip', cfg.repo === 'me/private-dsh' && cfg.remotePrefix === 'dsh-sync');
  check('token-not-in-config', JSON.stringify(cfg).includes('github_pat_') === false, '令牌绝不能写进 config.json');
  check(
    'token-read-back',
    (await prof.readToken(fx.p, {})).startsWith('github_pat_') && (await prof.readToken(fx.p, { DSH_SYNC_TOKEN: 'env-token-override' })) === 'env-token-override',
    '环境变量必须逐字覆盖到读出的令牌值,而不是"非 null"。',
  );

  // tokenRef:引用式令牌——env:/file: 即用即取;本体被解析使用,但绝不进配置、不进对话
  const mref = prof.mergeConfigArgs({ repo: 'me/private-dsh' }, { repo: 'me/private-dsh', tokenRef: 'env:SELFCHECK_PAT' });
  check('tokenref-merge-keep', mref.tokenRef === 'env:SELFCHECK_PAT', '合法引用写入配置');
  let badRef = null;
  try {
    prof.mergeConfigArgs({ repo: 'me/private-dsh' }, { repo: 'me/private-dsh', tokenRef: 'github_pat_raw_token' });
  } catch (e) {
    badRef = e;
  }
  check('tokenref-merge-rejects-raw', badRef !== null && badRef.message.includes('env:'), '无前缀裸令牌在保存时报错而非尝试使用');

  await prof.saveConfig(fx.p, { repo: 'me/private-dsh', tokenRef: 'env:SELFCHECK_PAT' });
  const cfgRef = await prof.readConfig(fx.p);
  check('tokenref-not-a-secret', !JSON.stringify(cfgRef).includes('github_pat_'), 'config.json 只存引用不存本体');
  check('tokenref-env', (await prof.readToken(fx.p, { SELFCHECK_PAT: 'github_pat_' + 'r'.repeat(30) })) === 'github_pat_' + 'r'.repeat(30), 'env: 引用按名解析,即用即取');
  const refTokenFile = path.join(fx.p.dataDir, 'ref-token.txt');
  await fs.writeFile(refTokenFile, 'github_pat_' + 'f'.repeat(30) + '\n', 'utf8');
  await prof.saveConfig(fx.p, { repo: 'me/private-dsh', tokenRef: 'file:' + refTokenFile });
  check('tokenref-file', (await prof.readToken(fx.p, {})) === 'github_pat_' + 'f'.repeat(30), 'file: 引用读文件并 trim 行尾换行');
  check('tokenref-priority', (await prof.readToken(fx.p, { DSH_SYNC_TOKEN: 'ovr-token' })) === 'ovr-token', '环境变量临时覆盖仍优先于 tokenRef');
  await prof.saveConfig(fx.p, { repo: 'me/private-dsh', tokenRef: 'env:SELFCHECK_MISSING_VAR' });
  check('tokenref-bad-ref-fallback', (await prof.readToken(fx.p, {})) === 'github_pat_' + 'z'.repeat(30), '引用解析失败回退本机令牌文件');
  await fs.rm(refTokenFile, { force: true });

  // mergeConfigArgs(sync_config 的合并契约):全新默认 / 省略保留既有 / 显式翻转
  const m1 = prof.mergeConfigArgs({}, { repo: 'me/private-dsh' });
  check(
    'merge-defaults',
    m1.repo === 'me/private-dsh' && m1.branch === 'main' && m1.remotePrefix === 'dsh-sync' && JSON.stringify(m1.sections) === '["core"]' && m1.includeSecrets === false && m1.mirrorDeletes === false,
  );
  const m2 = prof.mergeConfigArgs(
    { repo: 'me/private-dsh', branch: 'dev', remotePrefix: 'dsh-sync-laptop', sections: ['core', 'skills'], includeSecrets: true, mirrorDeletes: true },
    { repo: 'me/private-dsh' },
  );
  check(
    'merge-keep-when-omitted',
    m2.branch === 'dev' && m2.remotePrefix === 'dsh-sync-laptop' && JSON.stringify(m2.sections) === '["core","skills"]' && m2.includeSecrets === true && m2.mirrorDeletes === true,
    '省略的参数必须原样保留既有值',
  );
  const m3 = prof.mergeConfigArgs({ repo: 'me/private-dsh', includeSecrets: false, mirrorDeletes: false }, { repo: 'me/private-dsh', includeSecrets: true, mirrorDeletes: true });
  check('merge-flip-explicit', m3.includeSecrets === true && m3.mirrorDeletes === true, '显式传 boolean 必须立即生效');

  // 体验:sync_status 回执的开关一行描述(on/off)
  check(
    'status-switch-format',
    prof.describeSwitches({}) === 'includeSecrets=off / mirrorDeletes=off' &&
      prof.describeSwitches({ includeSecrets: true, mirrorDeletes: true }) === 'includeSecrets=on / mirrorDeletes=on',
    '两开关状态须以 on/off 一行可读形式回显',
  );

  // 体验:备份保留提示——超过阈值(20 份)只提示、绝不自动删除;低于阈值静默
  const probeRoot = path.join(fx.p.dataDir, 'retention-probe');
  check('retention-note-below-threshold', (await prof.backupRetentionNote({ backupsDir: probeRoot })) === null, '空目录不应提示');
  for (let i = 0; i < 21; i++) await fs.mkdir(path.join(probeRoot, `t${String(i).padStart(2, '0')}`), { recursive: true });
  const retentionNote = await prof.backupRetentionNote({ backupsDir: probeRoot });
  check('retention-note-over-threshold', typeof retentionNote === 'string' && retentionNote.includes('21 份') && retentionNote.includes('手工清理'), String(retentionNote));
  await fs.rm(probeRoot, { recursive: true, force: true });

  let badRepo = null;
  try {
    await prof.saveConfig(fx.p, { repo: 'not-a-repo' });
  } catch (e) {
    badRepo = e;
  }
  check('reject-bad-repo', badRepo !== null);

  const { log, fetchImpl } = mockGithub((method, p) => {
    if (method === 'GET' && p === '/git/ref/heads/main') return { body: { object: { sha: 'C1' } } };
    if (method === 'GET' && p === '/git/commits/C1') return { body: { tree: { sha: 'T1' } } };
    if (method === 'POST' && p === '/git/trees') return { body: { sha: 'T2' } };
    if (method === 'POST' && p === '/git/commits') return { body: { sha: 'C2', html_url: 'u' } };
    if (method === 'PATCH' && p === '/git/refs/heads/main') return { status: 422, body: { message: 'Update is not a fast forward' } };
    return undefined;
  });
  const c = new GitHubClient({ repo: 'me/private-dsh', token: 't'.repeat(30), fetchImpl });
  let conflict = null;
  try {
    await c.putFiles({ prefix: 'dsh-sync', files: [{ path: 'package.json', text: '{}' }], message: 'x' });
  } catch (e) {
    conflict = e;
  }
  check('ref-conflict-rejected', conflict !== null && /冲突|fast/i.test(conflict.message), conflict && conflict.message);
  check('conflict-saw-patch-ref', log.some((e) => e.method === 'PATCH' && e.path === '/git/refs/heads/main'));

  check('empty-repo-head-null', (await new GitHubClient({ repo: 'me/private-dsh', token: 'q'.repeat(30), fetchImpl: async () => Response.json({}, { status: 404 }) }).getHead()) === null);
  check('empty-repo-head-null-409', (await new GitHubClient({ repo: 'me/private-dsh', token: 'q'.repeat(30), fetchImpl: async () => Response.json({ message: 'Git Repository is empty.' }, { status: 409 }) }).getHead()) === null);
  check('humanize-conflict-text', /冲突/.test(humanizeStatus(422, '{"message":"Update is not a fast forward"}', '/x')));

  // 空仓库首推回放(真实序列,2026-10 首推实测):GET ref → 409「Git Repository is
  // empty.」,且 POST /git/trees 同样 409;必须先用 Contents API(PUT /contents/…)
  // 落第一个文件造出基线 commit,之后 GET ref/PATCH 才可用。客户端应自动引导。
  const emptyLog = [];
  let emptySeeded = false;
  const fetchEmpty = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    emptyLog.push({ method: init.method || 'GET', path: p, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET' && (p === '/git/ref/heads/main' || p === '/git/refs/heads/main')) {
      return emptySeeded
        ? Response.json({ ref: 'refs/heads/main', object: { sha: 'C1' } })
        : Response.json({ message: 'Git Repository is empty.' }, { status: 409 });
    }
    if (init.method === 'PUT' && p === '/contents/dsh-sync/package.json') { emptySeeded = true; return Response.json({ commit: { sha: 'C1' } }, { status: 201 }); }
    if (init.method === 'GET' && p === '/git/commits/C1') return Response.json({ sha: 'C1', tree: { sha: 'T1' } });
    if (init.method === 'POST' && p === '/git/trees') return Response.json({ sha: 'T2' }, { status: 201 });
    if (init.method === 'POST' && p === '/git/commits') return Response.json({ sha: 'C2', html_url: 'u2' }, { status: 201 });
    if (init.method === 'PATCH' && p === '/git/refs/heads/main') return Response.json({});
    if (init.method === 'POST' && p === '/git/refs') return Response.json({ ref: 'refs/heads/main' }, { status: 201 });
    return Response.json({}, { status: 404 });
  };
  const cEmpty = new GitHubClient({ repo: 'me/brand-new', token: 'e'.repeat(30), branch: 'main', fetchImpl: fetchEmpty });
  const firstPush = await cEmpty.putFiles({ prefix: 'dsh-sync', files: [{ path: 'package.json', text: '{}' }], message: 'first' });
  check(
    'empty-repo-first-push-creates-ref',
    firstPush.commitSha === 'C2' &&
      emptyLog.some((e) => e.method === 'PUT' && e.path === '/contents/dsh-sync/package.json' && e.body.branch === 'main' && e.body.content === Buffer.from('{}', 'utf8').toString('base64')) &&
      emptyLog.some((e) => e.method === 'GET' && e.path === '/git/commits/C1') &&
      !emptyLog.some((e) => e.method === 'POST' && e.path === '/git/refs'),
    JSON.stringify(emptyLog.map((e) => `${e.method} ${e.path}`)),
  );

  // 补充回放:有提交但 ref 缺失/被并发删除时,PATCH 404 → 改走 POST /git/refs 兜底。
  const orphanLog = [];
  const fetchOrphan = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    orphanLog.push({ method: init.method || 'GET', path: p, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET' && (p === '/git/ref/heads/main' || p === '/git/refs/heads/main')) return Response.json({ object: { sha: 'C1' } });
    if (init.method === 'GET' && p === '/git/commits/C1') return Response.json({ sha: 'C1', tree: { sha: 'T1' } });
    if (init.method === 'POST' && p === '/git/trees') return Response.json({ sha: 'T2' }, { status: 201 });
    if (init.method === 'POST' && p === '/git/commits') return Response.json({ sha: 'C2', html_url: 'u2' }, { status: 201 });
    if (init.method === 'PATCH' && p === '/git/refs/heads/main') return Response.json({ message: 'Reference does not exist' }, { status: 404 });
    if (init.method === 'POST' && p === '/git/refs') return Response.json({ ref: 'refs/heads/main' }, { status: 201 });
    return Response.json({}, { status: 404 });
  };
  const cOrphan = new GitHubClient({ repo: 'me/orphan', token: 'o'.repeat(30), branch: 'main', fetchImpl: fetchOrphan });
  const orphanPush = await cOrphan.putFiles({ prefix: 'dsh-sync', files: [{ path: 'package.json', text: '{}' }], message: 're' });
  check(
    'orphan-ref-patch-404-creates-ref',
    orphanPush.commitSha === 'C2' &&
      orphanLog.some((e) => e.method === 'POST' && e.path === '/git/refs' && e.body.ref === 'refs/heads/main' && e.body.sha === 'C2'),
    JSON.stringify(orphanLog.map((e) => `${e.method} ${e.path}`)),
  );
}

/* ------------------------------------------------------------------ */
/* 6. 本机真实 profile：config_layout 复原断言                          */
/* ------------------------------------------------------------------ */

/** 从 patch 文本切出某个 '- id: <name>' 条目的行块（到下一个顶格 '- id:' 或 EOF）。 */
function sliceEntry(text, id) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^-\s+id:\s*(.+)\s*$/);
    if (!m) continue;
    const isTarget = m[1].trim() === id;
    const hasSeen = start >= 0;
    if (isTarget && !hasSeen) start = i;
    else if (hasSeen && i > start) {
      end = i;
      break;
    }
  }
  return start < 0 ? null : lines.slice(start, end).join('\n');
}

async function testRealProfile() {
  const p = prof.profilePaths(); // 本机 DSH_HOME/DSH_PROFILE
  let patchText;
  let pkgText;
  try {
    patchText = await fs.readFile(path.join(p.profileDir, 'cordis.patch.yml'), 'utf8');
    pkgText = await fs.readFile(path.join(p.profileDir, 'package.json'), 'utf8');
  } catch (e) {
    check('real-profile-files', false, `读不到真实 profile(${p.profileDir}):${e.message}`);
    return;
  }
  check('real-profile-files', true);

  const embedded = await prof.collectLocal({ p, sections: [] });
  check('real-collect-two-files', embedded.length === 2);

  // 供应商:apiKeyEnv 引用名 ≥2(凭证以名引用,而非明文)
  const apiKeyEnvs = [...new Set([...patchText.matchAll(/apiKeyEnv:\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
  check('real-providers-via-credential-ref', apiKeyEnvs.length >= 2, `found=${JSON.stringify(apiKeyEnvs)}`);

  // baseURL 每个供应商一个
  check('real-baseurl-present', (patchText.match(/baseURL:\s*\S+/g) || []).length >= apiKeyEnvs.length);

  // 模型清单:llm-pi-ai 条目里的 models 数 ≥10
  const entry = sliceEntry(patchText, 'llm-pi-ai');
  const modelIds = entry ? [...entry.matchAll(/^\s+-\s+id:\s*(.+)$/gm)].map((m) => m[1].trim()) : [];
  check('real-models-recovered', entry !== null && modelIds.length >= 10, `models=${modelIds.length}`);

  // 默认模型:agent-default-model 条目的 provider/model 非空
  const adm = sliceEntry(patchText, 'agent-default-model') || '';
  const providerMatch = adm.match(/^\s*provider:\s*(\S+)\s*$/m);
  const modelMatch = adm.match(/^\s*model:\s*(\S+)\s*$/m);
  check('real-default-model-recovered', Boolean(providerMatch && modelMatch), `provider=${providerMatch?.[1]} model=${modelMatch?.[1]}`);

  // 插件:依赖与 bundles 从 package.json 复原
  const pkg = JSON.parse(pkgText);
  const bundles = pkg?.dsh?.profile?.bundles || [];
  check('real-bundles-recovered', Array.isArray(bundles) && bundles.length >= 10, `bundles=${bundles.length}`);
  check('real-base-bundle-present', bundles.includes('@deepseek-ai/dsh-base'));
  check('real-deps-match-bundles-super', Object.keys(pkg.dependencies || {}).length >= bundles.length - 3, '依赖数与启用数同量级');

  // 凭证本体不在配置里:patch/package.json 都不该出现 credentials 文件名或 sk- 明文
  check('real-no-plaintext-keys', scanText(patchText).length === 0 && scanText(pkgText).length === 0, JSON.stringify(scanText(patchText)));
  check('real-no-credentials-file-ref', !patchText.includes('.credentials.yaml') && !pkgText.includes('.credentials.yaml'));
}

/* ------------------------------------------------------------------ */
/* 6.5 端到端（经 pipeline,与 tools.js 同一条代码路径）                  */
/* ------------------------------------------------------------------ */

async function testPipelineE2E() {
  // 机器 A：patch 里埋了明文 sk- 密钥
  const homeA = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-e2e-a-'));
  const envA = { DSH_HOME: homeA, DSH_PROFILE: 'desktop' };
  const pa = prof.profilePaths(envA);
  await fs.mkdir(pa.profileDir, { recursive: true });
  await fs.writeFile(path.join(pa.profileDir, 'cordis.patch.yml'), FIX_PATCH + '  leaked:\n    apiKey: sk-LEAKEDKEY1234567890abcdef\n', 'utf8');
  await fs.writeFile(path.join(pa.profileDir, 'package.json'), FIX_PKG, 'utf8');

  // mock 网关:先推空仓库,记录后来的内容供机器 B 拉取
  let pushedTree = null;
  const { log: logA, fetchImpl: fetchA } = mockGithub((method, p) => {
    if (method === 'GET' && p === '/git/ref/heads/main') return pushedTree ? { body: { object: { sha: 'C1' } } } : { status: 404, body: {} };
    if (method === 'PUT' && p.startsWith('/contents/')) return { status: 201, body: { commit: { sha: 'C1' } } };
    if (method === 'GET' && p === '/git/commits/C1') return { body: { tree: { sha: 'T1' } } };
    if (method === 'POST' && p === '/git/trees') return { body: { sha: 'T2' } };
    if (method === 'POST' && p === '/git/commits') return { body: { sha: 'C2', html_url: 'https://example.test/commit/C2' } };
    if (method === 'PATCH' && p === '/git/refs/heads/main') return { body: {} };
    return undefined;
  });

  const clientA0 = new GitHubClient({ repo: 'me/e2e', token: 'a'.repeat(30), fetchImpl: fetchA });
  const rejected = await performPush({ p: pa, cfg: { repo: 'me/e2e', branch: 'main', remotePrefix: 'dsh-sync', sections: ['core', 'install-policy'] }, client: clientA0 });
  check(
    'secret-rejected',
    rejected.ok === false && rejected.stage === 'secret-scan' && logA.length === 0,
    `ok=${rejected.ok} stage=${rejected.stage} 请求记录=${logA.length} 条(必须是 0——没发任何网络请求)`,
  );

  // 显式放行(强烈不建议,这里只为验证路径):推送成功且带警告
  const allowed = await performPush({
    p: pa,
    cfg: { repo: 'me/e2e', branch: 'main', remotePrefix: 'dsh-sync', sections: ['core'], includeSecrets: true },
    client: clientA0,
  });
  pushedTree = logA.find((e) => e.method === 'POST' && e.path === '/git/trees');
  check(
    'secret-allowed-warning',
    allowed.ok === true && allowed.warnings.length >= 1 && pushedTree !== null && JSON.stringify(pushedTree.body).includes('sk-LEAKEDKEY'),
    `ok=${allowed.ok} warnings=${allowed.warnings.length}`,
  );

  // 机器 B：空机器,从 A 推的内容复原(用 A 的 tree 条目搭 pull mock)
  const homeB = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-e2e-b-'));
  const envB = { DSH_HOME: homeB, DSH_PROFILE: 'desktop' };
  const pb = prof.profilePaths(envB);
  await fs.mkdir(pb.profileDir, { recursive: true });

  const entries = pushedTree.body.tree.map((t) => ({ gitPath: t.path, content: t.content }));
  const b64c = (text) => Buffer.from(text, 'utf8').toString('base64');
  const { fetchImpl: fetchB } = mockGithub((method, p) => {
    if (method === 'GET' && p === '/git/ref/heads/main') return { body: { object: { sha: 'C1' } } };
    if (method === 'GET' && p === '/git/commits/C1') return { body: { tree: { sha: 'T1' } } };
    if (method === 'GET' && p.startsWith('/git/trees/T1')) {
      return {
        body: { truncated: false, tree: entries.map((e, i) => ({ path: e.gitPath, type: 'blob', sha: `B${i}`, size: 10 })) },
      };
    }
    for (let i = 0; i < entries.length; i++) {
      if (method === 'GET' && p.startsWith(`/git/blobs/B${i}`)) return { body: { content: b64c(entries[i].content), encoding: 'base64' } };
    }
    return undefined;
  });
  const clientB = new GitHubClient({ repo: 'me/e2e', token: 'b'.repeat(30), fetchImpl: fetchB });
  const pullCfg = { repo: 'me/e2e', branch: 'main', remotePrefix: 'dsh-sync', sections: ['core', 'install-policy'] };
  const restored = await performPull({ p: pb, cfg: pullCfg, client: clientB });
  const gotPatch = await fs.readFile(path.join(pb.profileDir, 'cordis.patch.yml'), 'utf8');
  const gotPkg = await fs.readFile(path.join(pb.profileDir, 'package.json'), 'utf8');
  check(
    'pull-cycle-b-equals-a',
    restored.ok === true && gotPatch.includes('sk-LEAKEDKEY') && gotPkg === FIX_PKG,
    '机器 B 的两文件与 A 推送内容一致(manifest.json 不落本地)',
  );
  check('pull-e2e-manifest-skipped', !(await fs.stat(path.join(pb.profileDir, 'manifest.json')).catch(() => null)));

  // 第二轮 pull：本地改过 → 覆盖 + 备份目录出现,备份内容 = 被覆盖前
  await fs.writeFile(path.join(pb.profileDir, 'package.json'), '{"local":"edit"}', 'utf8');
  const second = await performPull({ p: pb, cfg: pullCfg, client: clientB });
  const backupPkg = await fs.readFile(path.join(second.backupDir, 'package.json'), 'utf8');
  check(
    'pull-overwrite-backup-exists',
    second.ok === true && backupPkg === '{"local":"edit"}' && (await fs.readFile(path.join(pb.profileDir, 'package.json'), 'utf8')) === FIX_PKG,
    '覆盖生效且备份=覆盖前内容',
  );
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const fx = await makeFixture();
  try {
    await testPaths(fx);
    testSecrets(fx);
    const remotePatch = await testPush(fx);
    await testPull(fx, remotePatch);
    await testConfigAndConflict(fx);
    if (process.argv.includes('--real-profile')) await testRealProfile();
    else console.log('SKIP real-profile (使用 --real-profile 在已安装 DSH 的机器验证)');
    await testPipelineE2E();
  } catch (e) {
    check('selfcheck-no-crash', false, e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : String(e));
  }
  const report = {
    plugin: 'dsh-sync 0.2.2',
    at: new Date().toISOString(),
    pass: PASS.length,
    fail: FAIL.length,
    failures: FAIL,
    machine: { profile: prof.profilePaths().profileDir, node: process.version },
  };
  console.log(`\nresult: ${PASS.length} PASS / ${FAIL.length} FAIL`);
  process.exitCode = FAIL.length === 0 ? 0 : 1;
  return report;
}

// 直接执行时把结果落盘到 scripts/out/selfcheck-report.json。
import { pathToFileURL, fileURLToPath } from 'node:url';
const direct = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const report = await main();
if (direct) {
  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'selfcheck-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`report: ${path.join(outDir, 'selfcheck-report.json')}`);
}
