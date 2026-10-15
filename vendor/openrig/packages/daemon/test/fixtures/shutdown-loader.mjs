import { pathToFileURL } from 'node:url';
const startup = pathToFileURL(`${process.env.S15_SOURCE_ROOT}/packages/daemon/dist/startup.js`).href;
export async function load(url, context, nextLoad) {
  if (url === startup) return { format: 'module', shortCircuit: true,
    source: `export { createDaemon } from ${JSON.stringify(new URL('./shutdown-startup.mjs', import.meta.url).href)};` };
  return nextLoad(url, context);
}
