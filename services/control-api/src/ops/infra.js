'use strict';

// Real-infrastructure chaos: kill / restart / partition the worker containers (docker) or pods (k8s).
// Opt-in twice: CHAOS_ENABLED (routes) and CHAOS_DRIVER (+ the docker socket or a k8s Role). Only workers can be touched:
// every target must appear in the driver's own filtered list, so the API can never act on an arbitrary container.
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const producer = require('../queue/redis-producer');
const logger   = require('../logger');

const bad = (status, msg) => Object.assign(new Error(msg), { status });
const heals = new Map(); // container id -> timer (best effort; the network list in Redis lets /infra/heal work after a restart)

// ── docker (Engine API over the unix socket) ────────────────────────────────────────────────────────────────
const SOCK  = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const LABEL = process.env.CHAOS_DOCKER_LABEL || 'com.docker.compose.service=worker';

function dockerCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ socketPath: SOCK, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = buf ? JSON.parse(buf) : null; } catch { /* plain-text error body */ }
        if (res.statusCode >= 400) return reject(bad(502, `docker ${method} ${path.split('?')[0]}: ${(json && json.message) || res.statusCode}`));
        resolve(json);
      });
    });
    req.on('error', (e) => reject(bad(502, `docker socket: ${e.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

const docker = {
  name: 'docker',
  async list() {
    const rows = await dockerCall('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [LABEL] }))}`);
    return rows.map((c) => ({ id: c.Id.slice(0, 12), name: (c.Names[0] || '').replace(/^\//, ''), state: c.State, status: c.Status }));
  },
  kill:    (id) => dockerCall('POST', `/containers/${id}/kill`),
  start:   (id) => dockerCall('POST', `/containers/${id}/start`),
  restart: (id) => dockerCall('POST', `/containers/${id}/restart?t=0`),
  async partition(id, seconds) {
    const info = await dockerCall('GET', `/containers/${id}/json`);
    const nets = Object.entries(info.NetworkSettings.Networks || {}).map(([net, n]) => ({ net, aliases: n.Aliases || [] }));
    if (!nets.length) throw bad(409, 'worker is already isolated');
    await producer.getClient().set(`ops:partition:${id}`, JSON.stringify(nets), 'EX', 3600);
    for (const { net } of nets) await dockerCall('POST', `/networks/${net}/disconnect`, { Container: id, Force: true });
    clearTimeout(heals.get(id));
    const t = setTimeout(() => docker.heal(id).catch((e) => logger.error('auto-heal failed', { id, error: e.message })), seconds * 1000);
    t.unref(); heals.set(id, t);
    return { isolated: nets.map((n) => n.net), healsInSeconds: seconds };
  },
  async heal(id) {
    const redis = producer.getClient();
    const raw = await redis.get(`ops:partition:${id}`);
    if (!raw) throw bad(409, 'worker is not isolated by this API');
    for (const { net, aliases } of JSON.parse(raw)) {
      await dockerCall('POST', `/networks/${net}/connect`, { Container: id, EndpointConfig: { Aliases: aliases } });
    }
    await redis.del(`ops:partition:${id}`);
    clearTimeout(heals.get(id)); heals.delete(id);
    return { healed: id };
  },
};

// ── kubernetes (in-cluster API with the pod's service account) ───────────────────────────────────────────────
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
function k8sCall(method, path) {
  return new Promise((resolve, reject) => {
    let token, ca, ns;
    try { token = fs.readFileSync(`${SA}/token`, 'utf8'); ca = fs.readFileSync(`${SA}/ca.crt`); ns = fs.readFileSync(`${SA}/namespace`, 'utf8').trim(); }
    catch (e) { return reject(bad(502, `no service account: ${e.message}`)); }
    const req = https.request({ host: process.env.KUBERNETES_SERVICE_HOST, port: process.env.KUBERNETES_SERVICE_PORT || 443, method, ca,
      path: path.replace('{ns}', ns), headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = buf ? JSON.parse(buf) : null; } catch { /* ignore */ }
        if (res.statusCode >= 400) return reject(bad(502, `k8s ${method}: ${(json && json.message) || res.statusCode}`));
        resolve(json);
      });
    });
    req.on('error', (e) => reject(bad(502, `k8s api: ${e.message}`)));
    req.end();
  });
}
const SELECTOR = encodeURIComponent(process.env.CHAOS_K8S_SELECTOR || 'app=worker');
const unsupported = (what) => () => { throw bad(501, `${what} is not available on k8s; use infra/scripts/chaos-partition-worker.sh`); };
const k8s = {
  name: 'k8s',
  async list() {
    const r = await k8sCall('GET', `/api/v1/namespaces/{ns}/pods?labelSelector=${SELECTOR}`);
    return r.items.map((p) => ({ id: p.metadata.name, name: p.metadata.name, state: p.status.phase.toLowerCase(), status: p.status.phase }));
  },
  kill:    (id) => k8sCall('DELETE', `/api/v1/namespaces/{ns}/pods/${id}?gracePeriodSeconds=0`),
  restart: (id) => k8sCall('DELETE', `/api/v1/namespaces/{ns}/pods/${id}`),   // the Deployment starts the replacement
  start:   unsupported('start (the Deployment restarts pods itself)'),
  partition: unsupported('partition'),
  heal:      unsupported('heal'),
};

const DRIVERS = { docker, k8s };
const driver = () => DRIVERS[process.env.CHAOS_DRIVER] || null;

// Run `action` on `id`, refusing anything the driver does not list as a worker.
async function run(action, id, opts = {}) {
  const d = driver();
  if (!d) throw bad(501, 'No chaos driver configured (CHAOS_DRIVER=docker|k8s)');
  if (!['kill', 'start', 'restart', 'partition', 'heal'].includes(action)) throw bad(400, `Unknown action: ${action}`);
  if (!(await d.list()).some((w) => w.id === id)) throw bad(404, 'Not a worker managed by this driver');
  return d[action](id, opts.seconds);
}

module.exports = { driver, run, DRIVERS };
