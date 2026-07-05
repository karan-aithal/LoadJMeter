import React, { useState } from 'react';
import { useAuth } from '../App.jsx';
import { api } from '../api/client.js';

const SCENARIOS = ['base', 'fast', 'slow', 'cpu-heavy'];
const DURATION_RE = /^[1-9][0-9]*(s|m|h)$/;

const inp = {
  width: '100%', padding: '8px 12px', background: '#0f1117',
  color: '#e2e8f0', border: '1px solid #2d3148', borderRadius: 4, fontSize: 14,
};
const label = { display: 'block', marginBottom: 6, fontSize: 13, color: '#94a3b8' };

export default function TestForm({ onCreated }) {
  const { token } = useAuth();
  const [form, setForm] = useState({ scenario: 'base', vus: '10', duration: '30s', rampUp: '10s', rampDown: '10s' });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [apiErr, setApiErr] = useState('');

  function set(field) {
    return (e) => setForm(f => ({ ...f, [field]: e.target.value }));
  }

  function validate() {
    const e = {};
    const vus = parseInt(form.vus, 10);
    if (!Number.isInteger(vus) || vus < 1 || vus > 500) e.vus = 'VUs must be 1–500';
    if (!DURATION_RE.test(form.duration)) e.duration = 'Use format: 30s, 5m, 1h';
    if (form.rampUp  && !DURATION_RE.test(form.rampUp))  e.rampUp  = 'Use format: 10s, 1m';
    if (form.rampDown && !DURATION_RE.test(form.rampDown)) e.rampDown = 'Use format: 10s, 1m';
    return e;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setLoading(true); setApiErr('');
    try {
      const idempotencyKey = `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const run = await api.createTest(
        { scenario: form.scenario, vus: parseInt(form.vus, 10),
          duration: form.duration, rampUp: form.rampUp || undefined, rampDown: form.rampDown || undefined },
        idempotencyKey, token
      );
      onCreated?.(run);
    } catch (ex) {
      setApiErr(ex.data?.details?.join(', ') || ex.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ background: '#1a1d2e', padding: 24, borderRadius: 8 }}>
      <h3 style={{ marginBottom: 20, fontSize: 16, color: '#e2e8f0' }}>Launch Test</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 24px' }}>
        <div>
          <label style={label}>Scenario</label>
          <select value={form.scenario} onChange={set('scenario')} style={inp}>
            {SCENARIOS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={label}>Virtual Users (1–500)</label>
          <input type="number" min="1" max="500" value={form.vus} onChange={set('vus')} style={inp} />
          {errors.vus && <span style={{ color: '#f87171', fontSize: 12 }}>{errors.vus}</span>}
        </div>
        <div>
          <label style={label}>Duration (e.g. 30s, 5m)</label>
          <input value={form.duration} onChange={set('duration')} style={inp} placeholder="30s" />
          {errors.duration && <span style={{ color: '#f87171', fontSize: 12 }}>{errors.duration}</span>}
        </div>
        <div>
          <label style={label}>Ramp-up</label>
          <input value={form.rampUp} onChange={set('rampUp')} style={inp} placeholder="10s" />
          {errors.rampUp && <span style={{ color: '#f87171', fontSize: 12 }}>{errors.rampUp}</span>}
        </div>
        <div>
          <label style={label}>Ramp-down</label>
          <input value={form.rampDown} onChange={set('rampDown')} style={inp} placeholder="10s" />
          {errors.rampDown && <span style={{ color: '#f87171', fontSize: 12 }}>{errors.rampDown}</span>}
        </div>
      </div>
      {apiErr && <p style={{ color: '#f87171', marginTop: 12, fontSize: 13 }}>{apiErr}</p>}
      <button type="submit" disabled={loading}
        style={{ marginTop: 20, padding: '10px 28px', background: '#7c83fd', color: '#fff',
                 border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
        {loading ? 'Launching…' : '▶ Launch'}
      </button>
    </form>
  );
}
