// 配置保存的一致性：守「保存了什么就存了什么、重启后还是什么」
//   ① 不再有隐式改写（builtin → local、builtin → enabled=false）；
//   ② local 模式必须指向本机，公网地址被纠正并如实回报；
//   ③ builtin 不需要地址也能保存；
//   ④ enabled=false 只关检索，不动 mode/model/baseUrl。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeEmbeddingConfig, readEmbeddingConfig } from '../lib/embedding-config.js'

function withEnv(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-embedcfg-'))
  const env = { ...process.env, DSH_HOME: dir, MEMORY_EMBED_CONFIG: '' }
  // 配置文件名由 configFilePath 决定，这里直接用 DSH_HOME 隔离
  return Promise.resolve(fn(env, dir)).finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

test('builtin 保存后就是 builtin（不会被悄悄改成 local）', () => withEnv((env) => {
  writeEmbeddingConfig({ enabled: true, mode: 'local', baseUrl: 'http://127.0.0.1:7997/v1', model: 'bge-m3' }, env)
  writeEmbeddingConfig({ enabled: true, mode: 'builtin', model: 'builtin-ngram-768' }, env)
  const c = readEmbeddingConfig(env)
  assert.equal(c.mode, 'builtin')
  assert.equal(c.enabled, true)
}))

test('关闭只改 enabled，不动 mode / model / baseUrl', () => withEnv((env) => {
  writeEmbeddingConfig({ enabled: true, mode: 'builtin', model: 'builtin-ngram-768' }, env)
  writeEmbeddingConfig({ enabled: false }, env)
  const c = readEmbeddingConfig(env)
  assert.equal(c.enabled, false)
  assert.equal(c.mode, 'builtin', '关闭语义召回不应把通道改回 local')
  assert.equal(c.model, 'builtin-ngram-768')
}))

test('local 模式写了公网地址：纠正为 127.0.0.1 并回报 corrected', () => withEnv((env) => {
  const r = writeEmbeddingConfig({ enabled: true, mode: 'local', baseUrl: 'https://api.siliconflow.cn/v1', model: 'bge-m3' }, env)
  assert.match(r.baseUrl, /127\.0\.0\.1:7997/)
  assert.equal(readEmbeddingConfig(env).baseUrl, 'http://127.0.0.1:7997/v1')
  assert.ok(Array.isArray(r.corrected) && r.corrected.length === 1, '要如实回报纠正项')
}))

test('online 模式保留公网地址（不做 local 纠正）', () => withEnv((env) => {
  writeEmbeddingConfig({ enabled: true, mode: 'online', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' }, env)
  const c = readEmbeddingConfig(env)
  assert.equal(c.mode, 'online')
  assert.equal(c.baseUrl, 'https://api.siliconflow.cn/v1')
}))

test('builtin 没有地址也能保存（不会因为缺 baseUrl 整单被拒）', () => withEnv((env) => {
  const r = writeEmbeddingConfig({ enabled: true, mode: 'builtin', model: 'builtin-ngram-768', baseUrl: '' }, env)
  assert.equal(r.mode, 'builtin')
  assert.ok(r.baseUrl, 'builtin 会给一个占位地址，避免下游读空')
}))

test('非法模型名仍然拒绝', () => withEnv((env) => {
  assert.throws(() => writeEmbeddingConfig({ enabled: true, mode: 'online', baseUrl: 'https://x.example/v1', model: 'bad model!!' }, env), /模型名不合法/)
}))
