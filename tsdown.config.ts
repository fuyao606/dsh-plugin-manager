/**
 * tsdown build for dsh-plugin-manager:
 * - host 半 lib/index.js（Node ESM）：/plugin-manager API。
 * - client 半 lib/client.js（浏览器 CJS，包装为 window.__ModuleLoader__.load）。
 * client 半只依赖模块表提供的 react / react/jsx-runtime，其余全部内联。
 */
import type { UserConfig } from 'tsdown'

/** 模块表共享的平台模块（externals），运行时由 DSH web shell 提供。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

export default [
  {
    // host half: Node ESM
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    // client half: browser CJS, registered into the module loader under the package name
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-manager", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
