// github.js —— 零依赖 GitHub REST 客户端（可注入 fetchImpl 供自检 mock）。
// 只用 Git Data API：refs / commits / trees / blobs；一次 push 一个 commit。
// 仓库内只读写 remotePrefix 子目录,其余内容不动（design.md ②③）。

export const API_BASE = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-sync-plugin/0.2.2',
  };
}

/** 非 2xx → 人话报错。 */
export function humanizeStatus(status, bodyText, apiPath) {
  const b = (bodyText || '').slice(0, 400);
  if (status === 401) return `GitHub 401:令牌无效或已过期(${apiPath})`;
  if (status === 403) return `GitHub 403:无权限。请确认该 fine-grained PAT 授了本仓库 Contents: Read/Write(${apiPath})`;
  if (status === 404) return `GitHub 404:没有找到 ${apiPath}。请确认 repo 与 branch 拼写无误;全新仓库或全新分支要先完成一次 sync_push 首推,之后 pull/status 才有东西可读。`;
  if (status === 409 || status === 422) {
    if (/fast.?forward/i.test(b)) {
      return `GitHub ${status}:ref 冲突——远端分支在推送间隙被别的提交更新过。请先 sync_pull 再重试(不允许 force)。${b}`;
    }
    return `GitHub ${status}:${b}(${apiPath})`;
  }
  return `GitHub ${status}:${b}(${apiPath})`;
}

export class GitHubClient {
  /** @param {{repo: string, token: string, branch?: string, apiBase?: string, fetchImpl?: typeof fetch}} opts */
  constructor(opts) {
    if (!opts?.repo || !/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) throw new Error('repo 必须形如 owner/name');
    if (!opts?.token) throw new Error('缺少令牌:先用 sync_config 配置,或设 DSH_SYNC_TOKEN/GITHUB_TOKEN');
    this.repo = opts.repo;
    this.token = opts.token;
    this.branch = opts.branch || 'main';
    this.apiBase = opts.apiBase || API_BASE;
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  /** 统一请求。allow404=true 时 404 返回 null；allow409Empty=true 时 409「Git Repository is empty.」（完全空仓库的真实表现）同 404 处理。 */
  async gh(apiPath, { method = 'GET', body, allow404 = false, allow409Empty = false } = {}) {
    const res = await this.fetchImpl(this.apiBase + apiPath, {
      method,
      headers: headers(this.token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 404 && allow404) return null;
    if (res.status === 409 && allow409Empty && /is empty/i.test(text)) return null;
    if (!res.ok) throw new Error(humanizeStatus(res.status, text, apiPath));
    return text ? JSON.parse(text) : {};
  }

  /** 分支头 commit sha;分支/仓库为空返回 null（404 与 409 空仓库都算空）。 */
  async getHead() {
    const ref = await this.gh(`/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`, { allow404: true, allow409Empty: true });
    return ref ? ref.object.sha : null;
  }

  async getCommitTree(sha) {
    return (await this.gh(`/repos/${this.repo}/git/commits/${sha}`)).tree.sha;
  }

  /**
   * 递归列出 remotePrefix 下的文件。
   * @returns {{headSha: string|null, treeSha: string|null, emptyRepo: boolean,
   *            files: Array<{rel: string, sha: string, size: number}>}}
   */
  async listPrefix({ prefix }) {
    const pre = String(prefix).replace(/\/+$/, '');
    const headSha = await this.getHead();
    if (!headSha) return { headSha: null, treeSha: null, files: [], emptyRepo: true };
    const treeSha = await this.getCommitTree(headSha);
    const tree = await this.gh(`/repos/${this.repo}/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) throw new Error('远端树过大(GitHub truncated),请把同步前缀指到独立仓库,勿与巨型仓库共用');
    const files = [];
    for (const t of tree.tree || []) {
      if (t.type !== 'blob') continue;
      if (!t.path.startsWith(pre + '/')) continue;
      const rel = t.path.slice(pre.length + 1);
      files.push({ rel, sha: t.sha, size: t.size ?? 0 });
    }
    return { headSha, treeSha, files, emptyRepo: false };
  }

  /** 下载若干 blob 并解码为文本。@returns {Array<{path: string, text: string}>} */
  async getFiles(entries) {
    const out = [];
    for (const e of entries) {
      const blob = await this.gh(`/repos/${this.repo}/git/blobs/${e.sha}`);
      const data = Buffer.from(blob.content || '', 'base64');
      const text = data.toString('utf8');
      out.push(Buffer.from(text).equals(data) ? { path: e.rel, text } : { path: e.rel, text: data.toString('base64'), encoding: 'base64' });
    }
    return out;
  }

  /**
   * 一次 commit 推送。
   * @param files     [{path(相对前缀), text}]
   * @param deletions [相对前缀路径] —— 树里置 sha:null 删除
   */
  async putFiles({ prefix, files, deletions = [], message }) {
    const pre = String(prefix).replace(/\/+$/, '');
    let headSha = await this.getHead();
    // 完全空仓库:连 POST /git/trees 都回 409「Git Repository is empty.」(真实仓库实测,
    // 2026-10)。先用 Contents API 落第一个文件造出基线 commit(同时创建默认分支),
    // 再走正常 Git Data 流程;最终配置仍是一个 commit。
    if (headSha === null && files.length > 0) {
      const seed = files[0];
      const seeded = await this.gh(`/repos/${this.repo}/contents/${pre ? `${pre}/` : ''}${seed.path}`, {
        method: 'PUT',
        body: {
          message: `${message} (first-commit bootstrap via dsh-sync)`,
          content: Buffer.from(seed.text, seed.encoding === 'base64' ? 'base64' : 'utf8').toString('base64'),
          branch: this.branch,
        },
      });
      headSha = seeded?.commit?.sha || (await this.getHead());
      if (headSha === null) throw new Error('空仓库引导失败:Contents API 已提交但拿不到新分支头');
    }
    const baseTree = headSha ? await this.getCommitTree(headSha) : undefined;
    const tree = [];
    for (const f of files) {
      const entry = { path: pre ? `${pre}/${f.path}` : f.path, mode: '100644', type: 'blob' };
      if (f.encoding === 'base64') {
        const blob = await this.gh(`/repos/${this.repo}/git/blobs`, { method: 'POST', body: { content: f.text, encoding: 'base64' } });
        entry.sha = blob.sha;
      } else entry.content = f.text;
      tree.push(entry);
    }
    for (const rel of deletions) {
      tree.push({ path: pre ? `${pre}/${rel}` : rel, mode: '100644', type: 'blob', sha: null });
    }
    const t = await this.gh(`/repos/${this.repo}/git/trees`, {
      method: 'POST',
      body: baseTree ? { base_tree: baseTree, tree } : { tree },
    });
    const commit = await this.gh(`/repos/${this.repo}/git/commits`, {
      method: 'POST',
      body: { message, tree: t.sha, parents: headSha ? [headSha] : [] },
    });
    const refPath = `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`;
    try {
      await this.gh(refPath, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    } catch (e) {
      const msg = String(e?.message || '');
      if (/GitHub 404:/.test(msg) || /Reference does not exist/i.test(msg)) {
        // ref 不存在(被并发删除等;bootstrap 后首推的 ref 已存在):POST 建 ref。
        // 这不是 force——若 ref 被并发创建,POST 会 422 原样暴露。
        await this.gh(`/repos/${this.repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${this.branch}`, sha: commit.sha } });
      } else {
        throw e;
      }
    }
    return { commitSha: commit.sha, commitUrl: commit.html_url, treeSha: t.sha };
  }
}
