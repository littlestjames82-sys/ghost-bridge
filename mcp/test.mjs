// Ghost Bridge MCP self-test (v1.2).
// Phase A: stdio child WITHOUT relay env — context tools + local handoff file.
// Phase B: stdio child WITH relay env pointed at a stub GitHub API —
//          live relay handoff/inbox/result, live remote context, status tool.
// Phase C: setup.mjs against the stub — validates token, writes Antigravity config.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, cond, extra = '') {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

function startClient(env) {
  const child = spawn('node', [path.join(here, 'server.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', d => {
    buffer += d.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error('timeout: ' + method)), 5000);
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { child, call, notify };
}

async function toolText(client, name, args) {
  const r = await client.call('tools/call', { name, arguments: args });
  return { text: r.result?.content?.[0]?.text || '', isError: r.result?.isError };
}

// ---------- Stub GitHub API (shared by phases B and C) ----------
const stubIssues = [];
const stubFiles = {}; const stubPuts = []; const createdPayloads = [];
const remoteContext = {
  updated: '2099-01-01',
  bridge: 'remote context marker',
  profile: { assistant: 'Mr.Ghosty (remote context)', owner: 'Ryan Cotten', studio: 'Ghost Developer Studio', studio_contact: '', facebook_page: '', storefront_live: '', how_to_work_with_ryan: '' },
  projects: [{ name: 'Remote Marker Project', slug: 'remote-marker', status: 'Live from repo', summary: 'This project only exists in the repo copy of context.json.' }],
  rules: ['Remote rule marker: Sopro is the default voice engine.']
};
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://stub');
    const P = url.pathname;
    if (req.method === 'GET' && P === '/user') return send(200, { login: 'tester' });
    if (req.method === 'GET' && P === '/repos/test-owner/test-repo')
      return send(200, { full_name: 'test-owner/test-repo', private: true, permissions: { push: true, admin: false } });
    if (req.method === 'GET' && P === '/repos/test-owner/test-repo/contents/context.json')
      return send(200, { content: Buffer.from(JSON.stringify(remoteContext)).toString('base64'), sha: 'stubsha' });
    if (req.method === 'GET' && P === '/repos/test-owner/test-repo/contents/version.json')
      return send(200, { content: Buffer.from(JSON.stringify({ latest: '9.9.9' })).toString('base64'), sha: 'stubsha2' });
    const CM = P.match(/^\/repos\/test-owner\/test-repo\/contents\/(.+)$/);
    if (CM && req.method === 'GET') {
      const f = stubFiles[decodeURIComponent(CM[1])];
      if (!f) return send(404, { message: 'Not Found' });
      return send(200, { type: 'file', content: Buffer.from(f.text, 'utf8').toString('base64'), sha: f.sha });
    }
    if (CM && req.method === 'PUT') {
      const b = JSON.parse(body);
      const text = Buffer.from(String(b.content || ''), 'base64').toString('utf8');
      const p = decodeURIComponent(CM[1]);
      stubFiles[p] = { text, sha: 'sha' + stubPuts.length };
      stubPuts.push({ path: p, text, message: b.message });
      return send(201, { content: { path: p, sha: 'x' }, commit: { sha: 'c1' } });
    }
    if (req.method === 'POST' && P === '/repos/test-owner/test-repo/issues') {
      const data = JSON.parse(body);
      createdPayloads.push(data);
      const issue = { number: 7, title: data.title, body: data.body, state: 'open', html_url: 'https://example.test/issues/7', labels: [{ name: 'ghost-handoff' }], updated_at: '2026-10-06T00:00:00Z' };
      stubIssues.length = 0;
      stubIssues.push(issue);
      return send(201, issue);
    }
    if (req.method === 'GET' && P === '/search/issues')
      return send(200, { total_count: 1, items: [{ number: 7, title: 'Stub task', state: 'closed', html_url: 'https://example.test/issues/7', labels: [{ name: 'ghost-handoff' }, { name: 'done' }] }] });
    const issueAction = P.match(/^\/repos\/test-owner\/test-repo\/issues\/(\d+)\/(comments|labels(?:\/needs-approval)?)$/);
    if (issueAction && req.method === 'POST' && issueAction[2] === 'comments') return send(201, { id: 99 });
    if (issueAction && req.method === 'POST' && issueAction[2] === 'labels') return send(200, []);
    if (issueAction && req.method === 'DELETE') return send(200, []);
    if (req.method === 'PATCH' && /^\/repos\/test-owner\/test-repo\/issues\/\d+$/.test(P)) return send(200, { number: 7, state: 'closed' });
    if (req.method === 'GET' && P === '/repos/test-owner/test-repo/issues') return send(200, stubIssues);
    if (req.method === 'GET' && P === '/repos/test-owner/test-repo/issues/7')
      return send(200, { number: 7, title: 'Stub task', state: 'closed', body: 'Stub task body', html_url: 'https://example.test/issues/7', labels: [{ name: 'ghost-handoff' }, { name: 'done' }] });
    if (req.method === 'GET' && P === '/repos/test-owner/test-repo/issues/7/comments')
      return send(200, [{ user: { login: 'your-username' }, created_at: '2026-10-06T00:00:00Z', body: 'Result: bridge works.' }]);
    return send(404, { message: 'Not Found' });
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;
const stubUrl = `http://127.0.0.1:${stubPort}`;

// ---------- Phase A: local mode ----------
// v4: Phase A runs against a FIXTURE context the test writes itself (the
// public repo ships no real context.json — only context.example.json).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-fixture-'));
const fixtureContextPath = path.join(fixtureDir, 'context.json');
fs.writeFileSync(fixtureContextPath, JSON.stringify({
  updated: 'fixture',
  bridge: 'Ghost Bridge MCP test fixture context (fake data, written by test.mjs).',
  profile: { assistant: 'Mr.Ghosty (fixture)', owner: 'Ryan Cotten', studio: 'Ghost Developer Studio', studio_contact: '', facebook_page: '', storefront_live: '', how_to_work_with_ryan: 'Fixture instructions.' },
  projects: [
    { name: 'GhostCut', slug: 'ghostcut', status: 'Working — fixture project', summary: 'Fixture video editor project.' },
    { name: 'DevPulse', slug: 'devpulse', status: 'Parked — fixture project', summary: 'Fixture uptime monitoring project.' }
  ],
  rules: ['No paid spend without explicit approval (fixture rule).', 'Sopro is the default voice engine (fixture rule).']
}, null, 2));
const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-handoffs-'));
const a = startClient({ GHOST_HANDOFF_DIR: handoffDir, GHOST_CONTEXT_PATH: fixtureContextPath, GHOST_QUEUE_REPO: '', GITHUB_TOKEN: '', GHOST_GITHUB_TOKEN: '' });
const init = await a.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
check('initialize', init.result?.serverInfo?.name === 'ghost-bridge' && init.result?.serverInfo?.version === '4.4.0', init.result?.serverInfo?.version);
a.notify('notifications/initialized', {});
check('ping', (await a.call('ping', {})).result !== undefined);

const tools = await a.call('tools/list', {});
const names = tools.result.tools.map(t => t.name);
check('tools/list = 17 tools', names.length === 17, names.join(', '));

for (const [tool, args, expect] of [
  ['ghost_whoami', {}, 'NOT configured'],
  ['ghost_projects', {}, 'GhostCut'],
  ['ghost_projects', { status: 'parked' }, 'DevPulse'],
  ['ghost_project_status', { project: 'ghostcut' }, 'GhostCut'],
  ['ghost_rules', {}, 'paid spend'],
  ['ghost_search', { query: 'voice engine Sopro' }, 'Sopro'],
  ['ghost_bridge_status', {}, 'NOT configured'],
  ['ghost_handoff', { title: 'Test task', task: 'Verify the bridge works.', project: 'ghostcut' }, 'Handoff written locally']
]) {
  const { text } = await toolText(a, tool, args);
  check(`A tools/call ${tool} ${JSON.stringify(args)}`, text.includes(expect), text.slice(0, 60).replace(/\n/g, ' '));
}
check('A unknown project errors', (await toolText(a, 'ghost_project_status', { project: 'nope-nothing' })).isError === true);
check('A inbox without relay errors cleanly', (await toolText(a, 'ghost_inbox', {})).isError === true);
const handoffFiles = fs.readdirSync(handoffDir);
check('A handoff file written', handoffFiles.length === 1 && handoffFiles[0].endsWith('.md'), handoffFiles.join(','));
const resources = await a.call('resources/list', {});
check('resources/list = 3', resources.result.resources.length === 3);
const resRead = await a.call('resources/read', { uri: 'ghost://projects' });
check('resources/read ghost://projects', (resRead.result?.contents?.[0]?.text || '').includes('DevPulse'));
const prompts = await a.call('prompts/list', {});
check('prompts/list = 1', prompts.result.prompts.length === 1);
const prompt = await a.call('prompts/get', { name: 'work_like_mrghosty', arguments: { task: 'Fix the build' } });
check('prompts/get includes task', (prompt.result?.messages?.[0]?.content?.text || '').includes('Fix the build'));
a.child.kill();

// ---------- Phase B: relay mode + live remote context ----------
const b = startClient({
  GHOST_QUEUE_REPO: 'test-owner/test-repo',
  GITHUB_TOKEN: 'test-token',
  GHOST_GITHUB_API_URL: stubUrl,
  GHOST_HANDOFF_DIR: handoffDir,
  GHOST_STATE_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-state-')), 'state.json')
});
await b.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
const whoamiB = await toolText(b, 'ghost_whoami', {});
check('B whoami shows relay connected', whoamiB.text.includes('CONNECTED'));
check('B whoami shows LIVE context source', whoamiB.text.includes('live from queue repo'), whoamiB.text.split('\n').find(l => l.includes('Context source')) || '');
check('B projects come from remote context', (await toolText(b, 'ghost_projects', {})).text.includes('Remote Marker Project'));
const statusB = await toolText(b, 'ghost_bridge_status', {});
check('B status: repo reachable, queue empty', statusB.text.includes('reachable') && statusB.text.includes('Open tasks: 0'), statusB.text.split('\n')[3] || '');
check('B status: update notice from version.json', statusB.text.includes('Update available') && statusB.text.includes('9.9.9'));
const sent = await toolText(b, 'ghost_handoff', { title: 'Stub task', task: 'Do the stub thing.', project: 'remote-marker' });
check('B handoff files real queue task #7', sent.text.includes('queue #7') && sent.text.includes('example.test/issues/7'), sent.text.slice(0, 80));
check('B handoff body carries project context pack', (stubIssues[0]?.body || '').includes('This project only exists in the repo copy') && (stubIssues[0]?.body || '').includes('Remote rule marker'));
const dup = await toolText(b, 'ghost_handoff', { title: 'Stub task', task: 'Accidental resend.' });
check('B duplicate open title is blocked', dup.isError === true && dup.text.includes('already exists'), dup.text.slice(0, 60));
const inbox = await toolText(b, 'ghost_inbox', {});
check('B inbox lists the queued task', inbox.text.includes('#7') && inbox.text.includes('Stub task'));
const resultB = await toolText(b, 'ghost_task_result', { issue: 7 });
check('B task_result returns Mr.Ghosty result comment', resultB.text.includes('Result: bridge works.') && resultB.text.includes('[done]'));
const urgent = await toolText(b, 'ghost_handoff', { title: 'Urgent stub', task: 'Fast thing.', priority: 'urgent' });
check('B urgent handoff flagged URGENT', urgent.text.includes('URGENT'));
const reply = await toolText(b, 'ghost_reply', { issue: 7, message: 'Approved — go ahead.' });
check('B reply posts and clears approval hold', reply.text.includes('needs-approval hold cleared'));
const newFirst = await toolText(b, 'ghost_new_results', {});
check('B new_results first check surfaces activity', newFirst.text.includes('#7'));
const newSecond = await toolText(b, 'ghost_new_results', {});
check('B new_results second check is quiet', newSecond.text.includes('No new Ghost Bridge activity'));
const search = await toolText(b, 'ghost_search_tasks', { query: 'stub' });
check('B search_tasks finds the task', search.text.includes('Stub task'));
const cancel = await toolText(b, 'ghost_cancel_task', { issue: 7 });
check('B cancel closes the task', cancel.text.includes('cancelled and closed'));
b.child.kill();

// ---------- Phase B2: gh-CLI auth mode via a fake `gh` binary ----------
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-fakebin-'));
fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.0.0 (fake)'); process.exit(0); }
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'api') {
  const apiPath = args[1];
  const mi = args.indexOf('--method');
  const method = mi >= 0 ? args[mi + 1] : 'GET';
  const go = async (input) => {
    const res = await fetch(process.env.GHOST_TEST_STUB + '/' + apiPath, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : (input || undefined) });
    const t = await res.text();
    process.stdout.write(t);
    if (!res.ok) { console.error('gh: HTTP ' + res.status); process.exit(1); }
  };
  if (method === 'GET') { go(''); } else {
    let input = '';
    process.stdin.on('data', c => { input += c; });
    process.stdin.on('end', () => go(input));
  }
} else { console.error('fake gh: unexpected args'); process.exit(2); }
`, { mode: 0o755 });
const ghEnv = {
  GHOST_QUEUE_REPO: 'test-owner/test-repo',
  GITHUB_TOKEN: '', GHOST_GITHUB_TOKEN: '',
  PATH: fakeBin + ':' + process.env.PATH,
  GHOST_TEST_STUB: stubUrl,
  GHOST_HANDOFF_DIR: handoffDir,
  GHOST_STATE_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-state2-')), 'state.json')
};
const b2 = startClient(ghEnv);
await b2.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
check('B2 whoami shows gh-CLI auth', (await toolText(b2, 'ghost_whoami', {})).text.includes('GitHub CLI (gh) logged-in session'));
const ghSent = await toolText(b2, 'ghost_handoff', { title: 'GH mode task', task: 'Sent through the fake gh binary.' });
check('B2 handoff works over gh CLI', ghSent.text.includes('queue #'), ghSent.text.slice(0, 60));
check('B2 inbox works over gh CLI', (await toolText(b2, 'ghost_inbox', {})).text.includes('GH mode task'));
b2.child.kill();

// ---------- Phase C: setup.mjs ----------
// NOTE: async spawn is required — the stub GitHub API lives in this same
// process, and a blocking spawnSync would deadlock its event loop.
function runSetup(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(here, 'setup.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ status: code, stdout: out, stderr: err }));
    setTimeout(() => { child.kill(); reject(new Error('setup timed out')); }, 10000);
  });
}
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-home-'));
const setupEnv = {
  ...process.env,
  HOME: fakeHome,
  GEMINI_CONFIG_DIR: path.join(fakeHome, '.gemini', 'config'),
  BRIDGE_TOKEN: 'test-token',
  GHOST_QUEUE_REPO: 'test-owner/test-repo',
  GHOST_GITHUB_API_URL: stubUrl
};
const run1 = await runSetup(['--yes', '--pack'], setupEnv);
check('C setup exits 0', run1.status === 0, (run1.stdout || '').split('\n').slice(-3).join(' '));
const globalAgents = path.join(fakeHome, '.gemini', 'AGENTS.md');
check('C --pack installs global Ghost rules', fs.existsSync(globalAgents) && fs.readFileSync(globalAgents, 'utf8').includes('ghost-bridge:start'));
const cfgFile = path.join(fakeHome, '.gemini', 'config', 'mcp_config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
check('C config has ghost-bridge entry with token + repo', cfg.mcpServers?.['ghost-bridge']?.env?.GITHUB_TOKEN === 'test-token' && cfg.mcpServers['ghost-bridge'].env.GHOST_QUEUE_REPO === 'test-owner/test-repo');
check('C config points at this server.js', (cfg.mcpServers['ghost-bridge'].args?.[0] || '').endsWith('server.js'));
const run2 = await runSetup(['--yes', '--pack'], setupEnv);
const backups = fs.readdirSync(path.dirname(cfgFile)).filter(f => f.includes('.bak-'));
check('C second run backs up existing config', run2.status === 0 && backups.length === 1, backups.join(','));
const packCount = (fs.readFileSync(globalAgents, 'utf8').match(/ghost-bridge:start/g) || []).length;
check('C --pack twice does not duplicate the section', packCount === 1, `sections: ${packCount}`);
const badRun = await runSetup(['--check'], { ...setupEnv, BRIDGE_TOKEN: 'test-token', GHOST_QUEUE_REPO: 'nope/nope' });
check('C bad repo rejected with exit 1', badRun.status === 1);
const removeRun = await runSetup(['--remove'], setupEnv);
const cfgAfterRemove = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
check('C --remove deletes the ghost-bridge entry', removeRun.status === 0 && !cfgAfterRemove.mcpServers?.['ghost-bridge']);

// ---------- Phase C2: setup in gh-CLI mode (no token anywhere) ----------
const fakeHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-home2-'));
const setupEnvGh = {
  ...setupEnv,
  HOME: fakeHome2,
  GEMINI_CONFIG_DIR: path.join(fakeHome2, '.gemini', 'config'),
  PATH: fakeBin + ':' + process.env.PATH,
  GHOST_TEST_STUB: stubUrl
};
delete setupEnvGh.BRIDGE_TOKEN;
const ghSetupRun = await runSetup(['--yes'], setupEnvGh);
check('C2 setup succeeds in gh mode without a token', ghSetupRun.status === 0, (ghSetupRun.stdout || '').split('\n').slice(-2).join(' '));
const cfgGh = JSON.parse(fs.readFileSync(path.join(fakeHome2, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
check('C2 config uses gh auth, contains NO token', cfgGh.mcpServers?.['ghost-bridge']?.env?.GHOST_QUEUE_VIA_GH === '1' && !('GITHUB_TOKEN' in (cfgGh.mcpServers['ghost-bridge'].env || {})));

// --- v2.0: capsules, notes, board ---
const c = startClient({
  GHOST_QUEUE_REPO: 'test-owner/test-repo', GITHUB_TOKEN: 'test-token', GHOST_GITHUB_TOKEN: '',
  GHOST_GITHUB_API_URL: stubUrl, GHOST_STATE_PATH: path.join(handoffDir, 'state2.json')
});
await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
const cap1 = (await toolText(c, 'ghost_capsule', { project: 'remote-marker' })).text;
check('capsule auto-creates on first read', cap1.includes('Capsule — Remote Marker Project') && stubPuts.some(p => p.path === 'capsules/remote-marker.md'), cap1.slice(0, 80));
const putsAfterCreate = stubPuts.filter(p => p.path === 'capsules/remote-marker.md').length;
const cap2 = (await toolText(c, 'ghost_capsule', { project: 'remote-marker' })).text;
check('capsule second read comes from the repo file', cap2.includes('Capsule — Remote Marker Project') && stubPuts.filter(p => p.path === 'capsules/remote-marker.md').length === putsAfterCreate);
const capUp = (await toolText(c, 'ghost_capsule_update', { project: 'remote-marker', state: 'BRAND NEW STATE LINE', note: 'Antigravity session: tested things.' })).text;
check('capsule update reports success', capUp.includes('updated'), capUp.slice(0, 80));
const cap3 = (await toolText(c, 'ghost_capsule', { project: 'remote-marker' })).text;
check('capsule update replaced State and appended log', cap3.includes('BRAND NEW STATE LINE') && cap3.includes('Antigravity session: tested things.'), cap3.slice(0, 120));
const before = createdPayloads.length;
const note = (await toolText(c, 'ghost_publish_note', { title: 'Ryan decided X', body: 'Decision details here.', project: 'remote-marker' })).text;
const notePayload = createdPayloads[createdPayloads.length - 1];
check('note filed as ghost-note issue', createdPayloads.length === before + 1 && note.includes('Note sent') && JSON.stringify(notePayload.labels).includes('ghost-note') && String(notePayload.title).startsWith('[Note]'), note.slice(0, 80));
const boardGen = (await toolText(c, 'ghost_board', {})).text;
check('board generates live when BOARD.md missing', boardGen.includes('## Queued') && boardGen.includes('## Waiting on Ryan'), boardGen.slice(0, 80));
stubFiles['BOARD.md'] = { text: '# Ghost Bridge Board\n\n## Queued\n- #9 seeded board entry', sha: 'sb1' };
const boardRead = (await toolText(c, 'ghost_board', {})).text;
check('board reads BOARD.md when present', boardRead.includes('seeded board entry'));
c.child.kill();


// ---------- Phase D: hosted relay mode ----------
const relayTasks = []; let relayCounter = 0; const relayFiles = {}; let relayRegisteredKey = '';
const relayPresence = []; let heartbeatCount = 0;
const relayLabels = t => ['ghost-handoff', ...(t.priority === 'urgent' && !['done','cancelled'].includes(t.status) ? ['urgent'] : []), ...(t.status === 'in-progress' ? ['in-progress'] : []), ...(t.status === 'needs-approval' ? ['needs-approval'] : []), ...(t.status === 'done' ? ['done'] : []), ...(t.status === 'cancelled' ? ['cancelled'] : [])];
const relayStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && new URL(req.url, 'http://stub').pathname === '/setup') {
      const sb = body ? JSON.parse(body) : {};
      if (sb.setupSecret !== 'pair-code') return send(403, { error: 'bad setup secret' });
      if (relayRegisteredKey) return send(409, { error: 'already registered' });
      relayRegisteredKey = sb.key;
      return send(200, { ok: true });
    }
    if (req.headers['x-bridge-key'] !== 'relay-test-key' && req.headers['x-bridge-key'] !== relayRegisteredKey) return send(401, { error: 'missing or wrong bridge key' });
    const url = new URL(req.url, 'http://stub');
    const P = url.pathname;
    const b = body ? JSON.parse(body) : {};
    if (req.method === 'GET' && P === '/api/meta') return send(200, { server: 'ghost-bridge-relay', version: '3.0.0', tasks: relayTasks.length, open: relayTasks.filter(t => !['done','cancelled'].includes(t.status)).length });
    if (req.method === 'POST' && P === '/api/presence') {
      heartbeatCount++;
      const rec = { name: 'primary', displayName: b.displayName || null, capabilities: b.capabilities || [], status: b.status || 'online', lastSeen: new Date().toISOString() };
      const ix = relayPresence.findIndex(a => a.name === rec.name);
      if (ix >= 0) relayPresence[ix] = rec; else relayPresence.push(rec);
      return send(200, { ok: true, agent: rec });
    }
    if (req.method === 'GET' && P === '/api/presence') return send(200, { agents: relayPresence, windowMinutes: 10 });
    if (req.method === 'GET' && P === '/api/context') return send(200, remoteContext);
    if (req.method === 'GET' && P === '/api/files') { const p = url.searchParams.get('path'); return (p in relayFiles) ? send(200, { path: p, text: relayFiles[p] }) : send(404, { error: 'file not found' }); }
    if (req.method === 'PUT' && P === '/api/files') { relayFiles[b.path] = b.text; return send(200, { ok: true }); }
    if (req.method === 'GET' && P === '/api/tasks') {
      let ts = relayTasks.slice();
      const state = url.searchParams.get('state') || 'all';
      if (state === 'open') ts = ts.filter(t => !['done','cancelled'].includes(t.status));
      return send(200, { tasks: ts.sort((x, y) => y.id - x.id).map(t => ({ ...t, labels: relayLabels(t) })) });
    }
    if (req.method === 'POST' && P === '/api/tasks') {
      if (b.idempotencyKey) {
        const existing = relayTasks.find(x => x.idemKey === b.idempotencyKey);
        if (existing) return send(200, { ...existing, labels: relayLabels(existing), duplicateSuppressed: true });
      }
      const t = { id: ++relayCounter, type: b.type === 'note' ? 'note' : 'task', title: b.title, body: b.body, project: b.project || null, priority: b.priority || 'normal', status: 'queued', comments: [], attachments: b.attachments || [], result: null, claimedBy: null, claimExpiresAt: null, ...(b.idempotencyKey ? { idemKey: b.idempotencyKey } : {}), createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', closedAt: null };
      relayTasks.push(t);
      return send(201, { ...t, labels: relayLabels(t) });
    }
    const tm = P.match(/^\/api\/tasks\/(\d+)$/);
    if (tm && req.method === 'GET') { const t = relayTasks.find(x => x.id === Number(tm[1])); return t ? send(200, { ...t, labels: relayLabels(t) }) : send(404, { error: 'task not found' }); }
    if (tm && req.method === 'PATCH') { const t = relayTasks.find(x => x.id === Number(tm[1])); if (!t) return send(404, { error: 'task not found' }); t.status = b.status; t.updatedAt = '2026-10-06T01:00:00Z'; return send(200, { ...t, labels: relayLabels(t) }); }
    const cm2 = P.match(/^\/api\/tasks\/(\d+)\/comments$/);
    if (cm2 && req.method === 'POST') { const t = relayTasks.find(x => x.id === Number(cm2[1])); if (!t) return send(404, { error: 'task not found' }); t.comments.push({ author: b.author || 'antigravity', body: b.body, at: '2026-10-06T00:30:00Z', ...(b.result ? { result: b.result } : {}) }); return send(201, { ...t, labels: relayLabels(t) }); }
    return send(404, { error: 'not found' });
  });
});
await new Promise(r => relayStub.listen(0, '127.0.0.1', r));
const relayUrl = `http://127.0.0.1:${relayStub.address().port}`;
const d = startClient({ GHOST_RELAY_URL: relayUrl, GHOST_BRIDGE_KEY: 'relay-test-key', GHOST_QUEUE_REPO: '', GITHUB_TOKEN: '', GHOST_GITHUB_TOKEN: '', GHOST_STATE_PATH: path.join(handoffDir, 'state-relay.json') });
await d.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
const whoamiD = (await toolText(d, 'ghost_whoami', {})).text;
check('D whoami shows hosted relay connected', whoamiD.includes('hosted Ghost Bridge Relay'), whoamiD.slice(0, 100));
const statusD = (await toolText(d, 'ghost_bridge_status', {})).text;
check('D status reads relay meta', statusD.includes('HOSTED relay') && statusD.includes('reachable'), statusD.slice(0, 120));
check('D v4.3 status lists online agents from presence', statusD.includes('Online agents') && statusD.includes('Ghost Bridge MCP client'), statusD.slice(0, 200));
check('D v4.3 status sent an automatic heartbeat first', heartbeatCount >= 1, String(heartbeatCount));
const handD = (await toolText(d, 'ghost_handoff', { title: 'Relay task', task: 'Do it via the relay.', project: 'remote-marker', priority: 'urgent' })).text;
check('D handoff files relay task', handD.includes('relay #1') && handD.includes('URGENT'), handD.slice(0, 100));
check('D relay task carries capsule pointer', (relayTasks[0]?.body || '').includes('capsules/remote-marker.md'));
const dupD = (await toolText(d, 'ghost_handoff', { title: 'Relay task', task: 'Same title again.' })).text;
check('D duplicate guard hits relay open tasks', dupD.includes('already exists'), dupD.slice(0, 80));
const inboxD = (await toolText(d, 'ghost_inbox', {})).text;
check('D inbox lists relay task as queued', inboxD.includes('#1 [queued] Relay task'), inboxD.slice(0, 80));
relayTasks[0].status = 'needs-approval';
const replyD = (await toolText(d, 'ghost_reply', { issue: 1, message: 'Approved — go ahead.' })).text;
check('D reply clears hold and re-queues', replyD.includes('hold cleared') && relayTasks[0].status === 'queued', replyD.slice(0, 80) + ' | ' + relayTasks[0].status);
const resultD = (await toolText(d, 'ghost_task_result', { issue: 1 })).text;
check('D task_result shows relay thread', resultD.includes('Reply from Ryan (via Antigravity)'), resultD.slice(0, 100));
const capD1 = (await toolText(d, 'ghost_capsule', { project: 'remote-marker' })).text;
check('D capsule auto-creates in relay files', capD1.includes('Capsule — Remote Marker Project') && 'capsules/remote-marker.md' in relayFiles, capD1.slice(0, 60));
const capD2 = (await toolText(d, 'ghost_capsule_update', { project: 'remote-marker', next: 'Relay next step.' })).text;
const capD3 = (await toolText(d, 'ghost_capsule', { project: 'remote-marker' })).text;
check('D capsule update persists in relay', capD2.includes('updated') && capD3.includes('Relay next step.'), capD3.slice(0, 100));
const noteD = (await toolText(d, 'ghost_publish_note', { title: 'Relay note', body: 'Note body.' })).text;
check('D note filed in relay as type note', noteD.includes('Note sent') && relayTasks.some(t => t.type === 'note'), noteD.slice(0, 80));
const boardD = (await toolText(d, 'ghost_board', {})).text;
check('D board generates from relay tasks', boardD.includes('## Queued') && boardD.includes('Relay task'), boardD.slice(0, 100));
const cancelD = (await toolText(d, 'ghost_cancel_task', { issue: 1 })).text;
check('D cancel marks relay task cancelled', cancelD.includes('cancelled') && relayTasks[0].status === 'cancelled', cancelD.slice(0, 60));
// v4: attachments + structured results through the local MCP server
const logB64 = Buffer.from('fake log contents').toString('base64');
const handAtt = (await toolText(d, 'ghost_handoff', { title: 'Attachment task', task: 'Read the attached log.', attachments: [{ name: 'log.txt', mime: 'text/plain', dataBase64: logB64 }] })).text;
const attTaskD = relayTasks.find(t => t.title === 'Attachment task');
check('D v4 handoff carries attachments to the relay', handAtt.includes('Attachments:') && handAtt.includes('log.txt') && attTaskD?.attachments?.length === 1 && attTaskD.attachments[0].dataBase64 === logB64, handAtt.slice(0, 100));
check('D v4 attachment size computed from inline data', attTaskD?.attachments?.[0]?.size === Buffer.byteLength('fake log contents'), JSON.stringify(attTaskD?.attachments?.[0] || {}));
const bigAtt = await toolText(d, 'ghost_handoff', { title: 'Too big', task: 'x', attachments: [{ name: 'big.bin', dataBase64: Buffer.alloc(300 * 1024).toString('base64') }] });
check('D v4 oversize attachment rejected client-side', bigAtt.isError === true && bigAtt.text.includes('too large inline'), bigAtt.text.slice(0, 80));
attTaskD.comments.push({ author: 'mrghosty', body: 'Finished.', at: '2026-10-06T02:00:00Z', result: { status: 'done', summary: 'All good', files: ['report.md'] } });
const resultAtt = (await toolText(d, 'ghost_task_result', { issue: attTaskD.id })).text;
check('D v4 task_result surfaces attachments + structured result', resultAtt.includes('--- Attachments ---') && resultAtt.includes('log.txt') && resultAtt.includes('All good') && resultAtt.includes('report.md'), resultAtt.slice(0, 160));
// v4.1: idempotent handoffs + lease surfacing through the local MCP client
const handIdem = (await toolText(d, 'ghost_handoff', { title: 'Idempotent relay task', task: 'File once.', idempotencyKey: 'client-idem-1' })).text;
check('D v4.1 idempotent handoff files a task', handIdem.includes('relay #'), handIdem.slice(0, 80));
const idemCount = relayTasks.length;
const handIdem2 = (await toolText(d, 'ghost_handoff', { title: 'Idempotent relay task', task: 'File once.', idempotencyKey: 'client-idem-1' })).text;
check('D v4.1 re-handoff with same idempotency key is suppressed, no duplicate created', handIdem2.includes('Duplicate suppressed') && relayTasks.length === idemCount, handIdem2.slice(0, 100));
const leaseStubTask = relayTasks.find(t => t.title === 'Idempotent relay task');
leaseStubTask.claimedBy = 'primary'; leaseStubTask.claimExpiresAt = '2099-01-01T00:00:00.000Z';
const leaseResultD = (await toolText(d, 'ghost_task_result', { issue: leaseStubTask.id })).text;
check('D v4.1 task_result surfaces claim lease', leaseResultD.includes('Claimed by: primary'), leaseResultD.slice(0, 120));
d.child.kill();

// ---------- Phase E: setup.mjs --relay ----------
const fakeHome3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-home3-'));
const relaySetupEnv = { ...process.env, HOME: fakeHome3, GEMINI_CONFIG_DIR: path.join(fakeHome3, '.gemini', 'config'), BRIDGE_RELAY_URL: relayUrl, BRIDGE_PAIRING_CODE: 'pair-code' };
const e1 = await runSetup(['--relay', '--yes'], relaySetupEnv);
check('E relay setup exits 0', e1.status === 0, (e1.stdout + e1.stderr).split('\n').slice(-3).join(' '));
const cfgE = JSON.parse(fs.readFileSync(path.join(fakeHome3, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
check('E config is relay-only (URL, no keys/tokens)', cfgE.mcpServers?.['ghost-bridge']?.env?.GHOST_RELAY_URL === relayUrl && !JSON.stringify(cfgE).includes('BRIDGE') && !('GITHUB_TOKEN' in (cfgE.mcpServers['ghost-bridge'].env || {})) && !('GHOST_BRIDGE_KEY' in (cfgE.mcpServers['ghost-bridge'].env || {})), JSON.stringify(cfgE).slice(0, 160));
const credFile = path.join(fakeHome3, '.ghost-bridge', 'credentials');
const credOk = fs.existsSync(credFile) && fs.readFileSync(credFile, 'utf8').trim() === relayRegisteredKey && relayRegisteredKey.length >= 32;
check('E credentials file holds the registered key', credOk);
const e2 = await runSetup(['--relay', '--yes'], relaySetupEnv);
check('E second run recognizes its key (idempotent)', e2.status === 0 && (e2.stdout || '').includes('already knows'), (e2.stdout || '').split('\n').slice(-2).join(' '));
relayStub.close();

// ---------- Phase F: offline outbox (v4.2) ----------
// 1) Client points at a DEAD relay port: handoffs must queue locally.
// 2) The real relay comes up on that port: the next status call flushes.
// 3) Relay HTTP errors must NOT queue.
const portProbe = http.createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const outboxPort = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-outbox-'));
const outboxPath = path.join(outboxDir, 'outbox.json');
const readOutbox = () => { try { return JSON.parse(fs.readFileSync(outboxPath, 'utf8')).entries || []; } catch { return []; } };
const f = startClient({
  GHOST_RELAY_URL: `http://127.0.0.1:${outboxPort}`, GHOST_BRIDGE_KEY: 'outbox-test-key-0123456789abcdef',
  GHOST_QUEUE_REPO: '', GITHUB_TOKEN: '', GHOST_GITHUB_TOKEN: '',
  GHOST_CONTEXT_PATH: fixtureContextPath, GHOST_STATE_PATH: path.join(outboxDir, 'state.json'), GHOST_OUTBOX_PATH: outboxPath
});
await f.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
const q1 = await toolText(f, 'ghost_handoff', { title: 'Outbox task one', task: 'Queued while the relay was down.', project: 'ghostcut' });
check('F dead-relay handoff says QUEUED locally, NOT delivered', q1.isError === true && q1.text.includes('QUEUED locally') && q1.text.includes('NOT delivered'), q1.text.slice(0, 120));
const ob1 = readOutbox();
check('F outbox file holds the handoff with a queue-time idempotency key', ob1.length === 1 && ob1[0].title === 'Outbox task one' && typeof ob1[0].idempotencyKey === 'string' && ob1[0].idempotencyKey.length >= 8 && ob1[0].body.includes('Queued while the relay was down.'), JSON.stringify(ob1[0] || {}).slice(0, 140));
const q2 = await toolText(f, 'ghost_handoff', { title: 'Outbox task two', task: 'Also queued offline.', attachments: [{ name: 'meta.txt', mime: 'text/plain', dataBase64: Buffer.from('meta').toString('base64') }] });
check('F second offline handoff queues behind the first (order kept)', q2.isError === true && readOutbox().length === 2 && readOutbox()[1].attachments?.[0]?.name === 'meta.txt', q2.text.slice(0, 60));
const stDown = (await toolText(f, 'ghost_bridge_status', {})).text;
check('F status while down reports outbox pending count', stDown.includes('NOT reachable') && stDown.includes('Outbox: 2 pending'), stDown.split('\n').slice(0, 5).join(' | '));
// Bring the REAL relay up on the same port and register the client's key.
const relayChild = spawn('node', [path.join(here, '..', 'relay', 'local-server.mjs'), String(outboxPort)], {
  env: { ...process.env, BRIDGE_SETUP_SECRET: 'outbox-secret' }, stdio: ['ignore', 'ignore', 'inherit']
});
let relayUp = false;
for (let i = 0; i < 40 && !relayUp; i++) {
  try { const h = await fetch(`http://127.0.0.1:${outboxPort}/health`); relayUp = h.status === 200; } catch { await new Promise(r => setTimeout(r, 250)); }
}
check('F real relay came up on the previously dead port', relayUp);
await fetch(`http://127.0.0.1:${outboxPort}/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'outbox-test-key-0123456789abcdef', setupSecret: 'outbox-secret' }) });
const stUp = (await toolText(f, 'ghost_bridge_status', {})).text;
check('F next status call flushes the outbox and reports it', stUp.includes('reachable') && stUp.includes('flushed 2') && stUp.includes('0 pending'), stUp.split('\n').slice(0, 6).join(' | '));
const relayTasksNow = async () => (await (await fetch(`http://127.0.0.1:${outboxPort}/api/tasks?state=all&limit=100`, { headers: { 'x-bridge-key': 'outbox-test-key-0123456789abcdef' } })).json()).tasks;
const afterFlush = await relayTasksNow();
check('F flushed tasks exist on the relay exactly once each', afterFlush.filter(t => t.title === 'Outbox task one').length === 1 && afterFlush.filter(t => t.title === 'Outbox task two').length === 1, JSON.stringify(afterFlush.map(t => t.title)));
check('F outbox is empty after the flush', readOutbox().length === 0, String(readOutbox().length));
await toolText(f, 'ghost_bridge_status', {});
const afterSecond = await relayTasksNow();
check('F a later status call creates no duplicates (idempotent flush)', afterSecond.length === afterFlush.length, `${afterFlush.length} -> ${afterSecond.length}`);
f.child.kill();
// HTTP errors are answers, not outages: a wrong key gets 401 and NO queueing.
const outboxPath2 = path.join(outboxDir, 'outbox2.json');
const f2 = startClient({
  GHOST_RELAY_URL: `http://127.0.0.1:${outboxPort}`, GHOST_BRIDGE_KEY: 'wrong-key-wrong-key-0123456789',
  GHOST_QUEUE_REPO: '', GITHUB_TOKEN: '', GHOST_GITHUB_TOKEN: '',
  GHOST_CONTEXT_PATH: fixtureContextPath, GHOST_STATE_PATH: path.join(outboxDir, 'state2.json'), GHOST_OUTBOX_PATH: outboxPath2
});
await f2.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
const qErr = await toolText(f2, 'ghost_handoff', { title: 'Should not queue', task: 'The relay will 401 this.' });
let ob2 = [];
try { ob2 = JSON.parse(fs.readFileSync(outboxPath2, 'utf8')).entries || []; } catch { /* no file = nothing queued */ }
check('F relay HTTP error (401) does NOT go to the outbox', qErr.isError === true && !qErr.text.includes('QUEUED locally') && qErr.text.includes('401') && ob2.length === 0, qErr.text.slice(0, 110));
f2.child.kill();
relayChild.kill();

// ---------- Phase G: v4.3 against the REAL relay ----------
// Capsule revision lifecycle, scheduled handoffs, inbox pagination, and
// archived search — the local MCP talking to a real relay server.
const gPortProbe = http.createServer();
await new Promise(r => gPortProbe.listen(0, '127.0.0.1', r));
const gPort = gPortProbe.address().port;
await new Promise(r => gPortProbe.close(r));
const GKEY = 'phase-g-key-0123456789abcdef';
const gRelayChild = spawn('node', [path.join(here, '..', 'relay', 'local-server.mjs'), String(gPort)], {
  env: { ...process.env, BRIDGE_SETUP_SECRET: 'phase-g-secret' }, stdio: ['ignore', 'ignore', 'inherit']
});
let gUp = false;
for (let i = 0; i < 40 && !gUp; i++) {
  try { const h = await fetch(`http://127.0.0.1:${gPort}/health`); gUp = h.status === 200; } catch { await new Promise(r => setTimeout(r, 250)); }
}
check('G real relay up', gUp);
await fetch(`http://127.0.0.1:${gPort}/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: GKEY, setupSecret: 'phase-g-secret' }) });
const gApi = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${gPort}${p}`, { method, headers: { 'Content-Type': 'application/json', 'x-bridge-key': GKEY }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
// Seed one already-archived task through import (relay is still empty).
const seedImport = await gApi('POST', '/api/import', {
  format: 'ghost-bridge-export', version: '4.3.0', keys: [], files: {}, context: null, counter: 1,
  tasks: [{ id: 1, type: 'task', title: 'G archived relic', body: 'ancient archived work', project: null, priority: 'normal', status: 'done', comments: [], attachments: [], result: null, createdBy: 'primary', claimedBy: null, claimExpiresAt: null, archived: true, archivedAt: '2026-10-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z', closedAt: '2020-01-02T00:00:00.000Z' }]
});
check('G seed import (with an archived task) accepted', seedImport.status === 200, JSON.stringify(seedImport.data).slice(0, 120));
const g = startClient({
  GHOST_RELAY_URL: `http://127.0.0.1:${gPort}`, GHOST_BRIDGE_KEY: GKEY,
  GHOST_QUEUE_REPO: '', GITHUB_TOKEN: '', GHOST_GITHUB_TOKEN: '',
  GHOST_CONTEXT_PATH: fixtureContextPath, GHOST_STATE_PATH: path.join(outboxDir, 'state-g.json'), GHOST_OUTBOX_PATH: path.join(outboxDir, 'outbox-g.json')
});
await g.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
const gStatus = (await toolText(g, 'ghost_bridge_status', {})).text;
check('G status lists this client in online agents (auto-heartbeat)', gStatus.includes('Online agents') && gStatus.includes('Ghost Bridge MCP client'), gStatus.slice(0, 220));
const gSearchArch = (await toolText(g, 'ghost_search_tasks', { query: 'archived relic' })).text;
check('G search finds archived tasks and marks them [archived]', gSearchArch.includes('[archived]') && gSearchArch.includes('G archived relic'), gSearchArch.slice(0, 120));
const gInbox0 = (await toolText(g, 'ghost_inbox', {})).text;
check('G inbox excludes archived tasks', !gInbox0.includes('G archived relic'), gInbox0.slice(0, 120));
// Capsule revisions end-to-end: create (rev 1) -> tool update (rev 2).
const gCap1 = (await toolText(g, 'ghost_capsule', { project: 'ghostcut' })).text;
check('G capsule auto-creates on the real relay', gCap1.includes('Capsule') && gCap1.includes('GhostCut'), gCap1.slice(0, 80));
const gFile1 = await gApi('GET', '/api/files?path=' + encodeURIComponent('capsules/ghostcut.md'));
check('G freshly created capsule file is rev 1', gFile1.data.rev === 1, JSON.stringify(gFile1.data).slice(0, 80));
const gCapUpd = (await toolText(g, 'ghost_capsule_update', { project: 'ghostcut', state: 'Phase G state marker.' })).text;
check('G capsule update passes expectedRev and lands at rev 2', gCapUpd.includes('updated') && gCapUpd.includes('rev 2'), gCapUpd.slice(0, 140));
const gFile2 = await gApi('GET', '/api/files?path=' + encodeURIComponent('capsules/ghostcut.md'));
check('G capsule content + rev persisted on the relay', gFile2.data.rev === 2 && gFile2.data.text.includes('Phase G state marker.'), JSON.stringify(gFile2.data).slice(0, 100));
// Scheduling through the local handoff tool.
const gSched = (await toolText(g, 'ghost_handoff', { title: 'G scheduled task', task: 'Wait for the future.', schedule: '2999-01-01T00:00:00.000Z' })).text;
check('G scheduled handoff result carries the skip wording', gSched.includes('should NOT be picked up before 2999-01-01'), gSched.slice(0, 200));
const gSchedTask = (await gApi('GET', '/api/tasks?state=all&limit=100')).data.tasks.find(t => t.title === 'G scheduled task');
check('G relay stored notBefore and flags the task scheduled', !!gSchedTask && gSchedTask.notBefore === '2999-01-01T00:00:00.000Z' && gSchedTask.scheduled === true, JSON.stringify(gSchedTask || {}).slice(0, 160));
const gSchedResult = (await toolText(g, 'ghost_task_result', { issue: gSchedTask.id })).text;
check('G task_result shows the Scheduled line', gSchedResult.includes('Scheduled: not before 2999-01-01'), gSchedResult.slice(0, 200));
const gDue = (await toolText(g, 'ghost_handoff', { title: 'G overdue task', task: 'Should have happened already.', due: '2020-01-01T00:00:00.000Z' })).text;
const gDueTask = (await gApi('GET', '/api/tasks?state=all&limit=100')).data.tasks.find(t => t.title === 'G overdue task');
check('G due handoff files and the relay flags it overdue', gDue.includes('relay #') && !!gDueTask && gDueTask.overdue === true, JSON.stringify(gDueTask || {}).slice(0, 120));
const gInboxFlags = (await toolText(g, 'ghost_inbox', { limit: 10 })).text;
check('G inbox lines carry [scheduled] and [OVERDUE] markers', gInboxFlags.includes('[scheduled') && gInboxFlags.includes('[OVERDUE]'), gInboxFlags.slice(0, 300));
const gBadDue = await toolText(g, 'ghost_handoff', { title: 'G bad due task', task: 'x', due: 'not-a-date' });
const gAfterBad = (await gApi('GET', '/api/tasks?state=all&limit=100')).data.tasks;
check('G malformed due is rejected client-side and files nothing', gBadDue.isError === true && gBadDue.text.includes('not a recognizable date') && !gAfterBad.some(t => t.title === 'G bad due task'), gBadDue.text.slice(0, 120));
// Pagination through ghost_inbox over 15 fresh tasks.
for (let i = 1; i <= 15; i++) await gApi('POST', '/api/tasks', { title: `G page task ${String(i).padStart(2, '0')}`, body: 'pagination via inbox' });
const gPageA = (await toolText(g, 'ghost_inbox', { limit: 5, offset: 0 })).text;
const gPageB = (await toolText(g, 'ghost_inbox', { limit: 5, offset: 5 })).text;
const gIdsA = [...gPageA.matchAll(/#(\d+) \[/g)].map(x => Number(x[1]));
const gIdsB = [...gPageB.matchAll(/#(\d+) \[/g)].map(x => Number(x[1]));
check('G ghost_inbox limit/offset pages are full and disjoint', gIdsA.length === 5 && gIdsB.length === 5 && !gIdsA.some(id => gIdsB.includes(id)), `A=${gIdsA} B=${gIdsB}`);
// v4.4: dependencies through the local MCP + digest section in status.
const gBlocker = (await toolText(g, 'ghost_handoff', { title: 'G v4.4 blocker', task: 'Finish me first.' })).text;
const gBlockerTask = (await gApi('GET', '/api/tasks?state=all&limit=100')).data.tasks.find(t => t.title === 'G v4.4 blocker');
check('G v4.4 blocker handoff filed', gBlocker.includes('relay #') && !!gBlockerTask, gBlocker.slice(0, 80));
const gDep = (await toolText(g, 'ghost_handoff', { title: 'G v4.4 dependent', task: 'Wait for the blocker.', blockedBy: [gBlockerTask.id] })).text;
const gDepTask = (await gApi('GET', '/api/tasks?state=all&limit=100')).data.tasks.find(t => t.title === 'G v4.4 dependent');
check('G v4.4 handoff with blockedBy files and reports the block', gDep.includes('Blocked by:') && gDep.includes('#' + gBlockerTask.id) && !!gDepTask && JSON.stringify(gDepTask.blockedBy) === JSON.stringify([gBlockerTask.id]) && gDepTask.blocked === true, gDep.slice(0, 160));
const gDepInbox = (await toolText(g, 'ghost_inbox', { limit: 5 })).text;
check('G v4.4 inbox marks the dependent [BLOCKED by #n]', gDepInbox.includes(`[BLOCKED by #${gBlockerTask.id}]`), gDepInbox.slice(0, 200));
const gDepResult = (await toolText(g, 'ghost_task_result', { issue: gDepTask.id })).text;
check('G v4.4 task_result explains the block', gDepResult.includes('Blocked by:') && gDepResult.includes('cannot be claimed'), gDepResult.slice(0, 200));
const gBadDep = await toolText(g, 'ghost_handoff', { title: 'G v4.4 dangling dep', task: 'x', blockedBy: [999999] });
check('G v4.4 dangling blocker -> Not sent, nothing filed', gBadDep.isError === true && gBadDep.text.includes('Not sent') && gBadDep.text.includes('does not exist') && !(await gApi('GET', '/api/tasks?state=all&limit=100')).data.tasks.some(t => t.title === 'G v4.4 dangling dep'), gBadDep.text.slice(0, 140));
const gAliasDep = (await toolText(g, 'ghost_handoff', { title: 'G v4.4 alias dependent', task: 'Via dependsOn.', dependsOn: [gBlockerTask.id] })).text;
check('G v4.4 dependsOn alias works through the local MCP', gAliasDep.includes('Blocked by:') && gAliasDep.includes('#' + gBlockerTask.id), gAliasDep.slice(0, 140));
const gStatus44 = (await toolText(g, 'ghost_bridge_status', {})).text;
check('G v4.4 status carries the Digest (24h) section from /api/digest', gStatus44.includes('Digest (24h):') && gStatus44.includes('Waiting on Ryan:') && gStatus44.includes('New notes:'), gStatus44.slice(0, 400));
g.child.kill();
gRelayChild.kill();

// ---------- Phase G2: capsule revision conflict surfaces (stub) ----------
const conflictStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-bridge-key'] !== 'conflict-key-0123456789') return send(401, { error: 'missing or wrong bridge key' });
    const url = new URL(req.url, 'http://stub');
    const P = url.pathname;
    if (req.method === 'GET' && P === '/api/meta') return send(200, { server: 'ghost-bridge-relay', version: '4.3.0', tasks: 0, open: 0 });
    if (req.method === 'GET' && P === '/api/context') return send(200, remoteContext);
    if (req.method === 'GET' && P === '/api/files') return send(200, { path: url.searchParams.get('path'), text: '# Capsule — Remote Marker Project\n\n## State\nSomeone else is editing this.\n', rev: 5 });
    if (req.method === 'PUT' && P === '/api/files') return send(409, { error: 'revision conflict for "capsules/remote-marker.md": you based this write on rev 5, but the file is now at rev 7', currentRev: 7, path: 'capsules/remote-marker.md' });
    if (req.method === 'GET' && P === '/api/presence') return send(200, { agents: [], windowMinutes: 10 });
    if (req.method === 'POST' && P === '/api/presence') return send(200, { ok: true });
    return send(404, { error: 'not found' });
  });
});
await new Promise(r => conflictStub.listen(0, '127.0.0.1', r));
const g2 = startClient({
  GHOST_RELAY_URL: `http://127.0.0.1:${conflictStub.address().port}`, GHOST_BRIDGE_KEY: 'conflict-key-0123456789',
  GHOST_QUEUE_REPO: '', GITHUB_TOKEN: '', GHOST_GITHUB_TOKEN: '',
  GHOST_STATE_PATH: path.join(outboxDir, 'state-g2.json'), GHOST_OUTBOX_PATH: path.join(outboxDir, 'outbox-g2.json')
});
await g2.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test', version: '0' } });
const g2Upd = await toolText(g2, 'ghost_capsule_update', { project: 'remote-marker', state: 'My competing edit.' });
check('G2 capsule update on a moved revision surfaces a clear conflict (no silent clobber)', g2Upd.isError === true && g2Upd.text.includes('NOT updated') && /conflict/i.test(g2Upd.text) && g2Upd.text.includes('rev 7') && g2Upd.text.includes('rev 5'), g2Upd.text.slice(0, 240));
g2.child.kill();
conflictStub.close();

// ---------- Phase H: ghost-bridge doctor (v4.4) ----------
// Spawn the real bin against a real relay: --json structure + exit code,
// key scope detection, config sanity, and a FAIL case that must exit 1.
function runDoctor(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(here, '..', 'bin', 'ghost-bridge.mjs'), 'doctor', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ status: code, stdout: out, stderr: err }));
    setTimeout(() => { child.kill(); reject(new Error('doctor timed out')); }, 20000);
  });
}
const hPortProbe = http.createServer();
await new Promise(r => hPortProbe.listen(0, '127.0.0.1', r));
const hPort = hPortProbe.address().port;
await new Promise(r => hPortProbe.close(r));
const HKEY = 'phase-h-doctor-key-0123456789abcdef';
const hRelayChild = spawn('node', [path.join(here, '..', 'relay', 'local-server.mjs'), String(hPort)], {
  env: { ...process.env, BRIDGE_SETUP_SECRET: 'phase-h-secret' }, stdio: ['ignore', 'ignore', 'inherit']
});
let hUp = false;
for (let i = 0; i < 40 && !hUp; i++) {
  try { const h = await fetch(`http://127.0.0.1:${hPort}/health`); hUp = h.status === 200; } catch { await new Promise(r => setTimeout(r, 250)); }
}
check('H doctor fixture relay up', hUp);
await fetch(`http://127.0.0.1:${hPort}/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: HKEY, setupSecret: 'phase-h-secret' }) });
const hTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-doctor-'));
const hConfigPath = path.join(hTmp, 'mcp_config.json');
fs.writeFileSync(hConfigPath, JSON.stringify({ mcpServers: { 'ghost-bridge': { command: 'node', args: [path.join(here, 'server.js')], env: { GHOST_RELAY_URL: `http://127.0.0.1:${hPort}` } } } }, null, 2));
const hEnv = { ...process.env, GHOST_RELAY_URL: `http://127.0.0.1:${hPort}`, GHOST_BRIDGE_KEY: HKEY, GHOST_OUTBOX_PATH: path.join(hTmp, 'outbox.json'), HOME: hTmp };
const docJson = await runDoctor(['--json', '--config', hConfigPath], hEnv);
let docParsed = null;
try { docParsed = JSON.parse(docJson.stdout); } catch { /* asserted below */ }
check('H doctor --json exits 0 against a healthy fixture relay', docJson.status === 0 && !!docParsed, `exit=${docJson.status} out=${docJson.stdout.slice(0, 120)} err=${docJson.stderr.slice(0, 120)}`);
check('H doctor JSON structure: checks + summary, zero fails', !!docParsed && Array.isArray(docParsed.checks) && docParsed.summary.fail === 0 && docParsed.ok === true, JSON.stringify(docParsed?.summary || {}));
check('H doctor relay checks PASS (reachability, version match, full key scope)', !!docParsed && docParsed.checks.find(c => c.name === 'Relay reachability')?.status === 'PASS' && docParsed.checks.find(c => c.name === 'Relay version')?.status === 'PASS' && (docParsed.checks.find(c => c.name === 'Bridge key')?.detail || '').includes('scope: full'), JSON.stringify(docParsed?.checks || []).slice(0, 300));
check('H doctor config check PASSes the valid fixture config', !!docParsed && docParsed.checks.find(c => c.name === 'MCP config')?.status === 'PASS', JSON.stringify(docParsed?.checks?.find(c => c.name === 'MCP config') || {}));
check('H doctor never prints the bridge key', !docJson.stdout.includes(HKEY) && !docJson.stderr.includes(HKEY));
const badCfgPath = path.join(hTmp, 'broken.json');
fs.writeFileSync(badCfgPath, '{ this is not json');
const docBad = await runDoctor(['--json', '--config', badCfgPath], hEnv);
let docBadParsed = null;
try { docBadParsed = JSON.parse(docBad.stdout); } catch { /* asserted below */ }
check('H doctor exits 1 when a check FAILs (broken --config)', docBad.status === 1 && !!docBadParsed && docBadParsed.summary.fail >= 1 && docBadParsed.checks.find(c => c.name === 'MCP config')?.status === 'FAIL', `exit=${docBad.status}`);
const docHuman = await runDoctor([], { ...hEnv, GHOST_RELAY_URL: '', GHOST_BRIDGE_KEY: '' });
check('H doctor human mode runs clean with no relay configured (SKIP, exit 0)', docHuman.status === 0 && docHuman.stdout.includes('doctor:') && docHuman.stdout.includes('SKIP'), docHuman.stdout.slice(0, 200));
hRelayChild.kill();

stub.close();
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(process.exitCode || 0);
