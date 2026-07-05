# Runbook: Queue Stuck

**Symptom:** Jobs enqueued but no worker picks them up. Queue length (`jobs:pending`) grows indefinitely.

## Check in order

### 1 — Are workers running?
```bash
kubectl -n loadtest-system get pods -l app=worker
```
Expected: at least 1 pod in `Running/Ready` state.

### 2 — Are workers connecting to Redis?
```bash
kubectl -n loadtest-system logs -l app=worker --tail=30
```
Look for: `"level":"ERROR","msg":"redis client error"` — if present, Redis is unreachable.

### 3 — Is Redis reachable?
```bash
kubectl -n loadtest-system exec deploy/worker -- redis-cli -u redis://redis:6379 ping
```
Expected: `PONG`

### 4 — Check the processing queue for stuck/orphaned jobs
```bash
REDIS_POD=$(kubectl -n loadtest-system get pods -l app=redis -o jsonpath='{.items[0].metadata.name}')
kubectl -n loadtest-system exec $REDIS_POD -- redis-cli llen jobs:processing
kubectl -n loadtest-system exec $REDIS_POD -- redis-cli llen jobs:pending
kubectl -n loadtest-system exec $REDIS_POD -- redis-cli llen jobs:dead-letter
```
If `jobs:processing` > 0 but no workers are running → orphaned jobs. Move them back:
```bash
kubectl -n loadtest-system exec $REDIS_POD -- \
  redis-cli eval "local jobs = redis.call('lrange','jobs:processing',0,-1); for _,j in ipairs(jobs) do redis.call('lpush','jobs:pending',j) end; redis.call('del','jobs:processing'); return #jobs" 0
```

### 5 — Check KEDA ScaledObject status
```bash
kubectl -n loadtest-system get scaledobject worker-scaledobject
kubectl -n loadtest-system describe scaledobject worker-scaledobject
```
Look for `IsActive: false` with pending jobs — indicates KEDA trigger is not firing.

### 6 — Restart workers manually
```bash
kubectl -n loadtest-system rollout restart deployment/worker
```

## Resolution checklist
- [ ] Redis reachable ✓
- [ ] No orphaned jobs in `jobs:processing` ✓
- [ ] KEDA `IsActive: true` when queue > 0 ✓
- [ ] Workers healthy (liveness probe passing) ✓
