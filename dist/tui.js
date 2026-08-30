import { jsx as _jsx, jsxs as _jsxs } from "@opentui/solid/jsx-runtime";
import { getLimitsSnapshot } from './limits-snapshot.js';
function percent(window) {
    if (window?.remaining === undefined || !window.limit)
        return null;
    return Math.max(0, Math.min(100, Math.round(window.remaining / window.limit * 100)));
}
function meter(value) {
    if (value === null)
        return '--------';
    const filled = Math.round(value / 12.5);
    return `${'█'.repeat(filled)}${'░'.repeat(8 - filled)}`;
}
function meterColor(theme, value) {
    if (value === null)
        return theme.textMuted;
    if (value <= 10)
        return theme.error;
    if (value <= 30)
        return theme.warning;
    return theme.success;
}
function View(props) {
    const theme = () => props.api.theme.current;
    const snapshot = getLimitsSnapshot();
    return (_jsxs("box", { flexDirection: "column", children: [_jsxs("text", { fg: theme().text, children: [_jsx("b", { children: "Codex limits" }), _jsxs("span", { style: { fg: theme().textMuted }, children: ["  ", snapshot.accounts.length, " accounts"] })] }), snapshot.locked ? (_jsx("text", { fg: theme().warning, children: "Store locked" })) : snapshot.accounts.length === 0 ? (_jsx("text", { fg: theme().textMuted, children: "No accounts" })) : snapshot.accounts.map((account) => {
                const fiveHour = percent(account.fiveHour);
                const weekly = percent(account.weekly);
                const marker = !account.enabled ? '×' : account.active ? '●' : '○';
                const markerColor = !account.enabled ? theme().textMuted : account.active ? theme().primary : theme().textMuted;
                const state = account.confidence === 'fresh' ? '' : account.confidence === 'error' ? ' !' : ' ~';
                return (_jsxs("box", { flexDirection: "column", paddingTop: 1, children: [_jsxs("text", { fg: theme().text, children: [_jsx("span", { style: { fg: markerColor }, children: marker }), " ", account.label, _jsx("span", { style: { fg: theme().textMuted }, children: state })] }), _jsxs("text", { children: [_jsx("span", { style: { fg: theme().textMuted }, children: "  5h " }), _jsxs("span", { style: { fg: meterColor(theme(), fiveHour) }, children: [meter(fiveHour), " ", fiveHour === null ? ' --' : String(fiveHour).padStart(3), "%"] })] }), _jsxs("text", { children: [_jsx("span", { style: { fg: theme().textMuted }, children: "  7d " }), _jsxs("span", { style: { fg: meterColor(theme(), weekly) }, children: [meter(weekly), " ", weekly === null ? ' --' : String(weekly).padStart(3), "%"] })] })] }));
            })] }));
}
const tui = async (api) => {
    api.slots.register({
        order: 250,
        slots: {
            sidebar_content() {
                return _jsx(View, { api: api });
            }
        }
    });
};
const plugin = {
    id: 'guard22.multi-auth-codex',
    tui
};
export default plugin;
//# sourceMappingURL=tui.js.map