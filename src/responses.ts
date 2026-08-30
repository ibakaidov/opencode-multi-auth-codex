const DEFAULT_LATEST_CODEX_MODEL = 'gpt-5.5'
const OPENCODE_CORE_TOOLS = new Set([
  'question', 'bash', 'read', 'glob', 'grep', 'task', 'webfetch', 'todowrite', 'skill', 'apply_patch'
])

function filterInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  return input
    .filter((item) => item?.type !== 'item_reference')
    .map((item) => {
      if (item && typeof item === 'object' && 'id' in item) {
        const { id, ...rest } = item as Record<string, unknown>
        return rest
      }
      return item
    })
}

export function normalizeModel(model: string | undefined): string {
  if (!model) return 'gpt-5.1'

  const modelId = model.includes('/') ? model.split('/').pop()! : model
  const baseModel = modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh)$/, '')
  const preferLatestRaw = process.env.OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST
  const preferLatest = preferLatestRaw === '1' || preferLatestRaw === 'true'

  if (
    preferLatest &&
    (
      baseModel === 'gpt-5.4' ||
      baseModel === 'gpt-5.3-codex' ||
      baseModel === 'gpt-5.2-codex' ||
      baseModel === 'gpt-5-codex'
    )
  ) {
    const latestModel = (
      process.env.OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL || DEFAULT_LATEST_CODEX_MODEL
    ).trim()

    if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
      console.log(`[multi-auth] model map: ${baseModel} -> ${latestModel}`)
    }

    return latestModel
  }

  return baseModel
}

function isSparkModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('gpt-5.3-codex-spark')
}

function resolvePointer(root: Record<string, any>, ref: string): unknown {
  const parts = ref.slice(2).split('/').map(decodeURIComponent)
  let node: unknown = root
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, any>)[part]
  }
  return node
}

const TOOL_NAME_RX = /^[A-Za-z0-9_-]{1,128}$/
const SCHEMA_PROPERTY_RX = /^[A-Za-z0-9_.-]{1,128}$/
const SCHEMA_NUMERIC_FIELDS = [
  'minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'
] as const
const SCHEMA_STRING_FIELDS: Record<string, number> = { description: 4096, pattern: 1024 }

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cutString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function sanitizeJsonSchema(
  value: unknown,
  root: Record<string, any>,
  seen: Set<string>,
  depth: number
): Record<string, any> {
  if (!isRecord(value)) return { type: 'object' }
  if (depth > 12) return {}

  const out: Record<string, any> = {}
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/') && !seen.has(value.$ref)) {
    const target = resolvePointer(root, value.$ref)
    if (isRecord(target)) {
      seen.add(value.$ref)
      const resolved = sanitizeJsonSchema(target, root, seen, depth + 1)
      seen.delete(value.$ref)
      Object.assign(out, resolved)
    }
  }

  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type]
    const allowed = types.filter(
      (t) => typeof t === 'string' && ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'].includes(t)
    )
    if (allowed.length > 0) out.type = value.type
  }

  for (const [field, max] of Object.entries(SCHEMA_STRING_FIELDS)) {
    if (typeof value[field] === 'string') out[field] = cutString(value[field], max)
  }

  if (Array.isArray(value.required)) {
    const entries = value.required.filter((entry) => typeof entry === 'string')
    if (entries.length > 0) out.required = entries.slice(0, 100)
  }
  if (Array.isArray(value.enum)) {
    const entries = value.enum.filter((entry) => !isRecord(entry) && !Array.isArray(entry))
    if (entries.length > 0) out.enum = entries.slice(0, 100)
  }
  if (value.const !== undefined && !isRecord(value.const) && !Array.isArray(value.const)) {
    out.const = value.const
  }

  for (const field of SCHEMA_NUMERIC_FIELDS) {
    if (typeof value[field] === 'number' && Number.isFinite(value[field])) out[field] = value[field]
  }

  for (const field of ['properties', '$defs'] as const) {
    if (!isRecord(value[field])) continue
    const entries = Object.entries(value[field]).filter(([name]) => SCHEMA_PROPERTY_RX.test(name))
    if (entries.length === 0) continue
    const trimmed = entries.slice(0, 100)
    const sanitized: Record<string, any> = {}
    for (const [name, child] of trimmed) {
      sanitized[name] = { ...sanitizeJsonSchema(child, root, seen, depth + 1) }
    }
    out[field] = sanitized
  }

  if (isRecord(value.items)) {
    out.items = { ...sanitizeJsonSchema(value.items, root, seen, depth + 1) }
  } else if (Array.isArray(value.items)) {
    out.items = { ...sanitizeJsonSchema(value.items[0], root, seen, depth + 1) }
  }

  for (const field of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!Array.isArray(value[field])) continue
    const trimmed = value[field].filter((child) => isRecord(child)).slice(0, 20)
    if (trimmed.length === 0) continue
    out[field] = trimmed.map((child) => ({ ...sanitizeJsonSchema(child, root, seen, depth + 1) }))
  }

  if (value.additionalProperties !== undefined) {
    out.additionalProperties = typeof value.additionalProperties === 'boolean' ? value.additionalProperties : true
  }

  return out
}

function sanitizeTools(tools: unknown): any[] {
  if (!Array.isArray(tools)) return []
  const priority = (tool: unknown) => (
    isRecord(tool) && typeof tool.name === 'string' && OPENCODE_CORE_TOOLS.has(tool.name) ? 1 : 0
  )
  const prioritized = [...tools].sort((a, b) => priority(b) - priority(a))
  const out: any[] = []
  for (const tool of prioritized) {
    if (!isRecord(tool) || tool.type !== 'function' || typeof tool.name !== 'string') continue
    if (!TOOL_NAME_RX.test(tool.name)) {
      if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
        console.log(`[multi-auth] drop tool: ${tool.name}`)
      }
      continue
    }
    const clean: Record<string, any> = { type: 'function', name: tool.name }
    if (typeof tool.description === 'string') clean.description = cutString(tool.description, 4096)
    if (tool.strict !== undefined) clean.strict = typeof tool.strict === 'boolean' ? tool.strict : false
    clean.parameters = isRecord(tool.parameters)
      ? sanitizeJsonSchema(tool.parameters, tool.parameters, new Set(), 0)
      : { type: 'object' }
    out.push(clean)
    if (out.length === 128) break
  }
  return out
}

export function supportsFastMode(model: string | undefined): boolean {
  return model === 'gpt-5.5' || model === 'gpt-5.4'
}

export function transformResponsesPayload(body: Record<string, any>): Record<string, any> {
  const normalizedModel = normalizeModel(body.model)
  const fastMode = /-fast$/.test(body.model || '')
  const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/)
  const payload: Record<string, any> = {
    ...body,
    model: normalizedModel
  }
  delete payload.store
  if (Array.isArray(payload.tools)) {
    payload.tools = sanitizeTools(payload.tools)
  }

  if (payload.truncation === undefined) {
    const truncationRaw = (process.env.OPENCODE_MULTI_AUTH_TRUNCATION || '').trim()
    if (truncationRaw && truncationRaw !== 'disabled' && truncationRaw !== 'false' && truncationRaw !== '0') {
      payload.truncation = truncationRaw
    }
  }
  if (payload.input) payload.input = filterInput(payload.input)

  if (reasoningMatch?.[1]) {
    payload.reasoning = {
      ...(payload.reasoning || {}),
      effort: reasoningMatch[1]
    }
    if (!isSparkModel(normalizedModel)) {
      payload.reasoning.summary = payload.reasoning?.summary || 'auto'
    }
  }
  if (isSparkModel(normalizedModel) && payload.reasoning?.summary !== undefined) {
    delete payload.reasoning.summary
  }
  if (fastMode && supportsFastMode(normalizedModel)) {
    payload.service_tier = payload.service_tier || 'priority'
  }
  delete payload.reasoning_effort
  return payload
}
