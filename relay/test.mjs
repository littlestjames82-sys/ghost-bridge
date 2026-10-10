// Ghost Bridge Relay — self-test against the local server (in-memory store).
// Run: node test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { createHandler } from './core.mjs';

const results = [];
function check(name, cond, detail) {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + (detail || '')}`);
}

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-bridge-key-0123456789abcdef';
const child = spawn('node', ['local-server.mjs', String(PORT)], {
  cwd: new URL('.', import.meta.url).pathname,
  env: { ...process.env, BRIDGE_SETUP_SECRET: 'test-setup-secret' },
  stdio: ['ignore', 'ignore', 'pipe']
});
await new Promise(r => setTimeout(r, 700));

async function call(method, path, { key, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-bridge-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, data, headers: res.headers };
}

try {
  const probe0 = await call('GET', '/probe');
  check('probe unauthenticated, zero counts', probe0.status === 200 && probe0.data.queued === 0, JSON.stringify(probe0.data));
  const noauth = await call('GET', '/api/tasks');
  check('api requires key before setup', noauth.status === 401, String(noauth.status));
  const badSetup = await call('POST', '/setup', { body: { key: KEY, setupSecret: 'wrong' } });
  check('setup rejects wrong secret', badSetup.status === 403, String(badSetup.status));
  const setup = await call('POST', '/setup', { body: { key: KEY, setupSecret: 'test-setup-secret' } });
  check('setup registers key', setup.status === 200 && setup.data.ok, JSON.stringify(setup.data));
  const setup2 = await call('POST', '/setup', { body: { key: 'another-key-0123456789abcdef', setupSecret: 'test-setup-secret' } });
  check('second setup is locked out (409)', setup2.status === 409, String(setup2.status));
  const wrongKey = await call('GET', '/api/tasks', { key: 'nope-nope-nope-nope' });
  check('wrong key rejected (401)', wrongKey.status === 401, String(wrongKey.status));

  const t1 = await call('POST', '/api/tasks', { key: KEY, body: { title: 'First task', body: 'Do the thing.', project: 'ghostcut', priority: 'urgent' } });
  check('create task -> id 1, urgent label', t1.status === 201 && t1.data.id === 1 && t1.data.labels.includes('urgent'), JSON.stringify(t1.data).slice(0, 120));
  const probe1 = await call('GET', '/probe');
  check('probe counts the queued urgent task', probe1.data.queued === 1 && probe1.data.urgent === 1, JSON.stringify(probe1.data));
  const note = await call('POST', '/api/tasks', { key: KEY, body: { title: '[Note] hi', body: 'A note.', type: 'note' } });
  check('note created with ghost-note label', note.status === 201 && note.data.labels.includes('ghost-note'), JSON.stringify(note.data).slice(0, 120));
  const list = await call('GET', '/api/tasks?state=open', { key: KEY });
  check('list open returns both', list.data.tasks.length === 2, String(list.data.tasks.length));
  const comment = await call('POST', '/api/tasks/1/comments', { key: KEY, body: { body: 'Claimed.', author: 'mrghosty' } });
  check('comment lands on task', comment.status === 201 && comment.data.comments.length === 1, JSON.stringify(comment.data).slice(0, 120));
  const claim = await call('PATCH', '/api/tasks/1', { key: KEY, body: { status: 'in-progress' } });
  check('patch to in-progress; probe drops it', claim.data.status === 'in-progress' && claim.data.labels.includes('in-progress'));
  const probe2 = await call('GET', '/probe');
  check('probe queued back to 0 after claim', probe2.data.queued === 0 && probe2.data.notes === 1, JSON.stringify(probe2.data));
  const badPatch = await call('PATCH', '/api/tasks/1', { key: KEY, body: { status: 'bogus' } });
  check('invalid status rejected (400)', badPatch.status === 400, String(badPatch.status));
  const done = await call('PATCH', '/api/tasks/1', { key: KEY, body: { status: 'done' } });
  check('patch to done sets closedAt', done.data.status === 'done' && !!done.data.closedAt);

  const filePut = await call('PUT', '/api/files', { key: KEY, body: { path: 'capsules/ghostcut.md', text: '# Capsule — GhostCut\n\n## State\nTesting.' } });
  const fileGet = await call('GET', '/api/files?path=' + encodeURIComponent('capsules/ghostcut.md'), { key: KEY });
  check('files round-trip', filePut.status === 200 && fileGet.data.text.includes('Testing.'), JSON.stringify(fileGet.data).slice(0, 80));
  const fileList = await call('GET', '/api/files/list', { key: KEY });
  check('files list', fileList.data.files.includes('capsules/ghostcut.md'));
  const ctxPut = await call('PUT', '/api/context', { key: KEY, body: { profile: { assistant: 'Mr.Ghosty' }, projects: [{ name: 'GhostCut', slug: 'ghostcut', status: 'Working', summary: 'Editor.' }], rules: ['Rule one.'], updated: '2026-10-06' } });
  const ctxGet = await call('GET', '/api/context', { key: KEY });
  check('context round-trip', ctxPut.status === 200 && ctxGet.data.projects[0].slug === 'ghostcut');

  // Hosted MCP
  const mcp = async (method, params) => (await call('POST', '/mcp', { key: KEY, body: { jsonrpc: '2.0', id: 1, method, params } })).data;
  const init = await mcp('initialize', { protocolVersion: '2024-11-05' });
  check('mcp initialize', init.result?.serverInfo?.version === '4.4.0', JSON.stringify(init).slice(0, 100));
  const tools = await mcp('tools/list', {});
  check('mcp tools/list = 17 tools', tools.result?.tools?.length === 17, String(tools.result?.tools?.length));
  const toolCall = async (name, args) => { const r = await mcp('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text || ''; };
  const status = await toolCall('ghost_bridge_status', {});
  check('mcp ghost_bridge_status counts done/open', status.includes('Ghost Bridge Relay v4.4.0'), status.slice(0, 80));
  const hand = await toolCall('ghost_handoff', { title: 'MCP task', task: 'Via hosted MCP.', project: 'ghostcut' });
  check('mcp ghost_handoff files task 3', hand.includes('relay #3'), hand.slice(0, 80));
  const dup = await toolCall('ghost_handoff', { title: 'MCP task', task: 'Duplicate.' });
  check('mcp duplicate guard blocks same title', dup.includes('already exists'), dup.slice(0, 80));
  const cap = await toolCall('ghost_capsule', { project: 'ghostcut' });
  check('mcp ghost_capsule reads relay file', cap.includes('Capsule — GhostCut'), cap.slice(0, 60));
  const inbox = await toolCall('ghost_inbox', {});
  check('mcp ghost_inbox lists tasks', inbox.includes('#3 [queued] MCP task'), inbox.slice(0, 100));
  const result = await toolCall('ghost_task_result', { issue: 1 });
  check('mcp ghost_task_result shows thread', result.includes('Claimed.'), result.slice(0, 80));
  const board = await toolCall('ghost_board', {});
  check('mcp ghost_board generates', board.includes('## Done (last 7 days)') && board.includes('First task'), board.slice(0, 100));

  // ---------- v4: health, multi-key, events, attachments, structured results ----------
  const health = await call('GET', '/health');
  check('v4 health unauthenticated with version + counts', health.status === 200 && health.data.version === '4.4.0' && typeof health.data.queued === 'number', JSON.stringify(health.data));

  const KEY2 = 'second-client-key-0123456789abcdef';
  const addKey = await call('POST', '/api/keys', { key: KEY, body: { name: 'cursor-laptop', key: KEY2 } });
  check('v4 register second named key', addKey.status === 201 && addKey.data.name === 'cursor-laptop', JSON.stringify(addKey.data));
  const listKeys = await call('GET', '/api/keys', { key: KEY });
  check('v4 list keys shows names, no hashes', listKeys.data.keys?.length === 2 && listKeys.data.keys.some(k => k.name === 'primary') && listKeys.data.keys.some(k => k.name === 'cursor-laptop') && !JSON.stringify(listKeys.data).includes('hash'), JSON.stringify(listKeys.data));
  const viaKey2 = await call('GET', '/api/tasks', { key: KEY2 });
  check('v4 second key authenticates', viaKey2.status === 200, String(viaKey2.status));
  const dupKey = await call('POST', '/api/keys', { key: KEY, body: { name: 'cursor-laptop', key: 'whatever-key-0123456789abcdef0' } });
  check('v4 duplicate key name rejected (409)', dupKey.status === 409, String(dupKey.status));

  const evAll = await call('GET', '/api/events?since=0', { key: KEY });
  check('v4 events log has the task.created events', evAll.status === 200 && evAll.data.events.some(e => e.type === 'task.created' && e.taskId === 1), JSON.stringify(evAll.data).slice(0, 140));
  const sinceSeq = evAll.data.lastSeq;
  const attB64 = Buffer.from('hello attachment').toString('base64');
  const attTask = await call('POST', '/api/tasks', { key: KEY2, body: { title: 'Attachment task', body: 'See attached.', attachments: [{ name: 'note.txt', mime: 'text/plain', dataBase64: attB64 }, { name: 'shot.png', mime: 'image/png', path: 'uploads/shot.png', size: 1234 }] } });
  check('v4 task with attachments created', attTask.status === 201 && attTask.data.attachments?.length === 2 && attTask.data.attachments[0].size === 16, JSON.stringify(attTask.data).slice(0, 200));
  const attGet = await call('GET', `/api/tasks/${attTask.data.id}`, { key: KEY });
  check('v4 attachment round-trips (inline data intact)', attGet.data.attachments?.[0]?.dataBase64 === attB64 && attGet.data.attachments?.[1]?.path === 'uploads/shot.png', JSON.stringify(attGet.data.attachments).slice(0, 140));
  const tooBig = await call('POST', '/api/tasks', { key: KEY, body: { title: 'Too big', body: 'x', attachments: [{ name: 'big.bin', dataBase64: Buffer.alloc(300 * 1024).toString('base64') }] } });
  check('v4 oversize inline attachment rejected (400)', tooBig.status === 400, String(tooBig.status));

  const resComment = await call('POST', `/api/tasks/${attTask.data.id}/comments`, { key: KEY, body: { body: 'Done — see report.', author: 'mrghosty', result: { status: 'done', summary: 'All checks green', files: ['reports/out.md'] } } });
  check('v4 comment carries structured result', resComment.status === 201 && resComment.data.comments.at(-1)?.result?.summary === 'All checks green', JSON.stringify(resComment.data).slice(0, 160));
  const resPatch = await call('PATCH', `/api/tasks/${attTask.data.id}`, { key: KEY, body: { status: 'done', result: { status: 'done', summary: 'Wrapped up', files: [] } } });
  check('v4 patch stores task-level structured result', resPatch.data.result?.summary === 'Wrapped up', JSON.stringify(resPatch.data.result || {}));

  const evNew = await call('GET', `/api/events?since=${sinceSeq}`, { key: KEY });
  check('v4 long-poll since returns only newer events', evNew.data.events.length >= 3 && evNew.data.events.every(e => e.seq > sinceSeq) && evNew.data.events.some(e => e.type === 'task.comment'), JSON.stringify(evNew.data.events.map(e => e.type)));

  // SSE stream on the local server: connect, then create a task, expect the event line.
  const sseText = await new Promise(async resolve => {
    let buf = '';
    const req = http.get(BASE + '/api/events/stream', { headers: { 'x-bridge-key': KEY } }, res => {
      res.on('data', c => { buf += c.toString(); if (buf.includes('task.created') && buf.includes('SSE task')) { req.destroy(); resolve(buf); } });
    });
    req.on('error', () => resolve(buf));
    setTimeout(async () => { await call('POST', '/api/tasks', { key: KEY, body: { title: 'SSE task', body: 'wake up' } }); }, 400);
    setTimeout(() => { req.destroy(); resolve(buf); }, 8000);
  });
  check('v4 SSE stream delivers task.created live', sseText.includes('event: task.created') && sseText.includes('SSE task'), sseText.slice(0, 120));

  const revoke = await call('DELETE', '/api/keys/cursor-laptop', { key: KEY });
  check('v4 revoke second key', revoke.status === 200 && revoke.data.revoked === 'cursor-laptop', JSON.stringify(revoke.data));
  const revokedAuth = await call('GET', '/api/tasks', { key: KEY2 });
  check('v4 revoked key gets 401', revokedAuth.status === 401, String(revokedAuth.status));
  const stillOk = await call('GET', '/api/tasks', { key: KEY });
  check('v4 primary key unaffected by revoke', stillOk.status === 200, String(stillOk.status));

  // ---------- v4: legacy v3 single-key config auto-migration (direct handler) ----------
  {
    const mem = new Map();
    const legacyKey = 'legacy-single-key-0123456789abcdef';
    const legacyHash = crypto.createHash('sha256').update(legacyKey).digest('hex');
    mem.set('config', JSON.stringify({ keyHash: legacyHash, createdAt: '2026-10-06T00:00:00Z' }));
    const h = createHandler({
      get: async k => (mem.has(k) ? mem.get(k) : null),
      set: async (k, v) => { mem.set(k, v); },
      del: async k => { mem.delete(k); }
    }, { BRIDGE_SETUP_SECRET: 'test-setup-secret' });
    const r = await h({ method: 'GET', path: '/api/tasks', query: {}, headers: { 'x-bridge-key': legacyKey }, bodyText: '' });
    check('v4 legacy keyHash key still authenticates', r.status === 200, String(r.status));
    const cfgAfter = JSON.parse(mem.get('config'));
    check('v4 legacy config migrated to named key "primary"', Array.isArray(cfgAfter.keys) && cfgAfter.keys.length === 1 && cfgAfter.keys[0].name === 'primary' && cfgAfter.keys[0].hash === legacyHash && !('keyHash' in cfgAfter), JSON.stringify(Object.keys(cfgAfter)));
  }

  // ---------- v4: webhook receiver stub gets a POST per event ----------
  {
    const hits = [];
    const hook = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { hits.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('ok'); }); });
    await new Promise(r => hook.listen(0, '127.0.0.1', r));
    const wPort = 8898;
    const wchild = spawn('node', ['local-server.mjs', String(wPort)], {
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...process.env, BRIDGE_SETUP_SECRET: 'test-setup-secret', GHOST_BRIDGE_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/hook` },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    await new Promise(r => setTimeout(r, 700));
    const wkey = 'webhook-test-key-0123456789abcdef';
    await fetch(`http://127.0.0.1:${wPort}/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: wkey, setupSecret: 'test-setup-secret' }) });
    await fetch(`http://127.0.0.1:${wPort}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-key': wkey }, body: JSON.stringify({ title: 'Webhook task', body: 'ping the hook' }) });
    await new Promise(r => setTimeout(r, 600));
    check('v4 webhook receiver got task.created POST', hits.some(h => h.type === 'task.created' && h.title === 'Webhook task'), JSON.stringify(hits.map(h => h.type)));
    wchild.kill(); hook.close();
  }

  // ---------- v4.1: scoped keys, claim leases, idempotent handoffs, health detail ----------
  const health2 = await call('GET', '/health');
  check('v4.1 health reports byStatus + key count + event size, no key material', health2.status === 200 && typeof health2.data.byStatus?.queued === 'number' && health2.data.keys === 1 && typeof health2.data.events === 'number' && !JSON.stringify(health2.data).includes('hash'), JSON.stringify(health2.data));

  const RO_KEY = 'readonly-client-key-0123456789abcdef';
  const mintRo = await call('POST', '/api/keys', { key: KEY, body: { name: 'ro-client', key: RO_KEY, scope: 'readonly' } });
  check('v4.1 mint readonly key stores scope', mintRo.status === 201 && mintRo.data.scope === 'readonly', JSON.stringify(mintRo.data));
  const keysWithRo = await call('GET', '/api/keys', { key: KEY });
  check('v4.1 key list shows scopes (primary full, ro readonly)', keysWithRo.data.keys.find(k => k.name === 'primary')?.scope === 'full' && keysWithRo.data.keys.find(k => k.name === 'ro-client')?.scope === 'readonly', JSON.stringify(keysWithRo.data.keys));
  const badScope = await call('POST', '/api/keys', { key: KEY, body: { name: 'bad-scope', key: 'whatever-key-0123456789abcdef0', scope: 'admin' } });
  check('v4.1 invalid scope rejected (400)', badScope.status === 400, String(badScope.status));

  const roList = await call('GET', '/api/tasks?state=all', { key: RO_KEY });
  check('v4.1 readonly can list tasks', roList.status === 200 && Array.isArray(roList.data.tasks), String(roList.status));
  const roGet = await call('GET', '/api/tasks/1', { key: RO_KEY });
  const roCtx = await call('GET', '/api/context', { key: RO_KEY });
  const roFiles = await call('GET', '/api/files/list', { key: RO_KEY });
  const roEvents = await call('GET', '/api/events?since=0', { key: RO_KEY });
  check('v4.1 readonly can read task/context/files/events', roGet.status === 200 && roCtx.status === 200 && roFiles.status === 200 && roEvents.status === 200, [roGet.status, roCtx.status, roFiles.status, roEvents.status].join(','));
  const roCreate = await call('POST', '/api/tasks', { key: RO_KEY, body: { title: 'RO write attempt', body: 'should fail' } });
  check('v4.1 readonly task create rejected (403, clear error)', roCreate.status === 403 && String(roCreate.data.error).includes('read-only'), JSON.stringify(roCreate.data));
  const roComment = await call('POST', '/api/tasks/1/comments', { key: RO_KEY, body: { body: 'nope' } });
  check('v4.1 readonly comment rejected (403)', roComment.status === 403, String(roComment.status));
  const roPatch = await call('PATCH', '/api/tasks/1', { key: RO_KEY, body: { status: 'queued' } });
  check('v4.1 readonly status change rejected (403)', roPatch.status === 403, String(roPatch.status));
  const roFilePut = await call('PUT', '/api/files', { key: RO_KEY, body: { path: 'x.md', text: 'nope' } });
  const roCtxPut = await call('PUT', '/api/context', { key: RO_KEY, body: { projects: [] } });
  check('v4.1 readonly file/context writes rejected (403)', roFilePut.status === 403 && roCtxPut.status === 403, [roFilePut.status, roCtxPut.status].join(','));
  const roMint = await call('POST', '/api/keys', { key: RO_KEY, body: { name: 'ro-made', key: 'whatever-key-0123456789abcdef1' } });
  const roKeyList = await call('GET', '/api/keys', { key: RO_KEY });
  const roRevoke = await call('DELETE', '/api/keys/primary', { key: RO_KEY });
  check('v4.1 readonly cannot manage keys (mint/list/revoke all 403)', roMint.status === 403 && roKeyList.status === 403 && roRevoke.status === 403, [roMint.status, roKeyList.status, roRevoke.status].join(','));

  // hosted MCP calls with the readonly key need their own call path:
  const mcpRo = async (method, params) => (await call('POST', '/mcp', { key: RO_KEY, body: { jsonrpc: '2.0', id: 1, method, params } })).data;
  const roToolCall = async (name, args) => { const r = await mcpRo('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text || ''; };
  const roBoard = await roToolCall('ghost_board', {});
  check('v4.1 readonly hosted MCP read tool works', roBoard.includes('Ghost Bridge Board'), roBoard.slice(0, 60));
  const roHand = await mcpRo('tools/call', { name: 'ghost_handoff', arguments: { title: 'RO MCP task', task: 'should be refused' } });
  check('v4.1 readonly hosted MCP write tool rejected with clear error', roHand.result?.isError === true && (roHand.result?.content?.[0]?.text || '').includes('read-only'), JSON.stringify(roHand).slice(0, 160));
  const roCapUp = await mcpRo('tools/call', { name: 'ghost_capsule_update', arguments: { project: 'ghostcut', note: 'nope' } });
  check('v4.1 readonly hosted MCP capsule update rejected', roCapUp.result?.isError === true, JSON.stringify(roCapUp).slice(0, 120));

  // ---- claim leases ----
  const B_KEY = 'agent-b-full-key-0123456789abcdef';
  await call('POST', '/api/keys', { key: KEY, body: { name: 'agent-b', key: B_KEY } });
  const leaseTask = await call('POST', '/api/tasks', { key: KEY, body: { title: 'Lease task', body: 'Claim me.' } });
  const LT = leaseTask.data.id;
  const claim1 = await call('PATCH', `/api/tasks/${LT}`, { key: KEY, body: { status: 'in-progress' } });
  check('v4.1 claim records claimedBy + future expiry', claim1.status === 200 && claim1.data.claimedBy === 'primary' && Date.parse(claim1.data.claimExpiresAt) > Date.now(), JSON.stringify({ by: claim1.data.claimedBy, exp: claim1.data.claimExpiresAt }));
  const claim2 = await call('PATCH', `/api/tasks/${LT}`, { key: B_KEY, body: { status: 'in-progress' } });
  check('v4.1 second key claim blocked (409 naming holder + expiry)', claim2.status === 409 && claim2.data.claimedBy === 'primary' && !!claim2.data.claimExpiresAt && String(claim2.data.error).includes('primary'), JSON.stringify(claim2.data));
  const claimRenew = await call('PATCH', `/api/tasks/${LT}`, { key: KEY, body: { claim: true } });
  check('v4.1 holder re-claim via {claim:true} renews (200)', claimRenew.status === 200 && claimRenew.data.claimedBy === 'primary', String(claimRenew.status));
  const leaseView = await toolCall('ghost_task_result', { issue: LT });
  check('v4.1 hosted MCP task_result surfaces the lease', leaseView.includes('Claimed by: primary'), leaseView.slice(0, 120));
  const release = await call('PATCH', `/api/tasks/${LT}`, { key: KEY, body: { status: 'queued' } });
  check('v4.1 release to queued clears the lease', release.status === 200 && release.data.claimedBy === null && release.data.claimExpiresAt === null, JSON.stringify({ by: release.data.claimedBy, exp: release.data.claimExpiresAt }));
  const shortClaim = await call('PATCH', `/api/tasks/${LT}`, { key: KEY, body: { status: 'in-progress', claimMinutes: 0 } });
  check('v4.1 zero-minute claim is immediately expired', shortClaim.status === 200 && Date.parse(shortClaim.data.claimExpiresAt) <= Date.now(), String(shortClaim.data.claimExpiresAt));
  await new Promise(r => setTimeout(r, 30));
  const steal = await call('PATCH', `/api/tasks/${LT}`, { key: B_KEY, body: { status: 'in-progress' } });
  check('v4.1 expired lease can be re-claimed by another key', steal.status === 200 && steal.data.claimedBy === 'agent-b', JSON.stringify({ status: steal.status, by: steal.data.claimedBy }));
  const doneLease = await call('PATCH', `/api/tasks/${LT}`, { key: B_KEY, body: { status: 'done' } });
  check('v4.1 completing a task clears the lease', doneLease.status === 200 && doneLease.data.claimedBy === null && doneLease.data.claimExpiresAt === null, JSON.stringify({ by: doneLease.data.claimedBy }));

  // ---- idempotent handoffs (REST + hosted MCP) ----
  const idemBody = { title: 'Idempotent REST task', body: 'File me once.', idempotencyKey: 'rest-idem-001' };
  const idem1 = await call('POST', '/api/tasks', { key: KEY, body: idemBody });
  check('v4.1 idempotent create returns 201 + new id', idem1.status === 201 && idem1.data.id > 0, String(idem1.status));
  const countBefore = (await call('GET', '/api/tasks?state=all&limit=200', { key: KEY })).data.tasks.length;
  const idem2 = await call('POST', '/api/tasks', { key: KEY, body: idemBody });
  const countAfter = (await call('GET', '/api/tasks?state=all&limit=200', { key: KEY })).data.tasks.length;
  check('v4.1 same key + same idempotency key returns existing task, no duplicate', idem2.status === 200 && idem2.data.duplicateSuppressed === true && idem2.data.id === idem1.data.id && countAfter === countBefore, JSON.stringify({ s: idem2.status, a: idem1.data.id, b: idem2.data.id, countBefore, countAfter }));
  check('v4.1 idempotency key not exposed in task reads', !('idemKey' in idem2.data) && !JSON.stringify(idem2.data).includes('rest-idem-001'), JSON.stringify(Object.keys(idem2.data)));
  const idemOther = await call('POST', '/api/tasks', { key: B_KEY, body: idemBody });
  check('v4.1 same idempotency key from a different key creates its own task', idemOther.status === 201 && idemOther.data.id !== idem1.data.id, JSON.stringify({ s: idemOther.status, id: idemOther.data.id }));
  const mcpIdem1 = await toolCall('ghost_handoff', { title: 'Idempotent MCP task', task: 'File me once via MCP.', idempotencyKey: 'mcp-idem-001' });
  check('v4.1 hosted MCP handoff with idempotency key files a task', mcpIdem1.includes('relay #'), mcpIdem1.slice(0, 80));
  const mcpIdemId = Number((mcpIdem1.match(/relay #(\d+)/) || [])[1]);
  const mcpIdem2 = await toolCall('ghost_handoff', { title: 'Idempotent MCP task', task: 'File me once via MCP.', idempotencyKey: 'mcp-idem-001' });
  check('v4.1 hosted MCP re-handoff suppressed, same task id', mcpIdem2.includes('Duplicate suppressed') && mcpIdem2.includes(`#${mcpIdemId}`), mcpIdem2.slice(0, 120));

  // ---- rate limiting (dedicated low-limit instance; default stays 600) ----
  {
    const rPort = 8897;
    const rchild = spawn('node', ['local-server.mjs', String(rPort)], {
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...process.env, BRIDGE_SETUP_SECRET: 'test-setup-secret', GHOST_BRIDGE_RATE_PER_MIN: '5' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    await new Promise(r => setTimeout(r, 700));
    const rkey = 'rate-test-key-0123456789abcdef';
    const rbase = `http://127.0.0.1:${rPort}`;
    await fetch(rbase + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: rkey, setupSecret: 'test-setup-secret' }) });
    let lastStatus = 0, retryAfter = null;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(rbase + '/api/tasks', { headers: { 'x-bridge-key': rkey } });
      lastStatus = res.status; retryAfter = res.headers.get('retry-after');
      await res.text();
    }
    check('v4.1 rate limit trips under burst (429)', lastStatus === 429, String(lastStatus));
    check('v4.1 429 carries Retry-After', !!retryAfter && Number(retryAfter) >= 1, String(retryAfter));
    rchild.kill();
  }

  // ---- event retention cap (direct handler, tiny cap) ----
  {
    const mem = new Map();
    const h = createHandler({
      get: async k => (mem.has(k) ? mem.get(k) : null),
      set: async (k, v) => { mem.set(k, v); },
      del: async k => { mem.delete(k); }
    }, { BRIDGE_SETUP_SECRET: 'test-setup-secret', GHOST_BRIDGE_EVENT_CAP: '5' });
    const hkey = 'cap-test-key-0123456789abcdef';
    const callH = (method, path, body) => h({ method, path: path.split('?')[0], query: path.includes('?') ? Object.fromEntries(new URLSearchParams(path.split('?')[1])) : {}, headers: { 'x-bridge-key': hkey }, bodyText: body ? JSON.stringify(body) : '' });
    await h({ method: 'POST', path: '/setup', query: {}, headers: {}, bodyText: JSON.stringify({ key: hkey, setupSecret: 'test-setup-secret' }) });
    for (let i = 0; i < 8; i++) await callH('POST', '/api/tasks', { title: `Cap task ${i}`, body: 'x' });
    const evIdx = JSON.parse(mem.get('ev-index') || '[]');
    const evRes = await callH('GET', '/api/events?since=0');
    check('v4.1 event log retention cap trims to N', evIdx.length <= 5 && evRes.body.events.length <= 5, `index=${evIdx.length} returned=${evRes.body.events.length}`);
  }

  // ---------- v4.2: signed webhooks ----------
  {
    const hits = [];
    const hook = http.createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { hits.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') }); res.writeHead(200); res.end('ok'); }); });
    await new Promise(r => hook.listen(0, '127.0.0.1', r));
    const sPort = 8895;
    const schild = spawn('node', ['local-server.mjs', String(sPort)], {
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...process.env, BRIDGE_SETUP_SECRET: 'test-setup-secret', GHOST_BRIDGE_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/hook`, GHOST_BRIDGE_WEBHOOK_SECRET: 'test-webhook-secret' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    await new Promise(r => setTimeout(r, 700));
    const sbase = `http://127.0.0.1:${sPort}`;
    const skey = 'signed-webhook-key-0123456789abcdef';
    await fetch(sbase + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: skey, setupSecret: 'test-setup-secret' }) });
    await fetch(sbase + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-key': skey }, body: JSON.stringify({ title: 'Signed webhook task', body: 'sign me' }) });
    await new Promise(r => setTimeout(r, 600));
    const signedHit = hits.find(h => { try { return JSON.parse(h.raw).type === 'task.created'; } catch { return false; } });
    check('v4.2 signed webhook delivered task.created', !!signedHit, JSON.stringify(hits.map(h => h.headers['x-ghost-event'])));
    if (signedHit) {
      const { verifyGhostSignature } = await import('../scripts/webhook-verify.mjs');
      check('v4.2 webhook carries x-ghost-event header', signedHit.headers['x-ghost-event'] === 'task.created', String(signedHit.headers['x-ghost-event']));
      const sig = signedHit.headers['x-ghost-signature'] || '';
      check('v4.2 signature is sha256=<hmac of raw body>', sig.startsWith('sha256=') && sig === 'sha256=' + crypto.createHmac('sha256', 'test-webhook-secret').update(signedHit.raw).digest('hex'), sig);
      check('v4.2 verify helper accepts the real signature', verifyGhostSignature(signedHit.raw, sig, 'test-webhook-secret') === true);
      check('v4.2 verify helper rejects tampered body + wrong secret', verifyGhostSignature(signedHit.raw + ' ', sig, 'test-webhook-secret') === false && verifyGhostSignature(signedHit.raw, sig, 'wrong-secret') === false);
    }
    schild.kill(); hook.close();
  }

  // ---------- v4.2: backup / restore (export + import round-trip) ----------
  const roExport = await call('GET', '/api/export', { key: RO_KEY });
  check('v4.2 readonly export rejected (403)', roExport.status === 403, String(roExport.status));
  const roImport = await call('POST', '/api/import', { key: RO_KEY, body: { keys: [], tasks: [] } });
  check('v4.2 readonly import rejected (403)', roImport.status === 403, String(roImport.status));
  const exp = await call('GET', '/api/export', { key: KEY });
  check('v4.2 export returns one document (format/version/keys/tasks/files/context/counter)', exp.status === 200 && exp.data.format === 'ghost-bridge-export' && exp.data.version === '4.4.0' && Array.isArray(exp.data.keys) && Array.isArray(exp.data.tasks) && typeof exp.data.files === 'object' && typeof exp.data.counter === 'number', JSON.stringify(exp.data).slice(0, 120));
  check('v4.2 export keys carry names+scopes+hashes only — no plaintext key anywhere', exp.data.keys.every(k => /^[0-9a-f]{64}$/.test(k.hash) && typeof k.name === 'string' && ['full', 'readonly'].includes(k.scope)) && !JSON.stringify(exp.data).includes(KEY) && !JSON.stringify(exp.data).includes(RO_KEY) && !JSON.stringify(exp.data).includes(B_KEY), exp.data.keys.map(k => k.name).join(','));
  check('v4.2 export tasks are complete (idemKey included) and files/context match', exp.data.tasks.some(t => t.idemKey === 'rest-idem-001') && exp.data.files['capsules/ghostcut.md']?.includes('Testing.') && exp.data.context?.projects?.[0]?.slug === 'ghostcut', `tasks=${exp.data.tasks.length}`);
  {
    const mem = new Map();
    const h = createHandler({
      get: async k => (mem.has(k) ? mem.get(k) : null),
      set: async (k, v) => { mem.set(k, v); },
      del: async k => { mem.delete(k); }
    }, { BRIDGE_SETUP_SECRET: 'test-setup-secret' });
    const bootKey = 'bootstrap-key-0123456789abcdef';
    const callH = (method, p, body, useKey) => {
      const [p0, qs] = p.split('?');
      return h({ method, path: p0, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {}, headers: { 'x-bridge-key': useKey }, bodyText: body ? JSON.stringify(body) : '' });
    };
    await h({ method: 'POST', path: '/setup', query: {}, headers: {}, bodyText: JSON.stringify({ key: bootKey, setupSecret: 'test-setup-secret', name: 'bootstrap' }) });
    const badImport = await callH('POST', '/api/import', { keys: [{ name: 'x', hash: 'not-a-hash' }], tasks: [] }, bootKey);
    check('v4.2 import validates keys (bad hash 400, nothing written)', badImport.status === 400, String(badImport.status));
    const imp = await callH('POST', '/api/import', exp.data, bootKey);
    check('v4.2 import into empty relay succeeds', imp.status === 200 && imp.body.ok === true && imp.body.imported.tasks === exp.data.tasks.length, JSON.stringify(imp.body).slice(0, 140));
    const impTasks = await callH('GET', '/api/tasks?state=all&limit=200', null, KEY);
    check('v4.2 imported key (exported primary) authenticates on the fresh relay', impTasks.status === 200 && impTasks.body.tasks.length === exp.data.tasks.length && impTasks.body.tasks.every(t => exp.data.tasks.some(x => x.id === t.id && x.title === t.title)), String(impTasks.status));
    const impFile = await callH('GET', '/api/files?path=' + encodeURIComponent('capsules/ghostcut.md'), null, B_KEY);
    check('v4.2 imported files match (read via another exported key)', impFile.status === 200 && impFile.body.text.includes('Testing.'), String(impFile.status));
    const impCtx = await callH('GET', '/api/context', null, RO_KEY);
    check('v4.2 imported context + readonly scope survive the round-trip', impCtx.status === 200 && impCtx.body.projects?.[0]?.slug === 'ghostcut', String(impCtx.status));
    const impRoExp = await callH('GET', '/api/export', null, RO_KEY);
    check('v4.2 imported readonly key still cannot export', impRoExp.status === 403, String(impRoExp.status));
    const imp2 = await callH('POST', '/api/import', exp.data, KEY);
    check('v4.2 import into a non-empty relay refused (409)', imp2.status === 409, String(imp2.status));
    const imp3 = await callH('POST', '/api/import?force=true', exp.data, KEY);
    check('v4.2 force without the confirm field refused (409)', imp3.status === 409, String(imp3.status));
    const imp4 = await callH('POST', '/api/import?force=true', { ...exp.data, confirm: 'OVERWRITE' }, KEY);
    check('v4.2 force + confirm OVERWRITE restores', imp4.status === 200 && imp4.body.ok === true, JSON.stringify(imp4.body).slice(0, 100));
    const afterForce = await callH('GET', '/api/tasks?state=all&limit=200', null, KEY);
    check('v4.2 tasks identical after forced restore', afterForce.body.tasks.length === exp.data.tasks.length, String(afterForce.body.tasks.length));
  }

  // ---------- v4.2: board page carries the detail drawer + owner actions ----------
  {
    const boardHtml = await import('node:fs').then(m => m.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'));
    check('v4.2 board has task detail drawer', boardHtml.includes('id="detail"') && boardHtml.includes('detailThread') && boardHtml.includes('data-open'), boardHtml.length + ' bytes');
    check('v4.2 board has owner actions (reply / approve / cancel via existing endpoints)', boardHtml.includes('detailApprove') && boardHtml.includes('detailCancel') && boardHtml.includes('ryan-via-board') && boardHtml.includes('/comments') && boardHtml.includes('needs-approval'), '');
    check('v4.2 board explains readonly view-only mode', boardHtml.includes('Read-only key') && boardHtml.includes('detailRoNote'), '');
    check('v4.2 board stays a single static file (no external assets)', !/<script[^>]+src=/.test(boardHtml) && !/<link[^>]+href="http/.test(boardHtml), '');
  }

  // ---------- v4.3: file revisions (optimistic concurrency) ----------
  {
    const w1 = await call('PUT', '/api/files', { key: KEY, body: { path: 'capsules/rev-test.md', text: 'version one' } });
    check('v4.3 first file write gets rev 1', w1.status === 200 && w1.data.rev === 1, JSON.stringify(w1.data));
    const g1 = await call('GET', '/api/files?path=' + encodeURIComponent('capsules/rev-test.md'), { key: KEY });
    check('v4.3 file GET exposes rev + ETag header', g1.data.rev === 1 && g1.headers.get('etag') === '"rev-1"', JSON.stringify(g1.data) + ' etag=' + g1.headers.get('etag'));
    const w2 = await call('PUT', '/api/files', { key: KEY, body: { path: 'capsules/rev-test.md', text: 'version two', expectedRev: 1 } });
    check('v4.3 write with matching expectedRev succeeds -> rev 2', w2.status === 200 && w2.data.rev === 2, JSON.stringify(w2.data));
    const wStale = await call('PUT', '/api/files', { key: KEY, body: { path: 'capsules/rev-test.md', text: 'stale clobber', expectedRev: 1 } });
    check('v4.3 stale expectedRev -> 409 with currentRev + merge hint, nothing written', wStale.status === 409 && wStale.data.currentRev === 2 && /merge/i.test(wStale.data.error || ''), JSON.stringify(wStale.data));
    const g2 = await call('GET', '/api/files?path=' + encodeURIComponent('capsules/rev-test.md'), { key: KEY });
    check('v4.3 conflicting write really did not land', g2.data.text === 'version two' && g2.data.rev === 2, JSON.stringify(g2.data));
    const w3 = await call('PUT', '/api/files', { key: KEY, body: { path: 'capsules/rev-test.md', text: 'version three' } });
    check('v4.3 write without expectedRev still works (last-write-wins by choice) -> rev 3', w3.status === 200 && w3.data.rev === 3, JSON.stringify(w3.data));
    const wBad = await call('PUT', '/api/files', { key: KEY, body: { path: 'capsules/rev-test.md', text: 'x', expectedRev: 'abc' } });
    check('v4.3 non-numeric expectedRev -> 400', wBad.status === 400, String(wBad.status));
  }

  // ---------- v4.3: pre-v4.3 files (no stored rev) start at rev 1 ----------
  {
    const hash = crypto.createHash('sha256').update(KEY).digest('hex');
    const m = new Map();
    const store = { get: async k => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); }, del: async k => { m.delete(k); } };
    m.set('config', JSON.stringify({ keys: [{ name: 'primary', hash, scope: 'full', createdAt: '2026-10-10T00:00:00Z', lastUsedAt: null }], createdAt: '2026-10-10T00:00:00Z' }));
    await store.set('file:capsules/legacy.md', '# Legacy capsule (written before v4.3)');
    await store.set('file-index', JSON.stringify(['capsules/legacy.md']));
    const handler = createHandler(store, { BRIDGE_SETUP_SECRET: 'test-setup-secret' });
    const hc = async (h, method, p, body) => {
      const [p0, qs] = p.split('?');
      const r = await h({ method, path: p0, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {}, headers: { 'x-bridge-key': KEY }, bodyText: body ? JSON.stringify(body) : '' });
      return { status: r.status, data: r.body };
    };
    const lg = await hc(handler, 'GET', '/api/files?path=' + encodeURIComponent('capsules/legacy.md'));
    check('v4.3 legacy file (no stored rev) reads rev 1', lg.status === 200 && lg.data.rev === 1, JSON.stringify(lg.data));
    const lw = await hc(handler, 'PUT', '/api/files', { path: 'capsules/legacy.md', text: '# Legacy capsule v2', expectedRev: 1 });
    check('v4.3 legacy file first v4.3 write -> rev 2', lw.status === 200 && lw.data.rev === 2, JSON.stringify(lw.data));
    // Presence freshness window on the same direct handler: a record seen
    // 60 minutes ago is outside the default 10-minute window.
    await store.set('presence-index', JSON.stringify(['stale-agent']));
    await store.set('presence:stale-agent', JSON.stringify({ name: 'stale-agent', displayName: 'Stale Agent', capabilities: ['haunting'], status: 'online', lastSeen: new Date(Date.now() - 60 * 60000).toISOString() }));
    const presStale = await hc(handler, 'GET', '/api/presence');
    check('v4.3 presence window excludes records older than GHOST_BRIDGE_PRESENCE_MINUTES (default 10)', presStale.status === 200 && presStale.data.agents.length === 0, JSON.stringify(presStale.data));
    const handlerWide = createHandler(store, { BRIDGE_SETUP_SECRET: 'test-setup-secret', GHOST_BRIDGE_PRESENCE_MINUTES: '120' });
    const presWide = await hc(handlerWide, 'GET', '/api/presence');
    check('v4.3 wider presence window (120 min) includes the 60-minute-old record', presWide.data.agents.length === 1 && presWide.data.agents[0].name === 'stale-agent' && presWide.data.windowMinutes === 120, JSON.stringify(presWide.data));
  }

  // ---------- v4.3: agent presence ----------
  let RO43 = null;
  {
    const hb = await call('POST', '/api/presence', { key: KEY, body: { displayName: 'Test Agent', capabilities: ['code', 'review'], status: 'busy' } });
    check('v4.3 heartbeat records presence under the key name', hb.status === 200 && hb.data.ok && hb.data.agent?.name === 'primary' && hb.data.agent?.status === 'busy', JSON.stringify(hb.data));
    const pres = await call('GET', '/api/presence', { key: KEY });
    const me = (pres.data.agents || []).find(a => a.name === 'primary');
    check('v4.3 presence list shows displayName/capabilities/status/lastSeen, never key material', pres.status === 200 && !!me && me.displayName === 'Test Agent' && me.capabilities.includes('code') && me.status === 'busy' && !!me.lastSeen && !JSON.stringify(pres.data).includes('hash') && !JSON.stringify(pres.data).includes(KEY), JSON.stringify(pres.data).slice(0, 200));
    const badStatus = await call('POST', '/api/presence', { key: KEY, body: { status: 'lurking' } });
    check('v4.3 heartbeat rejects unknown status (400)', badStatus.status === 400, String(badStatus.status));
    const badCaps = await call('POST', '/api/presence', { key: KEY, body: { capabilities: 'not-an-array' } });
    check('v4.3 heartbeat rejects non-array capabilities (400)', badCaps.status === 400, String(badCaps.status));
    RO43 = 'readonly-43-key-0123456789abcdef';
    const ro43res = await call('POST', '/api/keys', { key: KEY, body: { name: 'ro43', key: RO43, scope: 'readonly' } });
    check('v4.3 mint the readonly key used by the presence/archive checks', ro43res.status === 201 && ro43res.data.scope === 'readonly', JSON.stringify(ro43res.data));
    const roHb = await call('POST', '/api/presence', { key: RO43, body: { displayName: 'Readonly Agent' } });
    check('v4.3 readonly key MAY heartbeat (documented exception)', roHb.status === 200, String(roHb.status));
    const roPres = await call('GET', '/api/presence', { key: RO43 });
    check('v4.3 readonly key may read presence', roPres.status === 200 && roPres.data.agents.length >= 2, JSON.stringify(roPres.data).slice(0, 120));
  }

  // ---------- v4.3: task scheduling ----------
  {
    const badDue = await call('POST', '/api/tasks', { key: KEY, body: { title: 'Bad due', body: 'x', dueAt: 'not-a-date' } });
    check('v4.3 malformed dueAt -> 400 with clear error', badDue.status === 400 && /not a recognizable date/.test(badDue.data.error || ''), JSON.stringify(badDue.data));
    const badNb = await call('POST', '/api/tasks', { key: KEY, body: { title: 'Bad notBefore', body: 'x', notBefore: 'whenever' } });
    check('v4.3 malformed notBefore -> 400', badNb.status === 400, JSON.stringify(badNb.data));
    const od = await call('POST', '/api/tasks', { key: KEY, body: { title: 'Overdue probe', body: 'Due long ago.', dueAt: '2020-01-01T00:00:00.000Z' } });
    check('v4.3 queued task past dueAt is flagged overdue on create', od.status === 201 && od.data.overdue === true && od.data.dueAt === '2020-01-01T00:00:00.000Z', JSON.stringify(od.data).slice(0, 160));
    const sc = await call('POST', '/api/tasks', { key: KEY, body: { title: 'Scheduled probe', body: 'Not yet.', notBefore: '2999-01-01T00:00:00.000Z' } });
    check('v4.3 task with future notBefore is flagged scheduled on create', sc.status === 201 && sc.data.scheduled === true && sc.data.overdue === false, JSON.stringify(sc.data).slice(0, 160));
    const plain = await call('POST', '/api/tasks', { key: KEY, body: { title: 'Plain probe', body: 'No schedule.' } });
    check('v4.3 unscheduled task carries no flags', plain.status === 201 && plain.data.overdue === false && plain.data.scheduled === false && plain.data.dueAt === null, JSON.stringify(plain.data).slice(0, 160));
    const health = await call('GET', '/health');
    check('v4.3 /health reports the overdue count', typeof health.data.overdue === 'number' && health.data.overdue >= 1, JSON.stringify(health.data));
    const claimSc = await call('PATCH', `/api/tasks/${sc.data.id}`, { key: KEY, body: { claim: true } });
    const schedOnly = await call('PATCH', `/api/tasks/${sc.data.id}`, { key: KEY, body: { dueAt: '2999-06-01T00:00:00.000Z' } });
    check('v4.3 schedule-only PATCH works without touching status or lease', schedOnly.status === 200 && schedOnly.data.status === 'in-progress' && schedOnly.data.claimedBy === claimSc.data.claimedBy && schedOnly.data.dueAt === '2999-06-01T00:00:00.000Z', JSON.stringify(schedOnly.data).slice(0, 200));
    const badPatch = await call('PATCH', `/api/tasks/${sc.data.id}`, { key: KEY, body: { notBefore: 'not-a-date' } });
    check('v4.3 schedule PATCH validates dates (400)', badPatch.status === 400, String(badPatch.status));
    const cleared = await call('PATCH', `/api/tasks/${od.data.id}`, { key: KEY, body: { dueAt: null } });
    check('v4.3 clearing dueAt via PATCH removes the overdue flag', cleared.status === 200 && cleared.data.dueAt === null && cleared.data.overdue === false, JSON.stringify(cleared.data).slice(0, 160));
    const hosted = await toolCall('ghost_handoff', { title: 'Hosted scheduled probe', task: 'Wait for the future.', schedule: '2999-01-01T00:00:00.000Z' });
    check('v4.3 hosted handoff result carries the skip-not-yet-due wording', hosted.includes('should NOT be picked up before 2999-01-01'), hosted.slice(0, 200));
    const hostedBad = await toolCall('ghost_handoff', { title: 'Hosted bad due', task: 'x', due: 'garbage-date' });
    check('v4.3 hosted handoff rejects a malformed due date', hostedBad.includes('Not sent') && hostedBad.includes('not a recognizable date'), hostedBad.slice(0, 160));
    const hostedStatus = await toolCall('ghost_bridge_status', {});
    check('v4.3 hosted status lists online agents', hostedStatus.includes('Online agents') && hostedStatus.includes('Test Agent'), hostedStatus.slice(0, 300));
  }

  // ---------- v4.3: pagination + q= search ----------
  {
    const pageIds = [];
    for (let i = 1; i <= 15; i++) {
      const t = await call('POST', '/api/tasks', { key: KEY, body: { title: `Page task ${String(i).padStart(2, '0')}`, body: 'pagination probe body' } });
      pageIds.push(t.data.id);
    }
    const commentTarget = pageIds[6];
    await call('POST', `/api/tasks/${commentTarget}/comments`, { key: KEY, body: { body: 'a zanzibar comment', author: 'tester' } });
    const all = await call('GET', '/api/tasks?state=all&type=task&q=pagination&limit=100', { key: KEY });
    check('v4.3 q= + limit returns total and the full subset', all.status === 200 && all.data.total === 15 && all.data.tasks.length === 15, JSON.stringify({ total: all.data.total, n: (all.data.tasks || []).length }));
    const noParams = await call('GET', '/api/tasks?state=all&type=task&q=pagination', { key: KEY });
    check('v4.3 without paging params the response shape is unchanged (no total field)', noParams.data.total === undefined && noParams.data.tasks.length === 15, JSON.stringify(Object.keys(noParams.data)));
    const seen = [];
    let pagesOk = true;
    for (const off of [0, 5, 10]) {
      const page = await call('GET', `/api/tasks?state=all&type=task&q=pagination&limit=5&offset=${off}`, { key: KEY });
      if (page.data.total !== 15 || page.data.limit !== 5 || page.data.offset !== off || page.data.tasks.length !== 5) pagesOk = false;
      seen.push(...page.data.tasks.map(t => t.id));
    }
    check('v4.3 limit=5 pages carry total/limit/offset', pagesOk, seen.join(','));
    check('v4.3 pages are complete with no dupes or gaps (15 unique ids)', new Set(seen).size === 15 && pageIds.every(id => seen.includes(id)), seen.join(','));
    check('v4.3 pages stay newest-first across page boundaries', seen[0] > seen[14], seen.join(','));
    const qComment = await call('GET', '/api/tasks?state=all&type=task&q=zanzibar&limit=10', { key: KEY });
    check('v4.3 q= matches words that appear only in a comment', qComment.data.total === 1 && qComment.data.tasks[0].id === commentTarget, JSON.stringify(qComment.data).slice(0, 160));
    const inboxA = await toolCall('ghost_inbox', { limit: 5, offset: 0 });
    const inboxB = await toolCall('ghost_inbox', { limit: 5, offset: 5 });
    const idsA = [...inboxA.matchAll(/#(\d+) \[/g)].map(x => Number(x[1]));
    const idsB = [...inboxB.matchAll(/#(\d+) \[/g)].map(x => Number(x[1]));
    check('v4.3 hosted ghost_inbox limit/offset pages are disjoint', idsA.length === 5 && idsB.length === 5 && !idsA.some(id => idsB.includes(id)), `A=${idsA} B=${idsB}`);
  }

  // ---------- v4.3: archive + retention ----------
  {
    const roArch = await call('POST', '/api/tasks/archive', { key: RO43, body: {} });
    check('v4.3 archive rejects a readonly key (403, full-scope only)', roArch.status === 403, String(roArch.status));
    const archRecent = await call('POST', '/api/tasks/archive', { key: KEY, body: {} });
    check('v4.3 archive call with only recent tasks archives nothing', archRecent.status === 200 && archRecent.data.archived === 0, JSON.stringify(archRecent.data));
    const healthA = await call('GET', '/health');
    check('v4.3 /health archived count is 0 before any archiving', healthA.data.archived === 0, JSON.stringify(healthA.data));

    const hash = crypto.createHash('sha256').update(KEY).digest('hex');
    const m = new Map();
    const store = { get: async k => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); }, del: async k => { m.delete(k); } };
    m.set('config', JSON.stringify({ keys: [{ name: 'primary', hash, scope: 'full', createdAt: '2026-10-10T00:00:00Z', lastUsedAt: null }], createdAt: '2026-10-10T00:00:00Z' }));
    const old = '2020-01-01T00:00:00.000Z';
    const nowIso = new Date().toISOString();
    const seedTask = (id, status, when) => ({ id, type: 'task', title: `Seed ${id} ${status}`, body: 'seed', project: null, priority: 'normal', status, comments: [], attachments: [], result: null, createdBy: 'primary', claimedBy: null, claimExpiresAt: null, createdAt: when, updatedAt: when, closedAt: status === 'queued' ? null : when });
    for (const t of [seedTask(1, 'done', old), seedTask(2, 'cancelled', old), seedTask(3, 'done', nowIso), seedTask(4, 'queued', old)]) {
      m.set(`task:${t.id}`, JSON.stringify(t));
    }
    m.set('task-ids', JSON.stringify([1, 2, 3, 4]));
    m.set('counter', '4');
    const handler = createHandler(store, { BRIDGE_SETUP_SECRET: 'test-setup-secret' });
    const hc = async (h, method, p, body) => {
      const [p0, qs] = p.split('?');
      const r = await h({ method, path: p0, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {}, headers: { 'x-bridge-key': KEY }, bodyText: body ? JSON.stringify(body) : '' });
      return { status: r.status, data: r.body };
    };
    const before = await hc(handler, 'GET', '/api/tasks?state=all');
    check('v4.3 archive fixture starts with 4 tasks', before.data.tasks.length === 4, JSON.stringify(before.data).slice(0, 120));
    const arch = await hc(handler, 'POST', '/api/tasks/archive', {});
    check('v4.3 archive moves exactly the old done + old cancelled tasks', arch.status === 200 && arch.data.archived === 2 && arch.data.archivedIds.includes(1) && arch.data.archivedIds.includes(2), JSON.stringify(arch.data));
    const after = await hc(handler, 'GET', '/api/tasks?state=all');
    check('v4.3 archived tasks leave the default lists (recent done + old queued stay)', after.data.tasks.length === 2 && after.data.tasks.every(t => !t.archived), JSON.stringify(after.data.tasks.map(t => t.id)));
    const archList = await hc(handler, 'GET', '/api/tasks?state=all&archived=1');
    check('v4.3 archived tasks are readable via ?archived=1', archList.data.tasks.length === 2 && archList.data.tasks.every(t => t.archived === true), JSON.stringify(archList.data.tasks.map(t => t.id)));
    const probeA = await hc(handler, 'GET', '/probe');
    check('v4.3 /probe counts exclude archived tasks', probeA.data.queued === 1 && JSON.stringify(probeA.data.ids) === '[4]', JSON.stringify(probeA.data));
    const healthB = await hc(handler, 'GET', '/health');
    check('v4.3 /health reports the archived count and excludes them from byStatus', healthB.data.archived === 2 && healthB.data.byStatus.done === 1 && healthB.data.tasks === 2, JSON.stringify(healthB.data));
    const exp = await hc(handler, 'GET', '/api/export');
    check('v4.3 export still includes archived tasks (nothing is lost)', exp.data.tasks.length === 4 && exp.data.tasks.filter(t => t.archived).length === 2, JSON.stringify(exp.data.tasks.map(t => t.id)));
    const archAgain = await hc(handler, 'POST', '/api/tasks/archive', {});
    check('v4.3 a second archive call is a no-op', archAgain.data.archived === 0, JSON.stringify(archAgain.data));
    const archDisabled = await hc(handler, 'POST', '/api/tasks/archive', { days: 0 });
    check('v4.3 archive with days=0 is disabled (documented no-op)', archDisabled.status === 200 && archDisabled.data.archived === 0 && /disabled/.test(archDisabled.data.note || ''), JSON.stringify(archDisabled.data));
    const handlerOff = createHandler(store, { BRIDGE_SETUP_SECRET: 'test-setup-secret', GHOST_BRIDGE_ARCHIVE_DAYS: '0' });
    const offRes = await hc(handlerOff, 'POST', '/api/tasks/archive', {});
    check('v4.3 GHOST_BRIDGE_ARCHIVE_DAYS=0 disables archiving relay-wide', offRes.data.archived === 0 && /disabled/.test(offRes.data.note || ''), JSON.stringify(offRes.data));
  }

  // ---------- v4.3: board carries the agents strip + schedule badges ----------
  {
    const boardHtml = await import('node:fs').then(m => m.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'));
    check('v4.3 board has an Agents strip fed by /api/presence', boardHtml.includes('id="agents"') && boardHtml.includes('/api/presence'), boardHtml.length + ' bytes');
    check('v4.3 board badges overdue + scheduled tasks and shows v4.4', boardHtml.includes('OVERDUE') && boardHtml.includes('badge-sched') && boardHtml.includes('v4.4'), '');
  }

  // ---------- v4.4: task dependencies ----------
  {
    const blocker = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 blocker task', body: 'Must finish first.' } });
    const dep = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 dependent task', body: 'Waits on the blocker.', blockedBy: [blocker.data.id] } });
    check('v4.4 task created with blockedBy reads back blocked + unfinished list', dep.status === 201 && dep.data.blocked === true && JSON.stringify(dep.data.blockedByUnfinished) === JSON.stringify([blocker.data.id]) && JSON.stringify(dep.data.blockedBy) === JSON.stringify([blocker.data.id]), JSON.stringify(dep.data).slice(0, 200));
    const dangling = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 dangling dep', body: 'x', blockedBy: [999999] } });
    check('v4.4 blockedBy pointing at a nonexistent task -> 400', dangling.status === 400 && /does not exist/.test(dangling.data.error || ''), JSON.stringify(dangling.data));
    const badShape = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 bad dep shape', body: 'x', blockedBy: 'soon' } });
    check('v4.4 non-array blockedBy -> 400', badShape.status === 400, String(badShape.status));
    const alias = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 alias dependent', body: 'Uses dependsOn.', dependsOn: [blocker.data.id] } });
    check('v4.4 dependsOn alias accepted', alias.status === 201 && alias.data.blocked === true, JSON.stringify(alias.data).slice(0, 120));
    const claimBlocked = await call('PATCH', `/api/tasks/${dep.data.id}`, { key: KEY, body: { status: 'in-progress' } });
    check('v4.4 claiming a blocked task -> 409 naming the unfinished blocker', claimBlocked.status === 409 && (claimBlocked.data.error || '').includes('#' + blocker.data.id) && JSON.stringify(claimBlocked.data.blockedByUnfinished) === JSON.stringify([blocker.data.id]), JSON.stringify(claimBlocked.data));
    const claimFlag = await call('PATCH', `/api/tasks/${dep.data.id}`, { key: KEY, body: { claim: true } });
    check('v4.4 {claim:true} on a blocked task -> 409 too', claimFlag.status === 409, String(claimFlag.status));
    const selfRef = await call('PATCH', `/api/tasks/${dep.data.id}`, { key: KEY, body: { blockedBy: [dep.data.id] } });
    check('v4.4 a task cannot block itself (PATCH) -> 400', selfRef.status === 400 && /cannot block itself/.test(selfRef.data.error || ''), JSON.stringify(selfRef.data));
    const inbox44 = await toolCall('ghost_inbox', { limit: 30 });
    check('v4.4 hosted inbox marks the dependent [BLOCKED by #n]', inbox44.includes(`#${dep.data.id}`) && inbox44.includes(`[BLOCKED by #${blocker.data.id}]`), inbox44.slice(0, 300));
    const resultBlocked = await toolCall('ghost_task_result', { issue: dep.data.id });
    check('v4.4 hosted task_result explains the block', resultBlocked.includes('Blocked by:') && resultBlocked.includes('cannot be claimed'), resultBlocked.slice(0, 200));
    const finishBlocker = await call('PATCH', `/api/tasks/${blocker.data.id}`, { key: KEY, body: { status: 'done' } });
    check('v4.4 finishing the blocker lands', finishBlocker.status === 200 && finishBlocker.data.status === 'done', JSON.stringify(finishBlocker.data).slice(0, 100));
    const depAfter = await call('GET', `/api/tasks/${dep.data.id}`, { key: KEY });
    check('v4.4 dependent unblocks automatically once the blocker is done (computed, no mutation)', depAfter.data.blocked === false && JSON.stringify(depAfter.data.blockedByUnfinished) === '[]', JSON.stringify(depAfter.data).slice(0, 160));
    const claimNow = await call('PATCH', `/api/tasks/${dep.data.id}`, { key: KEY, body: { status: 'in-progress' } });
    check('v4.4 unblocked dependent can be claimed', claimNow.status === 200 && claimNow.data.status === 'in-progress' && claimNow.data.claimedBy === 'primary', JSON.stringify(claimNow.data).slice(0, 140));
    // cancelled blockers satisfy too
    const cancelBlocker = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 soon-cancelled blocker', body: 'Will be cancelled.' } });
    const dep2 = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 dependent of cancelled', body: 'Waits.', blockedBy: [cancelBlocker.data.id] } });
    await call('PATCH', `/api/tasks/${cancelBlocker.data.id}`, { key: KEY, body: { status: 'cancelled' } });
    const dep2After = await call('GET', `/api/tasks/${dep2.data.id}`, { key: KEY });
    check('v4.4 a cancelled blocker satisfies its dependents', dep2After.data.blocked === false, JSON.stringify(dep2After.data).slice(0, 140));
    // hosted MCP handoff deps
    const mcpBadDep = await toolCall('ghost_handoff', { title: 'v4.4 mcp dangling dep', task: 'x', blockedBy: [999999] });
    check('v4.4 hosted handoff with a dangling blocker is Not sent', mcpBadDep.includes('Not sent') && mcpBadDep.includes('does not exist'), mcpBadDep.slice(0, 140));
    const mcpDep = await toolCall('ghost_handoff', { title: 'v4.4 mcp dependent', task: 'Waits on task 1 thread.', blockedBy: [dep2.data.id] });
    check('v4.4 hosted handoff accepts blockedBy and says so', mcpDep.includes('Blocked by:') && mcpDep.includes('#' + dep2.data.id), mcpDep.slice(0, 200));
  }

  // ---------- v4.4: archived blockers count as satisfied (direct handler) ----------
  {
    const store = new Map();
    const s = {
      get: async k => (store.has(k) ? store.get(k) : null),
      set: async (k, v) => { store.set(k, v); },
      del: async k => { store.delete(k); }
    };
    const handler = createHandler(s, { BRIDGE_SETUP_SECRET: 'test-setup-secret' });
    const hc = async (method, p, body) => {
      const out = await handler({ method, path: p, query: {}, headers: { 'x-bridge-key': KEY }, bodyText: body ? JSON.stringify(body) : '' });
      return { status: out.status, data: typeof out.body === 'string' ? out.body : out.body };
    };
    await handler({ method: 'POST', path: '/setup', query: {}, headers: {}, bodyText: JSON.stringify({ key: KEY, setupSecret: 'test-setup-secret' }) });
    const now = new Date().toISOString();
    store.set('task:1', JSON.stringify({ id: 1, type: 'task', title: 'Archived old blocker', body: 'b', project: null, priority: 'normal', status: 'done', comments: [], attachments: [], result: null, createdBy: 'primary', claimedBy: null, claimExpiresAt: null, archived: true, archivedAt: now, createdAt: now, updatedAt: now, closedAt: now }));
    store.set('task:2', JSON.stringify({ id: 2, type: 'task', title: 'Dependent of archived', body: 'b', project: null, priority: 'normal', status: 'queued', comments: [], attachments: [], result: null, createdBy: 'primary', claimedBy: null, claimExpiresAt: null, blockedBy: [1], archived: false, archivedAt: null, createdAt: now, updatedAt: now, closedAt: null }));
    store.set('task-ids', JSON.stringify([1, 2]));
    store.set('counter', '2');
    const read = await hc('GET', '/api/tasks/2');
    check('v4.4 archived blocker counts as satisfied (documented decision)', read.status === 200 && read.data.blocked === false, JSON.stringify(read.data).slice(0, 160));
    const claimArch = await hc('PATCH', '/api/tasks/2', { status: 'in-progress' });
    check('v4.4 dependent of an archived blocker can be claimed', claimArch.status === 200 && claimArch.data.status === 'in-progress', JSON.stringify(claimArch.data).slice(0, 120));
  }

  // ---------- v4.4: digest ----------
  {
    const approval = await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 needs a decision', body: 'Owner must weigh in.' } });
    await call('PATCH', `/api/tasks/${approval.data.id}`, { key: KEY, body: { status: 'needs-approval' } });
    const noteCountBefore = (await call('GET', '/api/digest', { key: KEY })).data.newNotes;
    await call('POST', '/api/tasks', { key: KEY, body: { title: 'v4.4 digest note', body: 'A fresh note.', type: 'note' } });
    const dg = await call('GET', '/api/digest?hours=24', { key: KEY });
    check('v4.4 digest returns counts + waiting-on-owner + completed + notes + agents', dg.status === 200 && dg.data.counts['needs-approval'] >= 1 && dg.data.waitingOnOwner.some(t => t.id === approval.data.id) && dg.data.completed.some(t => t.title === 'v4.4 blocker task') && dg.data.newNotes === noteCountBefore + 1 && Array.isArray(dg.data.agentsSeen) && Array.isArray(dg.data.overdue), JSON.stringify(dg.data).slice(0, 240));
    check('v4.4 digest completed entries recover completedBy from the event log', dg.data.completed.every(t => !('completedBy' in t) || typeof t.completedBy === 'string') && dg.data.completed.some(t => t.completedBy === 'primary'), JSON.stringify(dg.data.completed).slice(0, 200));
    const mdRes = await fetch(BASE + '/api/digest?format=md', { headers: { 'x-bridge-key': KEY } });
    const mdText = await mdRes.text();
    check('v4.4 digest ?format=md renders Markdown with a Waiting on owner section', mdRes.status === 200 && (mdRes.headers.get('content-type') || '').includes('text/markdown') && mdText.includes('# Ghost Bridge digest') && mdText.includes('## Waiting on owner') && mdText.includes('v4.4 needs a decision'), mdText.slice(0, 160));
    const dgRo = await call('GET', '/api/digest', { key: RO_KEY });
    check('v4.4 readonly key may read the digest', dgRo.status === 200 && !!dgRo.data.counts, JSON.stringify(dgRo.data).slice(0, 100));
    const dgNoAuth = await call('GET', '/api/digest');
    check('v4.4 digest requires auth (401 without a key)', dgNoAuth.status === 401, String(dgNoAuth.status));
    const statusTxt = await toolCall('ghost_bridge_status', {});
    check('v4.4 hosted ghost_bridge_status carries a Digest (24h) section', statusTxt.includes('Digest (24h)') && statusTxt.includes('Waiting on Ryan:'), statusTxt.slice(0, 400));
  }

  // ---------- v4.4: /metrics ----------
  {
    const res = await fetch(BASE + '/metrics');
    const text = await res.text();
    check('v4.4 /metrics is unauthenticated Prometheus text', res.status === 200 && (res.headers.get('content-type') || '').includes('text/plain') && text.includes('ghost_bridge_tasks{status="queued"}') && text.includes('ghost_bridge_keys') && text.includes('ghost_bridge_events_total') && text.includes('ghost_bridge_overdue') && text.includes('ghost_bridge_archived') && text.includes('ghost_bridge_version_info{version="4.4.0"} 1'), text.slice(0, 240));
    check('v4.4 /metrics leaks nothing (counts only — no titles, no key material)', !text.includes('v4.4 blocker task') && !text.includes('First task') && !text.includes(KEY) && !text.includes('hash'), text.slice(0, 200));
  }

  // ---------- v4.4: context history ----------
  {
    const before = await call('GET', '/api/context', { key: KEY });
    const v0 = before.data.contextVersion;
    check('v4.4 GET /api/context carries the additive contextVersion field', before.status === 200 && typeof v0 === 'number' && v0 >= 1, JSON.stringify(before.data).slice(0, 120));
    const mkCtx = tag => ({ profile: { assistant: 'Mr.Ghosty' }, projects: [{ name: `Proj ${tag}`, slug: `proj-${tag}`, status: 'Working', summary: `Context ${tag}.` }], rules: [`Rule ${tag}.`], updated: tag });
    const p1 = await call('PUT', '/api/context', { key: KEY, body: mkCtx('hist-a') });
    const p2 = await call('PUT', '/api/context', { key: KEY, body: mkCtx('hist-b') });
    const p3 = await call('PUT', '/api/context', { key: KEY, body: mkCtx('hist-c') });
    check('v4.4 three PUTs bump the context version monotonically', p1.data.version === v0 + 1 && p2.data.version === v0 + 2 && p3.data.version === v0 + 3, JSON.stringify([p1.data, p2.data, p3.data]));
    const hist = await call('GET', '/api/context/history', { key: KEY });
    const nums = (hist.data.versions || []).map(v => v.n);
    check('v4.4 history lists versions 1,2,3 (relative: v0+1..v0+3) with project counts + a current marker', nums.includes(v0 + 1) && nums.includes(v0 + 2) && nums.includes(v0 + 3) && hist.data.versions.every(v => typeof v.projects === 'number') && hist.data.versions.find(v => v.n === v0 + 3)?.current === true, JSON.stringify(hist.data).slice(0, 240));
    const snap1 = await call('GET', `/api/context/history/${v0 + 1}`, { key: KEY });
    check('v4.4 snapshot of the first of the three PUTs is retrievable verbatim', snap1.status === 200 && snap1.data.projects[0].slug === 'proj-hist-a' && snap1.data.contextVersion === v0 + 1, JSON.stringify(snap1.data).slice(0, 160));
    // 8 more PUTs = 11 in this section: retention is the last 10 versions
    // total, so the first of the three must be pruned.
    let lastPut = null;
    for (let i = 0; i < 8; i++) lastPut = await call('PUT', '/api/context', { key: KEY, body: mkCtx('hist-x' + i) });
    check('v4.4 versions keep climbing (11th PUT in the section)', lastPut.data.version === v0 + 11, JSON.stringify(lastPut.data));
    const pruned = await call('GET', `/api/context/history/${v0 + 1}`, { key: KEY });
    check('v4.4 the 11th PUT prunes the oldest version (404)', pruned.status === 404, String(pruned.status));
    const hist2 = await call('GET', '/api/context/history', { key: KEY });
    check('v4.4 history retains exactly the last 10 versions', (hist2.data.versions || []).length === 10 && hist2.data.versions[0].n === v0 + 2 && hist2.data.versions[hist2.data.versions.length - 1].n === v0 + 11, JSON.stringify(hist2.data.versions?.map(v => v.n)));
    const snapCur = await call('GET', `/api/context/history/${v0 + 11}`, { key: KEY });
    check('v4.4 the current version is readable through the history route too', snapCur.status === 200 && snapCur.data.contextVersion === v0 + 11, JSON.stringify(snapCur.data).slice(0, 120));
    const histRo = await call('GET', '/api/context/history', { key: RO_KEY });
    check('v4.4 readonly key may read context history', histRo.status === 200 && Array.isArray(histRo.data.versions), JSON.stringify(histRo.data).slice(0, 100));
  }

  // ---------- v4.4: board carries the blocked badge + digest banner ----------
  {
    const boardHtml = await import('node:fs').then(m => m.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'));
    check('v4.4 board badges blocked tasks', boardHtml.includes('badge blocked') && boardHtml.includes('BLOCKED by'), '');
    check('v4.4 board has a dismissible digest banner fed by /api/digest', boardHtml.includes('id="digestBanner"') && boardHtml.includes('/api/digest') && boardHtml.includes('digestDismiss'), '');
  }

  const resetBad = await call('POST', '/setup/reset', { body: { currentKey: 'wrong-key-wrong-key', setupSecret: 'test-setup-secret' } });
  check('reset rejects wrong current key (403)', resetBad.status === 403, String(resetBad.status));
  const reset = await call('POST', '/setup/reset', { body: { currentKey: KEY, setupSecret: 'test-setup-secret' } });
  check('reset clears the key', reset.status === 200 && reset.data.ok, JSON.stringify(reset.data));
  const afterReset = await call('GET', '/api/tasks', { key: KEY });
  check('api locked again after reset (pristine)', afterReset.status === 401, String(afterReset.status));
} finally {
  child.kill();
}
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
