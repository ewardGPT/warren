// Build daemon, CLI and TUI first. Replay input is a sealed read-only export;
// every product write below targets a new disposable home/database/listener.
// Usage: node scripts/probe-health-calibration.mjs <replay.json> [output-directory]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createDb } from '../dist/db/connection.js';
import { migrate } from '../dist/db/migrate.js';
import { ALL_MIGRATIONS } from '../dist/db/all-migrations.js';
import { EventBus } from '../dist/domain/event-bus.js';
import { QueueRepository } from '../dist/domain/queue-repository.js';
import { HealthPolicyStore } from '../dist/domain/health-policy.js';
import { HealthCheckpointSource } from '../dist/domain/health-checkpoints.js';
import { HealthProjectionService } from '../dist/domain/health-detectors.js';
import { HealthDiagnosisService } from '../dist/domain/health-diagnosis.js';
import { healthAuthority } from '../dist/domain/health-context.js';
import { healthRoutes } from '../dist/routes/health.js';
import { healthDiagnosisRoutes } from '../dist/routes/health-diagnosis.js';
import { demoSnapshot } from '../../tui/dist/demo-data.js';
import { healthDetailLines, healthListLines, healthSummaryLine } from '../../tui/dist/health/health-model.js';
import { renderScreen } from '../../tui/dist/render.js';
import { createViewState } from '../../tui/dist/state.js';
import { parseCommand } from '../../tui/dist/grammar.js';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const bytes = readFileSync(process.argv[2]);
const replay = JSON.parse(bytes);
assert.equal(replay.schema, 'openrig.health-calibration-replay/v1');
assert.ok(replay.cases.length > 0, 'zero cases is not a pass');
const output = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'health-calibration-results-'));
mkdirSync(output, { recursive: true });
const hash = (x) => createHash('sha256').update(x).digest('hex');
const disk = (home) => readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [join(e.parentPath, e.name), hash(readFileSync(join(e.parentPath, e.name)))]).sort(([a], [b]) => a.localeCompare(b));
const report = { replaySha256: hash(bytes), budgets: { projectionP95Ms: 250, cliMs: 3000, findingBytes: 262144 }, cases: [] };
for (const test of replay.cases) {
  const home = mkdtempSync(join(tmpdir(), 'health-calibration-'));
  const workspace = join(home, 'workspace'); mkdirSync(workspace);
  const db = createDb(join(home, 'openrig.sqlite')); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db));
  const qi = db.prepare('INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,handed_off_from,body) VALUES(?,?,?,?,?,?,?,?,?)');
  const ti = db.prepare('INSERT INTO queue_transitions(transition_id,qitem_id,ts,state,actor_session,identity_provenance) VALUES(?,?,?,?,?,?)');
  for (const r of test.rows) qi.run(r.qitem_id, r.ts_created, r.ts_created, r.source_session, r.destination_session, 'done', r.tags, r.handed_off_from, 'Sealed replay metadata; original body intentionally not imported.');
  for (const t of test.transitions) ti.run(t.transition_id, t.qitem_id, t.ts, t.state, t.actor_session, t.identity_provenance);
  for (const [path, a] of Object.entries(replay.artifacts)) {
    assert.equal(hash(a.content), a.sha256); assert.match(path, /^evidence\/[a-f0-9]{64}\.[a-z]+$/);
    mkdirSync(join(workspace, 'evidence'), { recursive: true }); writeFileSync(join(workspace, path), a.content);
  }
  for (const a of test.authority ?? []) {
    const path = resolve(workspace, a.path); assert.ok(path.startsWith(workspace + '/'));
    assert.equal(hash(a.content), a.sha256); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, a.content);
  }
  mkdirSync(join(workspace, 'censuses')); writeFileSync(join(workspace, 'censuses', `${test.name}.json`), JSON.stringify(test.census));
  let now = test.checkpoint.observedAt;
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const p = policy.read().policy;
  policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: 'owner@fixture', cooldownSeconds: 60 } }, 'author@fixture');
  const checkpoints = new HealthCheckpointSource(home, queue, policy, () => now);
  const projection = new HealthProjectionService(checkpoints, () => policy.read());
  let wakes = 0; queue.attachTransport({ send: async () => { wakes++; return { ok: true, verified: true }; } });
  const diagnosis = new HealthDiagnosisService({ queue, projection, policy, now: () => now, authority: (f) => healthAuthority(workspace, checkpoints, f) });
  const app = new Hono(); app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.use('*', async (c, next) => { c.set('healthProjection', projection); c.set('healthPolicy', policy); c.set('healthCheckpoints', checkpoints); c.set('healthDiagnosis', diagnosis); await next(); });
  app.route('/api/health', healthRoutes()); app.route('/api/health-diagnosis', healthDiagnosisRoutes());
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise((done) => server.once('listening', done));
  const port = server.address().port;
  writeFileSync(join(home, 'daemon.json'), JSON.stringify({ pid: process.pid, port, db: join(home, 'openrig.sqlite'), startedAt: now }));
  const env = { ...process.env, OPENRIG_HOME: home, OPENRIG_DB: join(home, 'openrig.sqlite'), OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_SESSION_NAME: 'author@fixture' };
  delete env.OPENRIG_NODE_ID; delete env.OPENRIG_RIG_NAME;
  const cliDurations = [];
  const cli = async (...args) => {
    const start = performance.now();
    const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'packages/cli/dist/index.js'), 'health', ...args], { env, maxBuffer: 8 * 1024 * 1024 });
    const elapsed = performance.now() - start; cliDurations.push(elapsed);
    assert.ok(elapsed < report.budgets.cliMs, 'CLI budget exceeded'); return stdout;
  };
  try {
    writeFileSync(join(home, 'checkpoint.json'), JSON.stringify({ ...test.checkpoint, transitionIds: 'derive' }));
    await cli('checkpoint', '--file', join(home, 'checkpoint.json'), '--json');
    const before = disk(home); const changes = db.prepare('SELECT total_changes() AS n').get().n;
    assert.deepEqual(checkpoints.entries()[0].checkpoint.transitionIds, test.checkpoint.transitionIds);
    const result = projection.list();
    assert.equal(result.records[0]?.status ?? 'absent', test.expected, test.name);
    const samples = [];
    for (let i = 0; i < 20; i++) { const at = performance.now(); assert.deepEqual(projection.list(), result); samples.push(performance.now() - at); }
    samples.sort((a, b) => a - b); const p95 = samples[18];
    assert.ok(p95 < report.budgets.projectionP95Ms, `projection cost ${p95}`);
    const raw = await cli('--instance', '--json'); assert.deepEqual(JSON.parse(raw), result);
    const snap = demoSnapshot(); snap.health = { availability: 'loaded', ...result };
    const summary = healthSummaryLine(snap, { kind: 'instance', local: true }, 140).text;
    const list = healthListLines(snap, { kind: 'instance', local: true }, 140);
    for (const finding of result.records) {
      assert.deepEqual(JSON.parse(await cli('explain', finding.id, '--json')), finding);
      assert.ok(list.some((line) => line.action?.type === 'health-open' && line.action.findingId === finding.id));
      const detail = healthDetailLines(snap, finding.id, 140).map((l) => l.text).join('\n');
      assert.ok(detail.includes(finding.id)); assert.ok(detail.includes(finding.status));
      assert.ok(detail.includes(finding.policyVersion)); assert.match(detail, /Selected\s+SDLC\s+expectation/);
      assert.ok(Buffer.byteLength(JSON.stringify(finding)) < report.budgets.findingBytes);
      writeFileSync(join(output, `${test.name}-detail.txt`), detail);
      const view = createViewState({ instanceId: 'health-calibration', getSnapshot: () => snap });
      view.dispatch(parseCommand('host vm-host')); view.dispatch(parseCommand('tab health')); view.dispatch({ type: 'health-open', findingId: finding.id });
      writeFileSync(join(output, `${test.name}-screen.txt`), renderScreen(view.get(), snap, { cols: 140, rows: 45, colorMode: 'none' }).lines.join('\n'));
    }
    await cli('diagnose', '--json');
    assert.equal(wakes, 0); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes); assert.deepEqual(disk(home), before);
    await cli('diagnose', '--apply', '--json'); await cli('diagnose', '--apply', '--json');
    assert.equal(diagnosis.list().length, test.expected === 'active' ? 1 : 0);
    assert.equal(wakes, test.expected === 'active' ? 1 : 0);
    if (test.expected === 'active') {
      const occurrence = diagnosis.list()[0]; assert.deepEqual(occurrence.finding, result.records[0]);
      assert.match(occurrence.packet.instructions, /not the whole story/);
      for (const level of ['project', 'mission', 'slice']) assert.ok(occurrence.authority.some((a) => a.level === level && a.state === 'available'), level);
      assert.ok(occurrence.packet.finding.explanation.includes(test.checkpoint.sdlc.expectation));
      writeFileSync(join(output, `${test.name}-diagnosis.json`), JSON.stringify(occurrence, null, 2));
      // An unrefreshed source ages to indeterminate; reading never refreshes its clock.
      now = new Date(Date.parse(now) + 601000).toISOString();
      assert.equal(projection.get(result.records[0].id).status, 'indeterminate');
      assert.deepEqual((await diagnosis.evaluate('author@fixture', true)).actions.map((a) => a.action), ['observe']);
      assert.equal(diagnosis.list().length, 1); assert.equal(wakes, 1);
      assert.equal((await diagnosis.evaluate('author@fixture', true)).actions.length, 0);
    }
    const metric = { name: test.name, status: test.expected, qitems: test.rows.length, transitions: test.transitions.length, listedOutcomes: test.checkpoint.productOutcomes.length, projectionP95Ms: p95, maxCliMs: Math.max(...cliDurations), responseBytes: Buffer.byteLength(raw), wakes, summary, findingId: result.records[0]?.id ?? null, explanation: result.records[0]?.explanation ?? null };
    report.cases.push(metric);
  } finally { await new Promise((done) => server.close(done)); db.close(); rmSync(home, { recursive: true, force: true }); }
}
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: 'PASS', cases: report.cases.map(({ name, status, projectionP95Ms, wakes }) => ({ name, status, projectionP95Ms, wakes })), output }));
