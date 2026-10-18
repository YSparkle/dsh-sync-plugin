// Run against the actual DSH SDK installed in the host/profile, or an explicit SDK entry.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeTools } from '../src/tools.js';
const { defineTool, validateJsonSchemaValue } = await import(process.env.DSH_SYNC_SDK_ENTRY || '@deepseek-ai/dsh-tools');
const definitions = makeTools();
const samples = {
  sync_catalog: { ok: true, categories: [], detail: 'test' },
  sync_config: { ok: false, config: null, tokenStored: false, detail: 'test' },
  sync_status: { ok: true, files: [], diff: null, detail: 'test' },
  sync_push: { ok: false, detail: 'test' },
  sync_pull: { ok: true, dryRun: true, toWrite: [], toAdd: [], toDelete: [], applied: [], backupDir: null, detail: 'test' },
};
for (const definition of definitions) {
  const tool = defineTool(definition); // Rejects invalid DSL nodes at registration time.
  const result = samples[definition.name]; // Never execute push/pull during an SDK contract check.
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, ''), [], definition.name);
  const blocks = tool.output.render({}, result);
  assert.equal(blocks[0].type, 'text'); assert.doesNotThrow(() => JSON.parse(blocks[0].text));
}
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
assert(patch.includes(`name: '${pkg.name}'`));
let client;
vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { client = value; } } } });
assert.equal(client.id, pkg.name);
const registrations = [];
client.factory(() => ({})).apply({ slots: { inject(_name, fn) { fn(); }, register(options) { registrations.push(options); } } });
assert.equal(registrations.find(r => r.name === 'settings.plugins.tab').id, 'dsh-sync');
assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '0.2.0-rc.2');
console.log('PASS: rc.2 SDK tool registration, output validation/rendering, bundle and client package IDs');
