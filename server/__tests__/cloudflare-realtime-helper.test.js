import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import {
  getCloudflareConfig,
  isCloudflareConfigured,
  cloudflareRealtimeRequest,
  createCloudflareMeeting,
  addCloudflareParticipant,
  removeCloudflareParticipant,
  endCloudflareMeeting,
  refreshCloudflareParticipantToken
} from '../config/cloudflareRealtime.js'

describe('Meetly AI — Cloudflare RealtimeKit Helper Unit Test Suite', () => {
  const MOCK_ACCOUNT_ID = 'test-account-id-12345'
  const MOCK_APP_ID = 'test-app-id-67890'
  const MOCK_TOKEN = 'test-secret-token-abcdef'

  const mockOverrides = {
    accountId: MOCK_ACCOUNT_ID,
    appId: MOCK_APP_ID,
    apiToken: MOCK_TOKEN
  }

  it('1. Throws descriptive error when required environment variables are missing', () => {
    // Isolate process.env to ensure deterministic missing-env verification regardless of local .env
    const origAcc = process.env.CLOUDFLARE_ACCOUNT_ID
    const origApp = process.env.CLOUDFLARE_REALTIME_APP_ID
    const origTok = process.env.CLOUDFLARE_API_TOKEN

    try {
      delete process.env.CLOUDFLARE_ACCOUNT_ID
      delete process.env.CLOUDFLARE_REALTIME_APP_ID
      delete process.env.CLOUDFLARE_API_TOKEN

      // Missing all
      assert.throws(
        () => getCloudflareConfig({ accountId: '', appId: '', apiToken: '' }),
        (err) => {
          assert.ok(err.message.includes('CLOUDFLARE_ACCOUNT_ID'))
          assert.ok(err.message.includes('CLOUDFLARE_REALTIME_APP_ID'))
          assert.ok(err.message.includes('CLOUDFLARE_API_TOKEN'))
          return true
        }
      )

      // Missing token only
      assert.throws(
        () => getCloudflareConfig({ accountId: 'acc1', appId: 'app1', apiToken: '' }),
        (err) => {
          assert.ok(err.message.includes('CLOUDFLARE_API_TOKEN'))
          assert.ok(!err.message.includes('CLOUDFLARE_ACCOUNT_ID'))
          return true
        }
      )
    } finally {
      if (origAcc !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = origAcc
      else delete process.env.CLOUDFLARE_ACCOUNT_ID

      if (origApp !== undefined) process.env.CLOUDFLARE_REALTIME_APP_ID = origApp
      else delete process.env.CLOUDFLARE_REALTIME_APP_ID

      if (origTok !== undefined) process.env.CLOUDFLARE_API_TOKEN = origTok
      else delete process.env.CLOUDFLARE_API_TOKEN
    }
  })

  it('2. isCloudflareConfigured returns false when variables are missing, true when valid', () => {
    // Save original env
    const origAcc = process.env.CLOUDFLARE_ACCOUNT_ID
    const origApp = process.env.CLOUDFLARE_REALTIME_APP_ID
    const origTok = process.env.CLOUDFLARE_API_TOKEN

    try {
      delete process.env.CLOUDFLARE_ACCOUNT_ID
      delete process.env.CLOUDFLARE_REALTIME_APP_ID
      delete process.env.CLOUDFLARE_API_TOKEN
      assert.strictEqual(isCloudflareConfigured(), false)

      process.env.CLOUDFLARE_ACCOUNT_ID = 'acc'
      process.env.CLOUDFLARE_REALTIME_APP_ID = 'app'
      process.env.CLOUDFLARE_API_TOKEN = 'tok'
      assert.strictEqual(isCloudflareConfigured(), true)
    } finally {
      if (origAcc !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = origAcc
      else delete process.env.CLOUDFLARE_ACCOUNT_ID

      if (origApp !== undefined) process.env.CLOUDFLARE_REALTIME_APP_ID = origApp
      else delete process.env.CLOUDFLARE_REALTIME_APP_ID

      if (origTok !== undefined) process.env.CLOUDFLARE_API_TOKEN = origTok
      else delete process.env.CLOUDFLARE_API_TOKEN
    }
  })

  it('3. Constructs correct Cloudflare RealtimeKit base URL', () => {
    const config = getCloudflareConfig(mockOverrides)
    assert.strictEqual(
      config.baseUrl,
      `https://api.cloudflare.com/client/v4/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
    )
  })

  it('4. Mock Server: createCloudflareMeeting sends correct payload and extracts meeting ID', async () => {
    let capturedHeaders = null
    let capturedBody = null
    let capturedMethod = null
    let capturedUrl = null

    const server = http.createServer((req, res) => {
      capturedHeaders = req.headers
      capturedMethod = req.method
      capturedUrl = req.url

      let bodyStr = ''
      req.on('data', (c) => (bodyStr += c))
      req.on('end', () => {
        capturedBody = bodyStr ? JSON.parse(bodyStr) : null
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            data: {
              id: 'cf-mtg-uuid-1111',
              title: 'Sprint Planning',
              status: 'ACTIVE',
              created_at: '2026-10-30T12:00:00.000Z'
            }
          })
        )
      })
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      // Monkey-patch getCloudflareConfig for this custom base URL test
      const res = await createCloudflareMeeting(
        { title: 'Sprint Planning' },
        { configOverrides: customConfig }
      )

      assert.strictEqual(res.id, 'cf-mtg-uuid-1111')
      assert.strictEqual(res.title, 'Sprint Planning')
      assert.strictEqual(res.status, 'ACTIVE')

      assert.strictEqual(capturedMethod, 'POST')
      assert.strictEqual(
        capturedUrl,
        `/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}/meetings`
      )
      assert.strictEqual(capturedHeaders['authorization'], `Bearer ${MOCK_TOKEN}`)
      assert.strictEqual(capturedBody.title, 'Sprint Planning')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('5. Mock Server: addCloudflareParticipant sends name, preset_name, custom_participant_id', async () => {
    let capturedBody = null
    let capturedUrl = null

    const server = http.createServer((req, res) => {
      capturedUrl = req.url
      let bodyStr = ''
      req.on('data', (c) => (bodyStr += c))
      req.on('end', () => {
        capturedBody = bodyStr ? JSON.parse(bodyStr) : null
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            data: {
              participant_id: 'cf-part-uuid-2222',
              token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mocktoken',
              name: 'Alice',
              preset_name: 'meetly-host'
            }
          })
        )
      })
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      const res = await addCloudflareParticipant(
        'cf-mtg-uuid-1111',
        {
          name: 'Alice',
          presetName: 'meetly-host',
          customParticipantId: 'user-uuid-9999'
        },
        { configOverrides: customConfig }
      )

      assert.strictEqual(res.participantId, 'cf-part-uuid-2222')
      assert.strictEqual(res.token, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mocktoken')
      assert.strictEqual(res.name, 'Alice')
      assert.strictEqual(res.presetName, 'meetly-host')

      assert.strictEqual(
        capturedUrl,
        `/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}/meetings/cf-mtg-uuid-1111/participants`
      )
      assert.strictEqual(capturedBody.name, 'Alice')
      assert.strictEqual(capturedBody.preset_name, 'meetly-host')
      assert.strictEqual(capturedBody.custom_participant_id, 'user-uuid-9999')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('6. Mock Server: removeCloudflareParticipant sends DELETE to participant endpoint', async () => {
    let capturedMethod = null
    let capturedUrl = null

    const server = http.createServer((req, res) => {
      capturedMethod = req.method
      capturedUrl = req.url
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      const res = await removeCloudflareParticipant(
        'cf-mtg-uuid-1111',
        'cf-part-uuid-2222',
        { configOverrides: customConfig }
      )

      assert.strictEqual(res.success, true)
      assert.strictEqual(res.meetingId, 'cf-mtg-uuid-1111')
      assert.strictEqual(res.participantId, 'cf-part-uuid-2222')
      assert.strictEqual(capturedMethod, 'DELETE')
      assert.strictEqual(
        capturedUrl,
        `/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}/meetings/cf-mtg-uuid-1111/participants/cf-part-uuid-2222`
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('7. Mock Server: endCloudflareMeeting sends PATCH with status: INACTIVE', async () => {
    let capturedMethod = null
    let capturedBody = null
    let capturedUrl = null

    const server = http.createServer((req, res) => {
      capturedMethod = req.method
      capturedUrl = req.url
      let bodyStr = ''
      req.on('data', (c) => (bodyStr += c))
      req.on('end', () => {
        capturedBody = bodyStr ? JSON.parse(bodyStr) : null
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            data: { id: 'cf-mtg-uuid-1111', status: 'INACTIVE' }
          })
        )
      })
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      const res = await endCloudflareMeeting('cf-mtg-uuid-1111', {
        configOverrides: customConfig
      })

      assert.strictEqual(res.success, true)
      assert.strictEqual(res.status, 'INACTIVE')
      assert.strictEqual(capturedMethod, 'PATCH')
      assert.strictEqual(
        capturedUrl,
        `/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}/meetings/cf-mtg-uuid-1111`
      )
      assert.deepStrictEqual(capturedBody, { status: 'INACTIVE' })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('8. Mock Server: refreshCloudflareParticipantToken sends POST and receives new token', async () => {
    let capturedMethod = null
    let capturedUrl = null

    const server = http.createServer((req, res) => {
      capturedMethod = req.method
      capturedUrl = req.url
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          data: { token: 'refreshed.jwt.token' }
        })
      )
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      const res = await refreshCloudflareParticipantToken(
        'cf-mtg-uuid-1111',
        'cf-part-uuid-2222',
        {},
        { configOverrides: customConfig }
      )

      assert.strictEqual(res.token, 'refreshed.jwt.token')
      assert.strictEqual(capturedMethod, 'POST')
      assert.strictEqual(
        capturedUrl,
        `/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}/meetings/cf-mtg-uuid-1111/participants/cf-part-uuid-2222/token`
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('9. Error Handling: Parses Cloudflare errors array and never leaks API token', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 1206, message: 'Meeting has reached maximum participant capacity.' }]
        })
      )
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      await assert.rejects(
        async () => {
          await cloudflareRealtimeRequest('/meetings', {
            configOverrides: customConfig
          })
        },
        (err) => {
          assert.strictEqual(err.status, 400)
          assert.strictEqual(err.code, 1206)
          assert.ok(err.message.includes('Meeting has reached maximum participant capacity'))
          // Crucial security requirement: API token MUST NOT be exposed in error string or stack
          assert.ok(!err.message.includes(MOCK_TOKEN))
          assert.ok(!JSON.stringify(err.details || {}).includes(MOCK_TOKEN))
          return true
        }
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('10. Error Handling: Handles HTML/502 Bad Gateway gracefully without throwing syntax error', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' })
      res.end('<html><body>502 Bad Gateway</body></html>')
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      await assert.rejects(
        async () => {
          await cloudflareRealtimeRequest('/meetings', {
            configOverrides: customConfig
          })
        },
        (err) => {
          assert.strictEqual(err.status, 502)
          assert.strictEqual(err.code, 'INVALID_RESPONSE')
          assert.ok(err.message.includes('non-JSON response (HTTP 502)'))
          return true
        }
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('11. Error Handling: Handles network timeout via AbortSignal', async () => {
    const server = http.createServer((_req, _res) => {
      // Deliberately hold connection open without responding
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const customConfig = {
        accountId: MOCK_ACCOUNT_ID,
        appId: MOCK_APP_ID,
        apiToken: MOCK_TOKEN,
        baseUrl: `http://127.0.0.1:${port}/accounts/${MOCK_ACCOUNT_ID}/realtime/kit/${MOCK_APP_ID}`
      }

      await assert.rejects(
        async () => {
          await cloudflareRealtimeRequest('/meetings', {
            timeoutMs: 100, // Very short timeout
            configOverrides: customConfig
          })
        },
        (err) => {
          assert.strictEqual(err.code, 'ETIMEDOUT')
          assert.strictEqual(err.status, 504)
          assert.ok(err.message.includes('timed out after 100ms'))
          return true
        }
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
