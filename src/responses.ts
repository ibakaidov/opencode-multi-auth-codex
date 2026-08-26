const DEFAULT_LATEST_CODEX_MODEL = 'gpt-5.5'

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

export function supportsFastMode(model: string | undefined): boolean {
  return model === 'gpt-5.5' || model === 'gpt-5.4'
}

export function transformResponsesPayload(body: Record<string, any>): Record<string, any> {
  const normalizedModel = normalizeModel(body.model)
  const fastMode = /-fast$/.test(body.model || '')
  const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/)
  const payload: Record<string, any> = {
    ...body,
    model: normalizedModel,
    store: false
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
