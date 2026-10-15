// Build daemon/CLI/TUI first. Inputs are a sealed normal-evidence export and
// separately attributed agent responses. No checkpoint/census ingestion occurs.
// Every write and transport double is confined to a disposable home/listener.
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
import { PassiveCeremonySource } from '../dist/domain/health-passive-ceremony.js';
import { HealthProjectionService } from '../dist/domain/health-detectors.js';
import { HealthDiagnosisService } from '../dist/domain/health-diagnosis.js';
import { healthAuthority, readHealthArtifact } from '../dist/domain/health-context.js';
import { healthRoutes } from '../dist/routes/health.js';
import { healthDiagnosisRoutes } from '../dist/routes/health-diagnosis.js';
import { demoSnapshot } from '../../tui/dist/demo-data.js';
import { healthDetailLines, healthListLines } from '../../tui/dist/health/health-model.js';
import { renderScreen } from '../../tui/dist/render.js';
import { createViewState } from '../../tui/dist/state.js';
import { parseCommand } from '../../tui/dist/grammar.js';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const bytes = readFileSync(process.argv[2]); const replay = JSON.parse(bytes);
const responsesBytes = readFileSync(process.argv[3]); const responses = JSON.parse(responsesBytes);
assert.equal(replay.schema, 'openrig.passive-ceremony-replay/v1'); assert.ok(replay.cases.length);
const output = process.argv[4] ?? mkdtempSync(join(tmpdir(), 'passive-ceremony-results-')); mkdirSync(output, { recursive: true });
const hash = (x) => createHash('sha256').update(x).digest('hex');
// SQLite WAL reader marks are transient shared memory; compare DB/WAL and all owned files.
const disk = (home) => readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name !== "openrig.sqlite-shm").map((e) => [join(e.parentPath, e.name), hash(readFileSync(join(e.parentPath, e.name)))]).sort(([a], [b]) => a.localeCompare(b));
const report = { replaySha256: hash(bytes), responsesSha256: hash(responsesBytes), responseAuthor: responses.author, cases: [] };
for (const test of replay.cases) {
  const home = mkdtempSync(join(tmpdir(), 'passive-ceremony-')); const workspace = join(home, 'workspace'); mkdirSync(workspace);
  const db = createDb(join(home, 'openrig.sqlite')); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true, entities: [
    { entityId: 'fixture', class: 'human', displayName: 'Fixture only', address: 'fixture@external', connectorBindings: [{ kind: 'slack', connectorRef: 'fixture', secretsRef: 'fixture', role: 'primary' }], prefs: { deliveryClass: 'A' } },
  ] }) });
  const qi = db.prepare('INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,handed_off_from,body) VALUES(?,?,?,?,?,?,?,?,?)');
  const ti = db.prepare('INSERT INTO queue_transitions(transition_id,qitem_id,ts,state,actor_session,identity_provenance) VALUES(?,?,?,?,?,?)');
  for (const r of test.rows) qi.run(r.qitem_id, r.ts_created, r.ts_created, r.source_session, r.destination_session, 'done', r.tags, r.handed_off_from, 'Sealed normal queue metadata; no synthetic health claim.');
  for (const t of test.transitions) ti.run(t.transition_id, t.qitem_id, t.ts, t.state, t.actor_session, t.identity_provenance);
  for (const [path, a] of Object.entries(replay.files)) {
    const destination = resolve(workspace, path); assert.ok(destination.startsWith(workspace + '/')); assert.equal(hash(a.content), a.sha256);
    mkdirSync(resolve(destination, '..'), { recursive: true }); writeFileSync(destination, a.content);
  }
  const now = () => test.now;
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 })); const p = policy.read().policy;
  policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: 'diagnoser@fixture', cooldownSeconds: 60 }, human: { address: 'fixture@external', conditions: ['confirmed ceremony'] } }, 'operator@fixture');
  const checkpoints = new HealthCheckpointSource(home, queue, policy, now, workspace);
  const source = new PassiveCeremonySource(workspace, queue, policy, now, checkpoints);
  const projection = new HealthProjectionService(source, () => policy.read());
  let wakes = 0; let readiness = 0; queue.attachTransport({ send: async () => { wakes++; return { ok: true, verified: true }; } });
  const diagnosis = new HealthDiagnosisService({ queue, projection, policy, now, authority: (f) => healthAuthority(workspace, checkpoints, f), resolveEvidence: (path) => readHealthArtifact(workspace, path), humanReadiness: async () => { readiness++; return { ready: true, reason: 'isolated fixture; no external transport' }; } });
  const app = new Hono(); app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.use('*', async (c, next) => { c.set('healthProjection', projection); c.set('healthPolicy', policy); c.set('healthCheckpoints', checkpoints); c.set('healthDiagnosis', diagnosis); await next(); });
  app.route('/api/health', healthRoutes()); app.route('/api/health-diagnosis', healthDiagnosisRoutes());
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }); await new Promise((done) => server.once('listening', done));
  const port = server.address().port; writeFileSync(join(home, 'daemon.json'), JSON.stringify({ pid: process.pid, port, db: join(home, 'openrig.sqlite'), startedAt: test.now }));
  const env = { ...process.env, OPENRIG_HOME: home, OPENRIG_DB: join(home, 'openrig.sqlite'), OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_SESSION_NAME: 'diagnoser@fixture' };
  delete env.OPENRIG_NODE_ID; delete env.OPENRIG_RIG_NAME;
  const cli = async (...args) => (await promisify(execFile)(process.execPath, [join(root, 'packages/cli/dist/index.js'), 'health', ...args], { env, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const retain = async (label, finding) => {
    const current = projection.list(); assert.deepEqual(JSON.parse(await cli('--instance', '--json')), current);
    if (!finding) return;
    assert.deepEqual(JSON.parse(await cli('explain', finding.id, '--json')), finding);
    const human = await cli('explain', finding.id); assert.ok(human.includes(finding.ceremony.stage));
    const snap = demoSnapshot(); snap.health = { availability: 'loaded', ...current, records: [finding] };
    const detail = healthDetailLines(snap, finding.id, 140).map((l) => l.text).join('\n'); assert.ok(detail.includes(finding.ceremony.stage));
    assert.ok(healthListLines(snap, { kind: 'instance', local: true }, 140).some((l) => l.action?.findingId === finding.id));
    writeFileSync(join(output, `${test.name}-${label}.json`), JSON.stringify(finding, null, 2)); writeFileSync(join(output, `${test.name}-${label}.txt`), human + '\n' + detail);
    const view = createViewState({ instanceId: 'passive-ceremony', getSnapshot: () => snap }); view.dispatch(parseCommand('host vm-host')); view.dispatch(parseCommand('tab health')); view.dispatch({ type: 'health-open', findingId: finding.id });
    writeFileSync(join(output, `${test.name}-${label}-screen.txt`), renderScreen(view.get(), snap, { cols: 140, rows: 45, colorMode: 'none' }).lines.join('\n'));
  };
  try {
    const baseline = disk(home); const changes = db.prepare('SELECT total_changes() AS n').get().n;
    const initial = projection.list().records[0]; const times = [];
    for (let i = 0; i < 10; i++) { const at = performance.now(); projection.list(); times.push(performance.now() - at); }
    const p95 = Math.max(...times); assert.ok(p95 < 250, `projection exceeds 250 ms: ${p95}`);
    if (initial) { assert.equal(initial.ceremony.stage, 'needs-diagnosis'); assert.equal(initial.status, 'indeterminate'); assert.equal(initial.severity, 'info'); assert.doesNotMatch(initial.explanation, /\d+\.\d+:1/); }
    await retain('suspected', initial); await cli('diagnose', '--json');
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes); assert.deepEqual(disk(home), baseline); assert.equal(wakes, 0); assert.equal(checkpoints.entries().length, 0);
    await cli('diagnose', '--apply', '--json'); await cli('diagnose', '--apply', '--json');
    assert.equal(diagnosis.list().length, initial ? 1 : 0); assert.equal(wakes, initial ? 1 : 0); assert.equal(readiness, 0);
    let final = initial;
    if (initial) {
      const occurrence = diagnosis.list()[0]; writeFileSync(join(output, `${test.name}-packet.json`), JSON.stringify(occurrence, null, 2));
      const response = responses.cases[test.name]; assert.ok(response, 'agent response required');
      const disposition = { ...response, progress: { ...response.progress, basis: initial.ceremony.basis } };
      const path = join(home, 'agent-response.json'); writeFileSync(path, JSON.stringify(disposition));
      await cli('diagnosis', 'record', occurrence.row.qitemId, '--file', path, '--json');
      final = projection.get(initial.id); assert.equal(final.id, initial.id);
      await retain('assessed', final);
      const expected = disposition.progress.conclusion === 'established' ? 'active' : disposition.progress.conclusion === 'false-positive' ? 'cleared' : 'indeterminate'; assert.equal(final.status, expected);
      for (let i = 0; i < 3; i++) await cli('diagnose', '--apply', '--json');
      assert.equal(diagnosis.list().length, 1); assert.equal(wakes, 1);
      assert.equal(queue.list({ tag: 'health-human' }).length, final.status === 'active' ? 1 : 0); assert.equal(readiness, final.status === 'active' ? 1 : 0);
      writeFileSync(join(output, `${test.name}-disposition.json`), JSON.stringify(diagnosis.show(occurrence.row.qitemId), null, 2));
    }
    report.cases.push({ name: test.name, transitions: test.transitions.length, observed: initial?.ceremony.transitionIds.length ?? 0, initial: initial?.ceremony.stage ?? 'below threshold', final: final?.status ?? 'absent', findingId: final?.id, p95Ms: p95, responseBytes: Buffer.byteLength(JSON.stringify(final ?? null)), diagnoses: diagnosis.list().length, wakes, humanRequests: queue.list({ tag: 'health-human' }).length, actualExternalSends: 0 });
  } finally { await new Promise((done) => server.close(done)); db.close(); rmSync(home, { recursive: true, force: true }); }
}
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ verdict: 'PASS', ...report, output }));
