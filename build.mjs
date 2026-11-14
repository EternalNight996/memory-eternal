// 构建 client bundle：把 src/client/index.tsx 打包成 DSH 客户端加载格式
// `window.__ModuleLoader__.load({ id, factory })`，输出到 lib/client.js。
//
// 用法：pnpm build  （或 node build.mjs）
// 依赖：devDependencies 里的 esbuild（pnpm i 后可用）。

import { build } from 'esbuild'
import { readFile, writeFile, rm, stat } from 'node:fs/promises'

const PACKAGE_ID = 'memory-eternal'
// 把插件版本注入客户端：面板据此显示「页面脚本版本」，并在页面脚本落后于磁盘时直接提示刷新
// （否则用户更新后看到的仍是旧页面 JS，会误以为「改了没生效」，例如配置保存无反馈）。
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const BUILD_AT = new Date().toISOString()
const clientDefine = {
  __ME_CLIENT_VERSION__: JSON.stringify(pkg.version),
  // 构建时刻 + 是否压缩：面板与错误兜底页都显示它。
  // 用户报「还是报错」时，先看这一行就能判断他加载的是不是旧包。
  __ME_BUILD_AT__: JSON.stringify(BUILD_AT),
  __ME_BUILD_MIN__: JSON.stringify(false),
}

// 共享运行时一律 external：由 DSH 的 __ModuleLoader__ 在运行时 require 注入，
// 绝不能打进 bundle（否则会复制 React/Cordis 运行时身份）。
// 只列 dsh ≥0.1.7 客户端真的提供、且是「平台基线」的模块名（PLATFORM_MODULES：
// React / Cordis / 静态 UI 库）。旧版曾把 @deepseek-ai/dsh-client-runtime、
// dsh-client-schema-form 等当作 external —— 这两个包在 0.1.7 已被移除，留着只会
// 让 build 产出一个运行时必然 require 失败的包。
const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
]

const tmp = 'lib/client.tmp.js'

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  outfile: tmp,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: externals,
  jsx: 'automatic',
  loader: { '.png': 'dataurl', '.jpg': 'dataurl' },
  // 不压缩：压缩 + ModuleLoader 工厂包装下出现过 TDZ 报错
  //（"can't access lexical declaration before initialization"），
  // 只在 DSH 环境复现、浏览器加载同一份源码正常。
  // 这份是本地文件，体积不敏感；不压缩还能让线上堆栈可读。
  minify: false,
  // 保留函数名：即使以后想改回压缩，也能减少内联导致的变量作用域混淆
  keepNames: true,
  define: clientDefine,
  logLevel: 'info',
})

const body = await readFile(tmp, 'utf8')
await rm(tmp, { force: true })

const wrapped = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(PACKAGE_ID)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  body,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')

await writeFile('lib/client.js', wrapped)
console.log(`[memory-eternal] client bundle written to lib/client.js (${wrapped.length} chars)`)

// -- Web bundle（独立 Web UI，react/react-dom 打入，供 lib/web.js 静态服务）------
// 与 DSH 内嵌 bundle 的差异：不 external react（独立页无 ModuleLoader 注入），
// IIFE 直接挂载到 #root；入口 src/web/index.jsx 复用 MemoryLibrary。
await build({
  entryPoints: ['src/web/index.jsx'],
  bundle: true,
  outfile: 'web/app.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.png': 'dataurl', '.jpg': 'dataurl' },
  minify: true,
  define: clientDefine,
  logLevel: 'info',
})
const webStats = await stat('web/app.js')
console.log(`[memory-eternal] web bundle written to web/app.js (${Math.round(webStats.size / 1024)} KB)`)
