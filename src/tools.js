// tools.js —— dsh-sync 四个工具。逻辑都委托给 profile.js / github.js /
// secrets.js（自检覆盖的正是这三块）；本文件只做编排、文案与参数校验。
import { CATEGORIES, WARNING, inventory, selected, fileBytes } from './categories.js';
import { createHash } from 'node:crypto';
import * as prof from './profile.js';
import { GitHubClient } from './github.js';
import { performPull, performPush } from './pipeline.js';

function maskToken(t) {
  if (!t) return null;
  return t.length > 8 ? `${t.slice(0, 4)}…${'*'.repeat(8)}` : '…';
}

function describe(e) {
  return e && e.message ? e.message : String(e);
}

async function getContext() {
  const p = prof.profilePaths();
  const cfg = await prof.readConfig(p);
  return { p, cfg };
}

async function requireRemote({ cfg, p }) {
  if (!cfg?.repo) throw new Error('尚未配置仓库:先调用 sync_config { repo: "owner/name", token: "github_pat_…" }');
  const token = await prof.readToken(p);
  if (!token) throw new Error('尚未配置令牌:sync_config 传入 token,或设 DSH_SYNC_TOKEN/GITHUB_TOKEN 环境变量');
  return new GitHubClient({ repo: cfg.repo, token, branch: cfg.branch });
}

async function collectBundle({ p, cfg }) {
  const raw = await prof.collectLocal({ p, sections: cfg?.sections || [], cfg });
  return prof.buildBundle(raw, { p });
}

let pending = Promise.resolve();

export function makeTools() {
  const define = (tool) => ({ ...tool, output: { ...tool.output, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args) => {
    const previous = pending;
    let release;
    pending = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const result = await tool.execute(args);
      if (result.ok === false) result.detail += '\n可以询问 Agent 帮你排查：请检查 DSH 同步失败原因。';
      return result;
    } catch (error) {
      const p = prof.profilePaths();
      const token = await prof.readToken(p).catch(() => null);
      let detail = describe(error);
      if (token) detail = detail.split(token).join('[已隐藏令牌]');
      detail = detail.replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, '[已隐藏密钥]');
      return { ok: false, detail: detail + '\n可以询问 Agent 帮你排查：请检查 DSH 同步失败原因；先调用 sync_status，修正配置后重试。不要把密钥粘贴到对话中。' };
    } finally { release(); }
  } });
  return [
    define({
      name: 'sync_catalog',
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, categories: { type: 'array', items: { type: 'json' } }, detail: { type: 'string' } } } },
      description: 'Read available DSH profile sync categories and file counts without reading or returning file contents. Settings and Agent share categories. Sensitive categories default off; explain warning and get user confirmation before passing confirmSensitive=true to sync_config.',
      parameters: {},
      execute: async () => {
        const { p, cfg } = await getContext();
        const files = await inventory(p);
        return { ok: true, categories: CATEGORIES.map(c => ({ ...c, selected: cfg?.categories ? cfg.categories.includes(c.id) : (c.id === 'core' || (cfg?.sections || []).includes(c.id)), count: files.filter(f => f.category === c.id).length, bytes: files.filter(f => f.category === c.id).reduce((n, f) => n + f.bytes, 0) })), detail: WARNING };
      },
    }),
    define({
      name: 'sync_config',
      description:
        'Configure the dsh-sync plugin: store the private GitHub repo (owner/name), a token reference (tokenRef: "env:VAR" or "file:PATH" — preferred, keeps the PAT out of the chat), an optional raw PAT, branch, and the remote sub-directory prefix. The plugin-owned token file is excluded from sync; do not place copies of the GitHub PAT in other selected files. Pass token "***" (or omit) to keep the stored token; clear: true erases config and token locally. Query the current config by calling with no arguments.',
      parameters: {
        categories: { type: 'array', items: { type: 'string' }, description: 'Selected category IDs from sync_catalog; [] selects nothing. Applies to push AND pull. Unselected files are never deleted.' },
        confirmSensitive: { type: 'boolean', description: 'Set true ONLY after the user confirms the sensitive-category warning. API keys/private data will remain in GitHub history.' },
        repo: { type: 'string', description: 'GitHub repo as owner/name; private repo strongly recommended.' },
        tokenRef: { type: 'string', description: 'Reference to the token instead of pasting it here: "env:VAR_NAME" or "file:PATH", resolved at use time; only the reference is stored in config. Recommended over token. Omit to keep the stored value.' },
        token: { type: 'string', description: 'Raw fine-grained PAT, Contents Read/Write on that repo only. "***" or omit keeps the existing token. Prefer tokenRef so the secret never enters the chat.' },
        branch: { type: 'string', description: 'Branch to sync (default main).' },
        remotePrefix: { type: 'string', description: 'Sub-directory inside the repo (default dsh-sync). Use distinct prefixes per machine when sharing one repo.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Which optional parts to include in the sync set: "skills" (user skills dir) and "install-policy" (pnpm-workspace.yaml) can be added next to "core".' },
        clear: { type: 'boolean', description: 'Erase stored local config and token (the remote repo is untouched).' },
        includeSecrets: { type: 'boolean', description: 'Explicitly allow pushing files that still contain plaintext secrets (default false: scan hits abort the push). Strongly not recommended. Omit to keep the stored value.' },
        mirrorDeletes: { type: 'boolean', description: 'Sync deletions too: on push, remote files under the prefix that are absent locally are deleted in the same commit; on pull, remote-absent local skills are deleted. Default false. Omit to keep the stored value.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            config: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
            tokenStored: { type: 'boolean' },
            detail: { type: 'string' },
          },
        },
      },
      execute: async (args = {}) => {
        const p = prof.profilePaths();
        if (args.clear) {
          await prof.eraseAll(p);
          return { ok: true, config: null, tokenStored: false, detail: '已清除本机的同步配置与令牌(远端仓库内容不受影响)。' };
        }
        if (!args.repo && !Object.keys(args).some(k => k !== 'repo')) {
          const cur = await prof.readConfig(p);
          if (!cur) {
            return { ok: false, config: null, tokenStored: (await prof.readToken(p)) != null, detail: '尚无配置。请提供 repo 与令牌引用:先设好环境变量或把 PAT 存进文件,再 invoke sync_config { repo: "owner/name", tokenRef: "env:DSH_SYNC_TOKEN" }(推荐,令牌不经对话)。' };
          }
          const curToken = await prof.readToken(p);
          return { ok: true, config: cur, tokenStored: curToken != null, detail: `现有配置(令牌${curToken ? '已配置 ' + maskToken(curToken) : '未设置'}${cur.tokenRef ? ',引用=' + cur.tokenRef : ''},未改动)。` };
        }
        const previous = (await prof.readConfig(p)) || {};
        const cfg = prof.mergeConfigArgs(previous, { ...args, repo: args.repo || previous.repo });
        cfg.updatedAt = new Date().toISOString();
        await prof.saveConfig(p, cfg);
        let tokenStored;
        if (args.token === '***') {
          tokenStored = (await prof.readToken(p)) != null;
        } else if (typeof args.token === 'string' && args.token) {
          await prof.saveToken(p, args.token);
          tokenStored = true;
        } else {
          tokenStored = (await prof.readToken(p)) != null;
        }
        return {
          ok: true,
          config: { repo: cfg.repo, branch: cfg.branch, remotePrefix: cfg.remotePrefix, sections: cfg.sections, categories: cfg.categories, confirmedSensitive: cfg.confirmedSensitive, includeSecrets: cfg.includeSecrets === true, mirrorDeletes: cfg.mirrorDeletes === true, tokenRef: cfg.tokenRef || null },
          tokenStored,
          detail: tokenStored ? '配置已保存;插件自存的令牌只存本机，不参与同步。' : '配置已保存,但还没有可用令牌:推荐 sync_config { tokenRef: "env:DSH_SYNC_TOKEN" }(先设好环境变量),或直接设 DSH_SYNC_TOKEN / GITHUB_TOKEN。',
        };
      },
    }),
    define({
      name: 'sync_status',
      description:
        'Diagnose sync failures using this read-only preview before suggesting fixes. Respect selected categories; never enable sensitive categories without user confirmation. Read-only preview of what dsh-sync would do: lists the selected files (legacy configuration defaults to core and optional skills) with their sha256, and — unless remoteCheck is false — fetches the remote tree of the configured repo prefix to report per-file same/changed/only-local/only-remote. Writes nothing locally or remotely.',
      parameters: {
        remoteCheck: { type: 'boolean', description: 'Also query the remote repo (default true). Set false to inspect only the local bundle.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            files: { type: 'array', items: { type: 'json' } },
            diff: { oneOf: [{ type: 'array', items: { type: 'json' } }, { type: 'null' }] },
            detail: { type: 'string' },
          },
        },
      },
      execute: async (args = {}) => {
        const { p, cfg } = await getContext();
        const localFiles = await collectBundle({ p, cfg });
        const files = localFiles.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: fileBytes(f).length }));
        const switches = `当前开关:${prof.describeSwitches(cfg)}(经 sync_config 修改)。`;
        if (args.remoteCheck === false) {
          return { ok: true, files, diff: null, detail: '仅本地检查(未访问远端)。' + switches };
        }
        const client = await requireRemote({ cfg, p });
        const prefix = prof.normalizePrefix(cfg.remotePrefix);
        const remote = await client.listPrefix({ prefix });
        if (remote.emptyRepo) {
          return { ok: true, files, diff: null, detail: `远端 ${cfg.repo} 的 ${prefix}/ 还是空的:sync_push 即可首次建立。` + switches };
        }
        const remoteContents = await client.getFiles(remote.files.filter(f => f.rel !== 'manifest.json' && (!Array.isArray(cfg.categories) || selected(f.rel, cfg))));
        const remoteMap = Object.fromEntries(remoteContents.map((f) => [f.path, createHash('sha256').update(fileBytes(f)).digest('hex')]));
        const localMap = Object.fromEntries(localFiles.files.map((f) => [f.path, f.sha256]));
        const diff = prof.diffMaps(localMap, remoteMap);
        const changed = diff.filter((d) => d.state !== 'same').length;
        return {
          ok: true,
          files,
          diff,
          detail:
            (changed === 0 ? '本地与远端一致。' : `本地与远端有 ${changed} 个文件不同(明细见 diff)。push=以本机为准,pull=以远端为准(先备份)。`) +
            switches,
        };
      },
    }),
    define({
      name: 'sync_push',
      description:
        'Push local DSH config to the configured private GitHub repo as ONE commit (local wins). Before ANY network call the selected content is scanned for plaintext secrets (sk-…, ghp_…, github_pat_…, AKIA…, PEM blocks); a hit aborts the push and nothing is sent — remove the secret or explicitly confirm the relevant sensitive category, or set includeSecrets=true via sync_config after user confirmation. Remote files under the prefix absent locally are deleted in the same commit when mirrorDeletes is on (skills only). A ref conflict (repo pushed in between) aborts; sync_pull first, never force.',
      parameters: {
        message: { type: 'string', description: 'Optional commit message; a default with profile, host and timestamp is used otherwise.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            commitUrl: { type: 'string' },
            pushed: { type: 'array', items: { type: 'json' } },
            scanned: { type: 'integer' },
            warnings: { type: 'array', items: { type: 'json' } },
            detail: { type: 'string' },
          },
        },
      },
      execute: async (args = {}) => {
        const { p, cfg } = await getContext();
        const client = await requireRemote({ cfg, p });
        const res = await performPush({ p, cfg, client, message: args?.message });
        if (!res.ok && res.stage !== 'secret-scan') return { ok: false, detail: res.detail || '同步失败，请检查配置。' };
        if (res.stage === 'secret-scan') {
          return {
            ok: false,
            scanned: res.scanned,
            warnings: [],
            detail:
              `明文密钥扫描命中 ${res.hits.length} 处,push 已拒绝且未发出任何网络请求。\n` +
              res.hits
                .slice(0, 20)
                .map((h) => `- ${h.file}:${h.line} ${h.label}`)
                .join('\n') +
              '\n处理:把明文移出同步文件(密钥请在 DSH 凭证里用 apiKeyEnv 引用);确实要带上(强烈不建议)时在 sync_config 设 includeSecrets=true。',
          };
        }
        return {
          ok: true,
          commitUrl: res.commitUrl,
          pushed: [...res.pushed, ...res.deletions.map((d) => ({ path: d, op: 'delete' }))],
          scanned: res.scanned,
          warnings: res.warnings,
          detail:
            res.warnings.length > 0
              ? `已推送(警告:用户已确认允许同步的内容含 ${res.warnings.length} 处明文,建议尽快撤销该内容并轮换密钥)。`
              : `已推送 ${res.pushed.length} 个文件(单次提交)。`,
        };
      },
    }),
    define({
      name: 'sync_pull',
      description:
        'Pull config from the configured repo sub-directory and apply it locally (remote wins). Every local file about to be overwritten is first copied to profile/.dsh-sync/backups/<timestamp>/ and byte-verified; a failed backup aborts BEFORE any write, so the pull is always rollback-able (copy files back). dryRun: true reports the per-file diff without writing. Skills files missing remotely are deleted only when mirrorDeletes is on. NOTE: pull writes config files only — it does NOT install the plugin packages themselves; on a fresh machine reinstall them (plugin market or pnpm) using remote manifest.json installList as the checklist, and recreate any file:/link: local-path dependencies manually. Restart DSH afterwards for changes to take effect.',
      parameters: {
        dryRun: { type: 'boolean', description: 'Preview only: report what would change without touching disk (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            dryRun: { type: 'boolean' },
            toWrite: { type: 'array', items: { type: 'json' } },
            toAdd: { type: 'array', items: { type: 'json' } },
            toDelete: { type: 'array', items: { type: 'json' } },
            applied: { type: 'array', items: { type: 'json' } },
            backupDir: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            detail: { type: 'string' },
          },
        },
      },
      execute: async (args = {}) => {
        const { p, cfg } = await getContext();
        const client = await requireRemote({ cfg, p });
        const res = await performPull({ p, cfg, client, dryRun: args?.dryRun === true });
        if (res.stage === 'remote-empty') {
          return { ok: false, dryRun: args?.dryRun === true, detail: `远端 ${cfg.repo}@${cfg.branch} 的 ${prof.normalizePrefix(cfg.remotePrefix)}/ 为空,没有东西可拉:先 sync_push。` };
        }
        if (res.dryRun) {
          const n = res.toWrite.length + res.toAdd.length + res.toDelete.length;
          return {
            ok: true,
            dryRun: true,
            toWrite: res.toWrite,
            toAdd: res.toAdd,
            toDelete: res.toDelete,
            applied: [],
            backupDir: null,
            detail: n === 0 ? 'dryRun:本地已与远端一致。' : `dryRun:将覆盖 ${res.toWrite.length}、新增 ${res.toAdd.length}、删除 ${res.toDelete.length}(未写盘)。去掉 dryRun 执行,旧的先备份。`,
          };
        }
        return {
          ok: true,
          dryRun: false,
          applied: res.written.map((w) => ({ path: w.path, backedUp: w.backedUp })),
          backupDir: res.backupDir,
          detail:
            `已应用 ${res.written.length} 个文件${res.deleted.length ? `,删除 ${res.deleted.length}` : ''}。` +
            (res.backupDir ? `旧文件已备份到 ${res.backupDir},回滚=把对应文件复制回 profile 目录。` : '') +
            (res.retentionNote ? ' ' + res.retentionNote : '') +
            '插件本体不会被 pull 安装,按远端 manifest.json 的 installList 清单补装;重启 DSH 后生效。',
        };
      },
    }),
  ];
}
