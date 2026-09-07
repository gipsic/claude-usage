import { notify, fireOnce } from './notify.mjs';
import { WINDOWS } from './limits.mjs';
import { serviceStatus } from './status.mjs';

const pct = (n) => `${n.toFixed(0)}%`;
const mins = (ms) => Math.round(ms / 60000);

const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h < 24 && min < 60 ? h * 60 + min : null;
};

/** Whether `now` falls inside a quiet-hours window, which may wrap past midnight. */
export function inQuietHours(q, now = Date.now()) {
  const start = hhmm(q?.start), end = hhmm(q?.end);
  if (start == null || end == null || start === end) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * Why banners are being held back right now, or null.
 *
 * Silence is not the same as off. A held-back alert is still recorded, so it
 * counts as fired for its window instance - otherwise unmuting would dump every
 * threshold crossed in the meantime into Notification Center at once.
 */
export function silencedBy(cfg, now = Date.now()) {
  const a = cfg?.alerts || {};
  if (a.mutedUntil && a.mutedUntil > now) return 'muted';
  if (inQuietHours(a.quietHours, now)) return 'quiet-hours';
  return null;
}

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
  const silenced = silencedBy(cfg, now);
  const fired = [];
  const emit = (id, payload) => {
    if (!fireOnce(db, id, payload)) return;
    fired.push({ id, ...payload, silenced });
    if (send && !silenced) notify(payload.notification);
  };

  for (const [win, s] of Object.entries(state)) {
    if (s.utilization == null || !s.resetsAt) continue;
    const label = WINDOWS[win]?.label || win;
    const inst = `${account}:${win}:${s.resetsAt}`;

    // Per-model weekly windows are named by what the plan reports
    // (seven_day_fable, ...), so they match the seven_day_* wildcard unless a
    // specific entry exists.
    const thresholds = a.thresholds?.[win]
      ?? (win.startsWith('seven_day_') && win !== 'seven_day' ? a.thresholds?.['seven_day_*'] : undefined)
      ?? [];
    for (const t of thresholds) {
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

export async function evaluateService(db, cfg, { send = true, now = Date.now() } = {}) {
  if (!cfg.alerts?.enabled || !cfg.alerts?.serviceStatus) return [];
  const st = await serviceStatus();
  if (!st.ok || st.indicator === 'none') return [];
  const silenced = silencedBy(cfg, now);
  const fired = [];
  for (const inc of st.incidents) {
    const id = `status:${inc.url || inc.name}:${inc.status}`;
    if (!fireOnce(db, id, { window: null, kind: 'status', detail: `${inc.impact}: ${inc.name}` })) continue;
    fired.push({ id, kind: 'status', detail: inc.name, silenced });
    if (send && !silenced) notify({
      title: `Anthropic: ${st.description}`,
      subtitle: inc.impact ? `impact: ${inc.impact}` : '',
      message: `${inc.name} (${inc.status})`,
      sound: 'Submarine',
    });
  }
  return fired;
}
