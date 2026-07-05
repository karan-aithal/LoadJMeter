# Runbook: Worker Crash Loop

**Symptom:** Worker pods restarting repeatedly. `kubectl get pods` shows `CrashLoopBackOff` or high restart count.

## Check in order

### 1 — Get crash logs
```bash
kubectl -n loadtest-system logs -l app=worker --previous --tail=50
```
Most common causes:
- `REDIS_URL` unreachable (worker can't connect on boot)
- `CONTROL_API_URL` unreachable (heartbeat/status update failing at startup)
- OOMKilled (worker or k6 exceeding memory limit)

### 2 — Check exit reason
```bash
kubectl -n loadtest-system describe pod -l app=worker | grep -A5 'Last State'
```
- `OOMKilled` → increase `worker.resources.limits.memory` in values.yaml
- `Error` (non-zero exit) → check logs for panic or unhandled rejection

### 3 — Check Redis + control-api reachability from worker
```bash
kubectl -n loadtest-system exec deploy/worker -- wget -qO- http://control-api:4000/healthz
kubectl -n loadtest-system exec deploy/worker -- redis-cli -u redis://redis:6379 ping
```

### 4 — Check if a job is stuck in jobs:processing
A crashed worker may leave a job in the processing queue.
```bash
REDIS_POD=$(kubectl -n loadtest-system get pods -l app=redis -o jsonpath='{.items[0].metadata.name}')
kubectl -n loadtest-system exec $REDIS_POD -- redis-cli lrange jobs:processing 0 -1
```
If stuck: manually move back to pending (see queue-stuck runbook).

### 5 — Check resource limits
```bash
kubectl -n loadtest-system top pods -l app=worker
```
If close to limits, edit `values.yaml` and run `helm upgrade`.

## Resolution checklist
- [ ] Redis and control-api reachable from worker
- [ ] No OOMKilled events
- [ ] jobs:processing drained or requeued
- [ ] Worker pods stable for 5+ minutes
