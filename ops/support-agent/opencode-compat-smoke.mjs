import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-1.18.23-'))
const data = path.join(temporary, 'data')
const state = path.join(temporary, 'state')
const cache = path.join(temporary, 'cache')
for (const directory of [data, state, cache]) fs.mkdirSync(directory)

const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'opencode.json'), 'utf8'))
config.plugin = [pathToFileURL(path.join(root, 'dist/support-agent.js')).href]
const configPath = path.join(temporary, 'opencode.json')
fs.writeFileSync(configPath, JSON.stringify(config))

const probe = net.createServer()
await new Promise((resolve, reject) => {
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', resolve)
})
const address = probe.address()
if (!address || typeof address === 'string') throw new Error('Failed to reserve a smoke-test port')
const port = address.port
await new Promise(resolve => probe.close(resolve))

const readableFile = path.join(root, 'package.json')
const password = 'compat-smoke-password'
const server = spawn('npx', [
  '--yes',
  'opencode-ai@1.18.23',
  'serve',
  '--hostname', '127.0.0.1',
  '--port', String(port)
], {
  cwd: temporary,
  env: {
    ...process.env,
    HOME: temporary,
    XDG_CONFIG_HOME: temporary,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_CONFIG: configPath,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_MULTI_AUTH_BROKER_ENABLED: 'true',
    OPENCODE_MULTI_AUTH_BROKER_URL: 'https://broker.invalid/v1/responses',
    OPENCODE_MULTI_AUTH_BROKER_CERT_PATH: readableFile,
    OPENCODE_MULTI_AUTH_BROKER_KEY_PATH: readableFile,
    OPENCODE_MULTI_AUTH_BROKER_CA_PATH: readableFile,
    OPENCODE_MULTI_AUTH_BROKER_MODELS: 'gpt-5.6-sol'
  },
  stdio: ['ignore', 'ignore', 'pipe']
})

let stderr = ''
server.stderr.setEncoding('utf8')
server.stderr.on('data', chunk => {
  stderr = `${stderr}${chunk}`.slice(-16 * 1024)
})

const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const request = async endpoint => {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    headers: { authorization }
  })
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}`)
  return response.json()
}

try {
  const deadline = Date.now() + 30_000
  let health
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`OpenCode exited early (${server.exitCode})\n${stderr}`)
    try {
      health = await request('/global/health')
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  assert.equal(health?.healthy, true, `OpenCode did not become healthy\n${stderr}`)
  assert.equal(health.version, '1.18.23')

  const query = '?directory=%2Fworkspace'
  const providers = await request(`/config/providers${query}`)
  const openai = providers.providers.find(provider => provider.id === 'openai')
  assert.ok(openai)
  assert.deepEqual(Object.keys(openai.models), ['gpt-5.6-sol'])
  assert.equal(providers.default.openai, 'gpt-5.6-sol')

  const auth = await request(`/provider/auth${query}`)
  assert.equal(auth.openai, undefined)

  const runtimeConfig = await request(`/config${query}`)
  assert.equal(runtimeConfig.model, 'openai/gpt-5.6-sol')
  assert.equal(runtimeConfig.small_model, 'openai/gpt-5.6-sol')
  assert.equal(runtimeConfig.permission['*'], 'deny')
  assert.equal(fs.existsSync(path.join(data, 'opencode/auth.json')), false)
} finally {
  server.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
  fs.rmSync(temporary, { recursive: true, force: true })
}
