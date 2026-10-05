// 用 esbuild 把验证脚本（TS + @ 路径别名）打成 ESM，注入内存版 localStorage 后在 Node 里执行。
import { build } from 'esbuild'
import { rmSync, writeFileSync } from 'node:fs'

const shim = `
const __store = Object.create(null);
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : null),
  setItem: (k, v) => { __store[k] = String(v); },
  removeItem: (k) => { delete __store[k]; },
  clear: () => { for (const k of Object.keys(__store)) delete __store[k]; },
};
`

const result = await build({
  entryPoints: ['scripts/verify-pumpmaint.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  banner: { js: shim },
})

const outFile = 'node_modules/.verify-pumpmaint.mjs'
writeFileSync(outFile, result.outputFiles[0].text)
try {
  await import(`../${outFile}?t=${Date.now()}`)
} finally {
  rmSync(outFile, { force: true })
}
