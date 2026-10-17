// Standalone Cloudflare Worker entry: the same handler as the website's Pages Function, at /p.
// Config in proxy/wrangler.toml (no public address, no logs).
import { handle, type ProxyEnv } from './proxy.ts';

export default {
  fetch(req: Request, env: ProxyEnv): Promise<Response> | Response {
    if (new URL(req.url).pathname !== '/p') return new Response('not found', { status: 404 });
    return handle(req, env);
  },
};
