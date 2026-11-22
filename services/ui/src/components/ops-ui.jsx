import React, { useState } from 'react';

export const btn = (color = '#94a3b8', disabled) => ({
  background: 'none', border: `1px solid ${disabled ? '#2d3148' : color}`, color: disabled ? '#475569' : color,
  padding: '4px 10px', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, marginRight: 6, marginBottom: 4,
});
export const input = { background: '#0f1117', color: '#e2e8f0', border: '1px solid #2d3148', borderRadius: 4, padding: '4px 8px', fontSize: 12 };
export const MODE_COLOR = { live: '#4ade80', polling: '#fbbf24', connecting: '#64748b', paused: '#64748b', error: '#f87171' };

// Runs an async action with busy + result message. `run(fn, okText)`; fn may return an object (shown via okText(r)).
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function run(fn, ok = 'Done') {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: typeof ok === 'function' ? ok(r) : ok }); return r; }
    catch (ex) { setMsg({ ok: false, text: ex.message }); }
    finally { setBusy(false); }
  }
  return { busy, msg, run, clear: () => setMsg(null) };
}

export const Msg = ({ msg }) => msg && (
  <p role="status" style={{ color: msg.ok ? '#4ade80' : '#f87171', fontSize: 12, margin: '6px 0' }}>{msg.text}</p>
);

// Type-to-confirm for destructive actions: the button stays disabled until the word is typed.
export function TypeConfirm({ title, word, onConfirm, onCancel }) {
  const [v, setV] = useState('');
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
         style={{ position: 'fixed', inset: 0, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: '#1a1d2e', border: '1px solid #f87171', borderRadius: 8, padding: 24, width: 380 }}>
        <h3 style={{ color: '#f87171', fontSize: 15, marginBottom: 10 }}>{title}</h3>
        <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>This is recorded in the audit log. Type <b style={{ color: '#e2e8f0' }}>{word}</b> to continue.</p>
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} style={{ ...input, width: '100%', marginBottom: 14 }}
               onKeyDown={(e) => e.key === 'Enter' && v === word && onConfirm()} aria-label={`Type ${word} to confirm`} />
        <button style={btn('#f87171', v !== word)} disabled={v !== word} onClick={onConfirm}>Confirm</button>
        <button style={btn()} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Stream controls: connection state, pause/resume, frame interval.
export function StreamBar({ s }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ color: MODE_COLOR[s.mode] }}>● {s.mode}</span>
      <select aria-label="Stream interval" value={s.intervalMs} onChange={(e) => s.setIntervalMs(Number(e.target.value))} style={input}>
        {[1000, 2000, 5000, 10000].map((ms) => <option key={ms} value={ms}>{ms / 1000}s</option>)}
      </select>
      <button style={{ ...btn(), margin: 0 }} aria-pressed={s.paused} onClick={() => s.setPaused(!s.paused)}>{s.paused ? '▶ Resume stream' : '❚❚ Pause stream'}</button>
    </span>
  );
}
