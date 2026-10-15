import fs from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const { startServer } = await import(pathToFileURL(`${process.env.S15_SOURCE_ROOT}/packages/daemon/dist/index.js`));
const server = await startServer(0);
if (!server.listening) await once(server, 'listening');
const state = { pid: process.pid, port: server.address().port, host: '127.0.0.1',
  db: process.env.OPENRIG_DB, startedAt: new Date().toISOString() };
fs.writeFileSync(`${process.env.OPENRIG_HOME}/daemon.json`, JSON.stringify(state));
fs.writeFileSync(`${process.env.OPENRIG_HOME}/ready.json`, JSON.stringify(state));
