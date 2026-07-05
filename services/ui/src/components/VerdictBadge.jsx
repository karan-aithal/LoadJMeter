import React from 'react';

const COLORS = {
  PASS:          { bg: '#166534', color: '#4ade80', border: '#15803d' },
  FAIL:          { bg: '#7f1d1d', color: '#f87171', border: '#991b1b' },
  INCONCLUSIVE:  { bg: '#713f12', color: '#fbbf24', border: '#92400e' },
  pending:       { bg: '#1e3a5f', color: '#60a5fa', border: '#1d4ed8' },
  running:       { bg: '#1e3a5f', color: '#38bdf8', border: '#0284c7' },
  completed:     { bg: '#166534', color: '#4ade80', border: '#15803d' },
  failed:        { bg: '#7f1d1d', color: '#f87171', border: '#991b1b' },
  cancelled:     { bg: '#1f2937', color: '#9ca3af', border: '#374151' },
};

export default function VerdictBadge({ value, size = 'sm' }) {
  const c = COLORS[value] || COLORS.cancelled;
  const pad = size === 'lg' ? '8px 20px' : '3px 10px';
  const fs   = size === 'lg' ? 18 : 12;
  return (
    <span style={{
      display: 'inline-block',
      padding: pad,
      fontSize: fs,
      fontWeight: 700,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      borderRadius: 4,
      border: `1px solid ${c.border}`,
      background: c.bg,
      color: c.color,
    }}>
      {value ?? '—'}
    </span>
  );
}
