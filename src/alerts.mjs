import { notify, fireOnce } from './notify.mjs';
import { WINDOWS } from './limits.mjs';
import { serviceStatus } from './status.mjs';

const pct = (n) => `${n.toFixed(0)}%`;
const mins = (ms) => Math.round(ms / 60000);

function fmtReset(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Evaluate every alert rule against the current limit state.
 * Each rule fires at most once per window instance (keyed on the window's reset time),
 * so a dashboard refreshing every 30s does not re-notify.
 */
export function evaluate(db, state, cfg, { account = 'default', now = Date.now(), send = true } = {}) {
  const a = cfg.alerts || {};
  if (!a.enabled) return [];
  const fired = [];
  const emit = (id, payload) => {
    if (!fireOnce(db, id, payload)) return;
    fired.push({ id, ...payload });
    if (send) notify(payload.notification);
  };

  for (const [win, s] of Object.entries(state)) {
    if (s.utilization == null || !s.resetsAt) continue;
    const label = WINDOWS[win]?.label || win;
    const inst = `${account}:${win}:${s.resetsAt}`;

    for (const t of a.thresholds?.[win] || []) {
      if (s.utilization < t) continue;
      emit(`${inst}:threshold:${t}`, {
        window: win, kind: 'threshold', detail: `${pct(s.utilization)} of ${label}`,
        notification: {
          title: `Claude usage ${pct(s.utilization)}`,
          subtitle: label,
          message: `Crossed ${t}%. Resets ${fmtReset(s.resetsAt)}.`,
          sound: t >= 95 ? 'Basso' : 'Ping',
        },
      });
    }

    for (const m of a.resetReminderMinutes || []) {
      if (s.remainingMs > m * 60e3 || s.remainingMs <= 0) continue;
      if (s.utilization < 25) continue; // nothing worth waiting for
      emit(`${inst}:reset:${m}`, {
        window: win, kind: 'reset', detail: `${label} resets in ${mins(s.remainingMs)}m`,
        notification: {
          title: `${label} resets soon`,
          subtitle: `at ${fmtReset(s.resetsAt)}`,
          message: `${mins(s.remainingMs)} minutes left, currently ${pct(s.utilization)}.`,
          sound: 'Pop',
        },
      });
    }

    if (a.burnWarning && s.exhaustAt && s.utilization >= 40 && s.utilization < 100) {
      emit(`${inst}:burn`, {
        window: win, kind: 'burn',
        detail: `Projected to hit 100% at ${fmtReset(s.exhaustAt)}`,
        notification: {
          title: `On pace to exhaust ${label}`,
          subtitle: `at this burn rate`,
          message: `Hits 100% around ${fmtReset(s.exhaustAt)} — ${mins(s.resetsAt - s.exhaustAt)}m before reset.`,
          sound: 'Funk',
        },
      });
    }
  }
  return fired;
}

export async function evaluateService(db, cfg, { send = true } = {}) {
  if (!cfg.alerts?.enabled || !cfg.alerts?.serviceStatus) return [];
  const st = await serviceStatus();
  if (!st.ok || st.indicator === 'none') return [];
  const fired = [];
  for (const inc of st.incidents) {
    const id = `status:${inc.url || inc.name}:${inc.status}`;
    if (!fireOnce(db, id, { window: null, kind: 'status', detail: `${inc.impact}: ${inc.name}` })) continue;
    fired.push({ id, kind: 'status', detail: inc.name });
    if (send) notify({
      title: `Anthropic: ${st.description}`,
      subtitle: inc.impact ? `impact: ${inc.impact}` : '',
      message: `${inc.name} (${inc.status})`,
      sound: 'Submarine',
    });
  }
  return fired;
}
