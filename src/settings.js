import { makeTools } from './tools.js';

const ROUTE = '/api/dsh-sync';
export function makeSettingsRoute() {
  const tools = new Map(makeTools().map(t => [t.name, t]));
  return { kind: 'exact', path: ROUTE, handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    // JSON-only POST plus Origin validation prevents cross-site writes.
    if (req.method !== 'POST') return send(405, { ok: false, detail: '仅支持 POST' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { ok: false, detail: '需要 JSON' });
    try {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(403, { ok: false, detail: '来源不匹配' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { ok: false, detail: '来源不匹配' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) return send(413, { ok: false, detail: '请求过大' });
      }
      const body = JSON.parse(raw);
      const tool = tools.get(body.tool);
      if (!tool) return send(400, { ok: false, detail: '未知操作' });
      return send(200, await tool.execute(body.args || {}));
    } catch { return send(400, { ok: false, detail: '请求失败，可以询问 Agent 帮你排查。' }); }
  } };
}
