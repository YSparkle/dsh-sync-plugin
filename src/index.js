import { makeSettingsRoute } from './settings.js';
import { makeTools } from './tools.js';

export const name = 'dsh-sync';
// The UI/API must mount even when this scope has no Agent tools service.
export const inject = [];

export function apply(ctx) {
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register(makeSettingsRoute()), 'dsh-sync: settings API');
  });
  ctx.inject(['tools'], async toolsCtx => {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    toolsCtx.effect(() => {
      const disposers = makeTools().map(tool => toolsCtx.tools.register(defineTool(tool)));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, 'dsh-sync: Agent tools');
  });
}
