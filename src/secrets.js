// secrets.js —— 明文密钥扫描（push 前的最后防线），零依赖。
// 口径（secret_scan 度量,单位 hits）：对同步集全部文本逐行匹配模式表,
// 返回命中 {file, line, label}。工具层在 includeSecrets≠true 且命中>0 时
// 拒发任何网络请求（secret_scan_reject）。

export const SECRET_PATTERNS = Object.freeze([
  { label: 'OpenAI/DSH 风格 API key (sk-…16+)', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'GitHub classic PAT (ghp_…)', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { label: 'GitHub fine-grained PAT (github_pat_…)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'GitHub OAuth/user/server/refresh (gho_/ghu_/ghs_/ghr_)', re: /\bgh[ousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'AWS Access Key (AKIA…)', re: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: 'Slack token (xox…)', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'PEM 私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]);

/** 单段文本逐行扫描。@returns {Array<{line: number, label: string}>} */
export function scanText(text) {
  const hits = [];
  if (typeof text !== 'string') return hits;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(lines[i])) hits.push({ line: i + 1, label });
    }
  }
  return hits;
}

/**
 * 扫描整个 bundle。默认命中即拒绝(rejected=true,不发任何请求);
 * includeSecrets=true 时放行但给出逐条警告(不建议)。
 */
export function scanBundle(bundle, { includeSecrets = false } = {}) {
  const hits = [];
  for (const f of bundle.files || []) {
    for (const h of scanText(f.encoding === 'base64' ? Buffer.from(f.text, 'base64').toString('utf8') : f.text)) hits.push({ file: f.path, line: h.line, label: h.label });
  }
  const any = hits.length > 0;
  return {
    includeSecrets: Boolean(includeSecrets),
    hits,
    rejected: any && !includeSecrets,
    warnings: any && includeSecrets ? hits.map((h) => `${h.file}:${h.line} ${h.label}`) : [],
  };
}
