// 零依赖的「假 OIDC Provider」—— 只用于端到端验证我方 OIDC 客户端。
//
// 为什么需要它：MengBot 的 client_secret 还没下来，但**我方代码对不对不能靠等**。
// 这里按 RFC 8414 / OIDC Core 实现最小子集：
//   GET  /.well-known/openid-configuration
//   GET  /auth?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256
//        → 自动"登录"（选一个固定用户）→ 302 回 redirect_uri?code=…&state=…
//   POST /token  (client_secret_basic) → 校验 code + PKCE verifier → access_token / refresh_token
//   GET  /me     (Bearer) → userinfo
//
// 路径故意用真实 MengBot 布局（authorize 在 `/auth`，不在 `/oidc/auth`），
// 用来保证「我方不硬编码路径」这条真的生效。

import http from 'node:http'
import crypto from 'node:crypto'

export function startFakeIdp({
  port = 0,
  clientId = 'memory-eternal-cloud',
  clientSecret = 'fake-secret',
  user = { sub: 'u_1', email: 'yg@example.com', name: 'YG' },
  authorizePath = '/auth',
  tokenPath = '/token',
  userinfoPath = '/me',
  pkceRequired = true,
} = {}) {
  const codes = new Map()      // code → { clientId, redirectUri, challenge, scope, used }
  const tokens = new Map()     // accessToken → { sub, scope }
  const refreshTokens = new Map() // refresh → sub
  const hits = []

  const b64u = (b) => Buffer.from(b).toString('base64url')

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    hits.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })

    if (url.pathname === '/.well-known/openid-configuration') {
      const base = `http://127.0.0.1:${server.address().port}`
      return sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: base + authorizePath,
        token_endpoint: base + tokenPath,
        userinfo_endpoint: base + userinfoPath,
        jwks_uri: base + '/jwks',
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      })
    }

    if (url.pathname === authorizePath && req.method === 'GET') {
      const p = url.searchParams
      const redirectUri = p.get('redirect_uri')
      if (!redirectUri) return sendJson(res, 400, { error: 'invalid_request', error_description: 'missing redirect_uri' })
      if (p.get('client_id') !== clientId) {
        return sendJson(res, 401, { error: 'invalid_client', error_description: 'unknown client_id' })
      }
      if (p.get('response_type') !== 'code') {
        return sendJson(res, 400, { error: 'unsupported_response_type' })
      }
      const challenge = p.get('code_challenge')
      if (pkceRequired && !challenge) {
        return sendJson(res, 400, { error: 'invalid_request', error_description: 'PKCE required' })
      }
      // 「登录」= 固定用户，直接发 code
      const code = b64u(crypto.randomBytes(24))
      codes.set(code, {
        clientId: p.get('client_id'),
        redirectUri,
        challenge,
        scope: p.get('scope') || 'openid',
        used: false,
      })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      if (p.get('state')) back.searchParams.set('state', p.get('state'))
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }

    if (url.pathname === tokenPath && req.method === 'POST') {
      const body = await readForm(req)
      // client_secret_basic
      const auth = String(req.headers.authorization || '')
      if (!auth.startsWith('Basic ')) {
        return sendJson(res, 401, { error: 'invalid_client', error_description: 'client_secret_basic required' })
      }
      const [cid, csec] = Buffer.from(auth.slice(6), 'base64').toString().split(':')
      if (cid !== clientId || csec !== clientSecret) {
        return sendJson(res, 401, { error: 'invalid_client' })
      }

      if (body.grant_type === 'refresh_token') {
        const sub = refreshTokens.get(body.refresh_token)
        if (!sub) return sendJson(res, 400, { error: 'invalid_grant' })
        const at = b64u(crypto.randomBytes(20))
        const rt = b64u(crypto.randomBytes(20))
        tokens.set(at, { sub, scope: 'openid' })
        refreshTokens.set(rt, sub)
        return sendJson(res, 200, { access_token: at, refresh_token: rt, token_type: 'Bearer', expires_in: 3600 })
      }

      const rec = codes.get(body.code)
      if (!rec || rec.used) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'bad or reused code' })
      if (rec.redirectUri !== body.redirect_uri) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
      if (rec.challenge) {
        if (!body.code_verifier) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'missing code_verifier' })
        const want = b64u(crypto.createHash('sha256').update(body.code_verifier).digest())
        if (want !== rec.challenge) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
      }
      rec.used = true
      const at = b64u(crypto.randomBytes(20))
      const rt = b64u(crypto.randomBytes(20))
      tokens.set(at, { sub: user.sub, scope: rec.scope })
      refreshTokens.set(rt, user.sub)
      return sendJson(res, 200, { access_token: at, refresh_token: rt, token_type: 'Bearer', expires_in: 3600, scope: rec.scope })
    }

    if (url.pathname === userinfoPath && req.method === 'GET') {
      const at = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const rec = tokens.get(at)
      if (!rec) return sendJson(res, 401, { error: 'invalid_token' })
      return sendJson(res, 200, { sub: user.sub, email: user.email, name: user.name, email_verified: true })
    }

    return sendJson(res, 404, { error: 'not_found', path: url.pathname })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`
      resolve({
        base,
        port: server.address().port,
        hits,
        close: () => new Promise((r) => server.close(r)),
        issueCode: (redirectUri, challenge) => {
          const code = b64u(crypto.randomBytes(24))
          codes.set(code, { clientId, redirectUri, challenge, scope: 'openid profile email offline_access', used: false })
          return code
        },
      })
    })
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readForm(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(d))))
    req.on('error', () => resolve({}))
  })
}
