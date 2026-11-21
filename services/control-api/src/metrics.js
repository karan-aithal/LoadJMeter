'use strict';

// In-process counters for events that were previously only log lines. Reset on restart (Prometheus handles that).
// ponytail: hand-rolled text exposition for 2 counters, switch to prom-client if more metrics are added.
const counters = { reaped_total: 0, fenced_writes_total: 0 };

const inc = (name) => { counters[name] += 1; };
const snapshot = () => ({ ...counters });

function render() {
  return Object.entries(counters)
    .map(([k, v]) => `# TYPE control_api_${k} counter\ncontrol_api_${k} ${v}\n`)
    .join('');
}

module.exports = { inc, snapshot, render };
