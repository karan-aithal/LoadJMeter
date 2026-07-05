import React from 'react';

const GRAFANA = import.meta.env.VITE_GRAFANA_URL || 'http://localhost:3001';

const PANELS = [
  { uid: 'loadtest-sut',   title: 'SUT — Rate / Errors / Duration', panelId: 7 },
  { uid: 'loadtest-fleet', title: 'Fleet — Active Workers / CPU Saturation', panelId: 6 },
];

export default function GrafanaEmbed({ from = 'now-30m', to = 'now' }) {
  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={{ fontSize: 15, color: '#94a3b8', marginBottom: 16 }}>Live Grafana Panels</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {PANELS.map(({ uid, title, panelId }) => {
          const src = `${GRAFANA}/d-solo/${uid}?orgId=1&panelId=${panelId}&from=${from}&to=${to}&theme=dark&kiosk`;
          return (
            <div key={uid}>
              <p style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>{title}</p>
              <iframe
                src={src}
                style={{ width: '100%', height: 280, border: 'none', borderRadius: 6,
                         background: '#1a1d2e' }}
                title={title}
              />
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: '#374151', marginTop: 8 }}>
        Full dashboards: <a href={GRAFANA} target="_blank" rel="noreferrer"
          style={{ color: '#7c83fd' }}>{GRAFANA}</a>
      </p>
    </div>
  );
}
