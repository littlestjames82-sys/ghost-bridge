import { getStore } from '@netlify/blobs';
import { createHandler } from '../../core.mjs';

let handler = null;
function getHandler() {
  if (!handler) {
    // Prefer explicit Blobs credentials (site id + a no-expiry token from
    // the BRIDGE_BLOBS_TOKEN env var). The platform-injected Blobs context
    // token from a CLI deploy expires (~1h) and then every store call 500s
    // with "Failed to decode token: Token expired" — learned live Oct 6.
    // Set BRIDGE_BLOBS_SITE_ID to YOUR Netlify site id and BRIDGE_BLOBS_TOKEN
    // to a personal access token with Blobs access on your own account.
    const opts = { name: 'ghost-bridge' };
    if (process.env.BRIDGE_BLOBS_TOKEN) {
      if (process.env.BRIDGE_BLOBS_SITE_ID) opts.siteID = process.env.BRIDGE_BLOBS_SITE_ID;
      opts.token = process.env.BRIDGE_BLOBS_TOKEN;
    }
    const blobs = getStore(opts);
    const store = {
      // Netlify Blobs is eventually consistent by default; the bridge relies
      // on read-after-write (claim a task, see it claimed), so reads use
      // strong consistency.
      get: async k => { const v = await blobs.get(k, { consistency: 'strong' }); return v == null ? null : v; },
      set: async (k, v) => { await blobs.set(k, v); },
      del: async k => { await blobs.delete(k); }
    };
    handler = createHandler(store, process.env);
  }
  return handler;
}

export default async req => {
  const url = new URL(req.url);
  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  const out = await getHandler()({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, bodyText });
  return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), {
    status: out.status,
    headers: { 'Content-Type': out.contentType || 'application/json', ...(out.headers || {}) }
  });
};

export const config = { path: ['/probe', '/health', '/metrics', '/setup', '/setup/reset', '/api/*', '/mcp'] };
