/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from '@opencode-ai/plugin/tui'
import { getLimitsSnapshot, type LimitsWindowSnapshot } from './limits-snapshot.js'

function percent(window: LimitsWindowSnapshot | undefined): number | null {
  if (window?.remaining === undefined || !window.limit) return null
  return Math.max(0, Math.min(100, Math.round(window.remaining / window.limit * 100)))
}

function meter(value: number | null): string {
  if (value === null) return '--------'
  const filled = Math.round(value / 12.5)
  return `${'█'.repeat(filled)}${'░'.repeat(8 - filled)}`
}

function meterColor(theme: TuiThemeCurrent, value: number | null) {
  if (value === null) return theme.textMuted
  if (value <= 10) return theme.error
  if (value <= 30) return theme.warning
  return theme.success
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const snapshot = getLimitsSnapshot()

  return (
    <box flexDirection="column">
      <text fg={theme().text}>
        <b>Codex limits</b>
        <span style={{ fg: theme().textMuted }}>  {snapshot.accounts.length} accounts</span>
      </text>
      {snapshot.locked ? (
        <text fg={theme().warning}>Store locked</text>
      ) : snapshot.accounts.length === 0 ? (
        <text fg={theme().textMuted}>No accounts</text>
      ) : snapshot.accounts.map((account) => {
        const fiveHour = percent(account.fiveHour)
        const weekly = percent(account.weekly)
        const marker = !account.enabled ? '×' : account.active ? '●' : '○'
        const markerColor = !account.enabled ? theme().textMuted : account.active ? theme().primary : theme().textMuted
        const state = account.confidence === 'fresh' ? '' : account.confidence === 'error' ? ' !' : ' ~'
        return (
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme().text}>
              <span style={{ fg: markerColor }}>{marker}</span> {account.label}
              <span style={{ fg: theme().textMuted }}>{state}</span>
            </text>
            <text>
              <span style={{ fg: theme().textMuted }}>  5h </span>
              <span style={{ fg: meterColor(theme(), fiveHour) }}>{meter(fiveHour)} {fiveHour === null ? ' --' : String(fiveHour).padStart(3)}%</span>
            </text>
            <text>
              <span style={{ fg: theme().textMuted }}>  7d </span>
              <span style={{ fg: meterColor(theme(), weekly) }}>{meter(weekly)} {weekly === null ? ' --' : String(weekly).padStart(3)}%</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content() {
        return <View api={api} />
      }
    }
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'guard22.multi-auth-codex',
  tui
}

export default plugin
