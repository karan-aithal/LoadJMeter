# SLOs — System Under Test

## Defined SLOs

| Endpoint     | Metric          | SLO           | k6 Threshold                                     |
|--------------|-----------------|---------------|--------------------------------------------------|
| `/fast`      | p95 latency     | < 50 ms       | `http_req_duration{p(95)} < 50`                 |
| `/slow`      | p95 latency     | < 400 ms      | `http_req_duration{p(95)} < 400`                |
| `/cpu-heavy` | p95 latency     | < 2000 ms     | `http_req_duration{p(95)} < 2000`               |
| All          | Error rate      | < 1 %         | `http_req_failed rate < 0.01`                   |
| All          | p99 latency     | < 5000 ms     | `http_req_duration{p(99)} < 5000`               |

## Verdict Rules

| Verdict         | Condition                                                                 |
|-----------------|---------------------------------------------------------------------------|
| **PASS**        | All thresholds met, fleet CPU < 80 %                                     |
| **FAIL**        | Any SLO threshold breached AND fleet CPU < 80 %                          |
| **INCONCLUSIVE**| Fleet CPU saturation > 80 % during test run (fleet was bottleneck, not SUT) |

## Prometheus Alert Conditions

```yaml
# SLO breach
rate(http_errors_total[5m]) / rate(http_requests_total[5m]) > 0.01

# Fleet saturation (inconclusive flag): container cgroup CPU (includes the k6 child) / container CPU limit
max(worker_cpu_saturation_ratio) > 0.8
# also: worker_container_cpu_cores_used, worker_container_cpu_throttled_seconds_total
# worker_cpu_source{source="process"} = no cgroup: Node-only, k6 NOT counted
```

## Baselines (expected under no load, single node)

| Endpoint     | Typical p50 | Typical p95 |
|--------------|-------------|-------------|
| `/fast`      | ~2 ms       | ~5 ms       |
| `/slow`      | ~200 ms     | ~210 ms     |
| `/cpu-heavy` | ~5 ms       | ~10 ms      |

## Fleet scaling baseline (KEDA, worker 1 → 5)

Config (`infra/k8s/keda/scaledobject-worker.yaml`): poll 5 s, scale-up up to +5 pods / 15 s, cooldown 60 s, `listLength: 1` on `jobs:pending`.
Measure with `make load-queue N=6` (N must exceed 5: a worker pops one job at once). `t0` = last POST; output lines `RESULT time to 5 ...`.

### Preserved benchmark: CRC, 250m worker request (repo default)

Node: CRC, 3.8 CPU allocatable (~80% already requested), worker request 250m / limit 1. Control plane works; execution capacity is the limit.

| Run | Desired = 5 | Ready = 5 |
|-----|-------------|-----------|
| 1 | 15.0 s | not reached: 3 Ready (26.7 s), rest `FailedScheduling: Insufficient cpu` |
| 1b, 1c | 10.7 s / 6.0 s | not reached: 3 Ready max, up to 4 Pending |
| OKD lifecycle test (`okd-keda-*` from scratch) | 10.5 s | not reached: 3 Ready max, 4 Pending; script printed `CONSTRAINED:` |

### Capacity-unconstrained reference: worker request 50m (temporary live patch)

| Run | Desired = 5 | Ready = 5 |
|-----|-------------|-----------|
| 2 | 4.8 s | 17.4 s |
| 3 | 2.5 s | 15.3 s |
| 4 | 14.3 s | 28.4 s |
| **median** | **4.8 s** | **17.4 s** |

Scale-up mechanics only (N=6). Not a throughput or saturation measurement: use `make bench-backlog` for that.

### Sustained backlog (`make bench-backlog`, 30 jobs × `fast` 30 s, VUs 10)

CPU is container-level (cgroup `cpu.stat`, includes the k6 child) vs the container limit (1 core), sampled every 5 s from each worker's `/metrics` (2 s windows, so short spikes can be missed).

| Setup | Peak Ready | Fleet CPU peak | CPU / busy worker | Throttled | Drain | Throughput |
|-------|-----------|----------------|-------------------|-----------|-------|------------|
| CRC, request 250m | 3 (node CPU requests full; KEDA wanted 10) | 0.38 cores | ~0.02 cores (spikes to 0.12) | 0.5 s total | 553 s | 3.3 jobs/min |

Reading: backlog held for ~490 s (pending 29 → 0), so this is a real saturation test of *scheduling*, not CPU. Workers use ~2% of their 1-core limit and ~8% of their 250m request; throughput is bounded by worker count × job wall time (~55 s per job: 30 s run + ramp up/down), not by container CPU. The 250m request, not actual load, is what caps the fleet at 3 on this node. Not measured here: a CPU-heavy scenario, or more workers (needs a lower request or a bigger node).

### CPU metric validation (CRC, 1 worker, `fast` × 400 VUs, 30 s)

| Source | Idle | During k6 steady state |
|--------|------|------------------------|
| `worker_container_cpu_cores_used` (cgroup, k6 included) | ~0.005 | ~0.50 cores (limit 1) |
| direct `cpu.stat usage_usec` delta (independent probe) | ~0.006 | ~0.50 cores |
| Node process only (old measure, `process_cpu_*_seconds_total` delta) | ~0.003 | ~0.003 cores |

The old Node-only number missed ~99% of the container's CPU. A `cpu-heavy` scenario at 20 VUs left the container at ~0.012 cores: the work happens in the SUT, not in k6.
Throttle counter: three busy loops (synthetic, not k6) pushed the container to 1.0 core; `worker_container_cpu_throttled_seconds_total` went 0.36 → 25.35 s, equal to cgroup `throttled_usec`.

Semantics: `worker_job_duration_seconds` runs from job pick (after BRPOPLPUSH) to outcome (after ack/requeue), so it includes k6 ramp up/down (~53 s for `duration=30s`) and excludes queue wait. `worker_job_queue_wait_seconds` is control-api `createdAt` (DB row creation, just before enqueue) to execution start, first attempt only (retries and reaped jobs keep the original `createdAt`). Both are timed with different pod clocks, so cross-pod skew applies to the wait.

The metric is `LLEN jobs:pending` (AverageValue 1), so desired replicas = pending jobs; a job popped by a worker stops counting. With N=6 and 1 worker, pending is 5 right after the first pop, and it fell to 1 within ~5 s as new workers popped jobs. 5 desired was held by the HPA's 60 s scale-down stabilization.
Desired-time varies with poll/HPA-sync alignment (2.5–15.0 s); runs 1 and 4 waited a full HPA sync (~15 s). Ready adds ~11–13 s of pod start + readiness probe. At 250 m the node fits only 3 workers.

> `SLOW_DELAY_MS` env var controls `/slow` delay (default 200 ms).
> `FIB_N` env var controls `/cpu-heavy` computation depth (default 35).
