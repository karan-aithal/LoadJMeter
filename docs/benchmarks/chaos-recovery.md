# Chaos recovery: surviving worker failure

What happens to a job when the worker running it is killed or cut off from the control plane, how that was
tested, and what the tests do and do not show. Measured 2026-11-21 on the `feat/job-reaper` branch.

## Summary

35 fault-injection runs (51 jobs) on a single-node OKD (CRC) cluster. Every job reached `completed` and was
recorded as completed exactly once. No job was lost, left in Redis, or dead-lettered, and a worker that had lost
ownership never wrote a result.

| Experiment | Runs | Passed | Retry running, after the fault (median / p95 / max) | Job completed, after the fault (median / p95) |
|---|---|---|---|---|
| Hard pod kill, 1 worker | 10 | 10 | 19.0 s / 22.2 s / 22.2 s | 87.3 s / 90.4 s |
| Network partition, healed while the stale worker is running | 10 | 10 | 23.6 s / 24.7 s / 24.7 s | 121.6 s / 123.3 s |
| Network partition, healed after the stale worker gave up | 5 | 5 | 22.5 s / 24.6 s / 24.6 s | 121.2 s / 122.8 s |
| Hard pod kill, 3 workers, 3 different jobs at once | 6 | 6 | 21.0 s / 21.6 s / 21.6 s | 89.2 s / 105.5 s |
| Hard pod kill, 2 workers at a 400m CPU request | 4 | 4 | 20.8 s / 21.4 s / 21.4 s | 75.3 s / 134.7 s (a 30 s or a 90 s job was killed) |

"After the fault" is measured from just before the pod is deleted (kill) or just before the isolation is applied
(partition). With n = 10 or fewer, the p95 is the largest observation. Do not read it as a tail estimate.

What this supports saying: after a hard kill or a partition of a worker, the job was running again on another
worker within about 17-25 s and completed once, across 35 runs on two worker counts and three scenarios.

What it does not support: any claim about other failure types (Redis, Postgres, control-api, node loss),
production-scale load, or a recovery time under other settings. See [Limitations](#limitations).

## System under test

- **Queue:** Redis lists `jobs:pending`, `jobs:processing` (a worker holds its job here) and `jobs:dead-letter`.
  Workers pop with `BRPOPLPUSH`.
- **control-api:** owns job state in PostgreSQL (`test_runs`) and runs the **reaper** in-process. Single replica.
- **Workers:** run k6 against the SUT, send a heartbeat every 5 s, report status to control-api.
- **Reaper settings:** a run is stale after 20 s without a heartbeat; scan every 5 s; `MAX_RETRIES=3`.
- **Environment:** CRC single-node OKD v4.22, 3.8 CPU. Worker CPU request 250m (limit 1) unless stated. The KEDA
  ScaledObject (1-10 workers) stayed installed; the multi-worker runs pause it at the worker count they need.
- **Builds:** images built from a clean tree at `160b3ac`. Each result records the git SHA, uncommitted file count,
  image digests, worker resources and the reaper settings. The 4 config B runs record `03f9ce8`, a later commit that
  changed only test scripts; the image digests are the same.

## How recovery works

1. **Detect.** A running job whose row has no heartbeat for 20 s is stale. A job that was popped but never
   reported `running` (the worker died in between) is stale once it has sat in `jobs:processing` for 20 s.
2. **Claim in the database first.** The reaper updates the row in one statement: still `running` (or stranded),
   silent, and `epoch` below the new value. It bumps `epoch` (a fencing token). If the worker finished or
   heartbeated first, the claim fails and nothing is queued.
3. **Then move the Redis entry atomically** (Lua: remove from processing, push the retry), unless a cancel marker
   exists for the run. Retries are exhausted after 3 attempts and the claim marks the run `failed`, with the entry
   moved to the dead-letter queue.
4. **Fence the old worker.** Every worker write and heartbeat carries its epoch. control-api answers 409 to an older
   epoch and to any write on a finished or cancelled run. A worker that gets 409 cancels k6, discards the result,
   and neither acks nor re-queues. If control-api is unreachable at the end (a partition), the worker does not
   ack either. The entry stays for the reaper.
5. **Crash windows between the two stores are repairable.** A reaper that dies after its claim leaves a bumped
   epoch, which the next pass recognises and finishes. A worker that dies after recording `failed` but before the
   dead-letter move leaves a `failed` row with its payload still in processing, which the reaper dead-letters.
   The worker's own re-queue is DB-first, then an atomic Redis step.

## Method

Each run starts from empty queues and one scripted fault. A run passes only if **all** hold:

- the job finishes `completed` on a worker other than the faulted one;
- exactly one `job completed` log line exists for it across all workers, and exactly one reaper event;
- it is not in the dead-letter queue or left in `jobs:pending`/`jobs:processing`;
- (partition) the stale worker completed nothing, and was either fenced by control-api (early heal) or gave up its
  final write (late heal);
- (multi-worker) every other job also completed once, on the worker it started on, picked once, never reaped.

| Script | Fault |
|---|---|
| `infra/scripts/chaos-kill-worker.sh` | `kubectl delete pod --force --grace-period=0` on the pod whose hostname equals the job's `worker_id`, after confirming the payload is in `jobs:processing` |
| `infra/scripts/chaos-partition-worker.sh` | an egress NetworkPolicy cuts one worker off from control-api (it keeps k6 and Redis). The pod is relabelled out of the worker ReplicaSet so a replacement starts. Healed while k6 is still running (`HEAL_MODE=during`) or only after the stale worker has finished and given up (`HEAL_MODE=after`) |
| `infra/scripts/chaos-kill-multi.sh`, `chaos-matrix.sh` | as the kill, with 2-3 workers each running a different job, the killed worker rotating over the jobs |

Timing is client-side polling every 0.5 s, so each figure is good to about +/-1 s. Results are in
`docs/benchmarks/results/*.json` with a `.log` of reaper, worker and event lines beside each.

## Results

### Pod kill (1 worker, `fast`, 2 VUs, 45 s)

10 of 10 passed. Retry running 16.9-22.2 s after the kill (median 19.0). Values fall into two rough groups, around
17 s and 22 s. That fits the settings: the reaper acts on the first scan after the last heartbeat plus 20 s, the kill
lands somewhere inside a 5 s heartbeat interval, and scans are 5 s apart. Completion at about 87-90 s includes the
full 45 s rerun, because a retried job starts over.

### Network partition, healed while the stale worker is running (75 s job)

10 of 10 passed. The replacement started 22.5-24.7 s after isolation. After the heal, the stale worker's next
heartbeat got 409 within 0.1-1.3 s (median 0.7 s), it cancelled k6 and discarded the result. In every run control-api
logged exactly one `fenced_write`, the stale worker logged two fencing events, and it completed nothing.

### Network partition, healed after the stale worker gave up

5 of 5 passed. The stale worker finished k6 while still partitioned, its final status write failed after 3 tries,
and it left the Redis entry alone (`completion not recorded, job left in processing` in all 5). The partition was healed
only after that (about 125 s in), and the worker stayed inert. This covers the case where the heal comes after the
stale worker has finished.

### Multi-worker kill matrix

Config A: 3 workers at 250m, jobs `fast` 2 VUs 45 s, `slow` 5 VUs 60 s, `cpu-heavy` 10 VUs 45 s running together.
Config B: 2 workers at 400m, jobs `fast` 10 VUs 90 s and `slow` 2 VUs 30 s. The killed worker rotated over the jobs.

| Config | Runs | Passed | Jobs | Jobs OK | Other (non-killed) jobs OK | Retry running (median / max) |
|---|---|---|---|---|---|---|
| A: 3 workers, 250m | 6 | 6 | 18 | 18 | 12 of 12 | 21.0 s / 21.6 s |
| B: 2 workers, 400m | 4 | 4 | 8 | 8 | 4 of 4 | 20.8 s / 21.4 s |

By killed job: `fast` 18.1-21.6 s (4 runs), `slow` 20.8-21.6 s (4), `cpu-heavy` 21.0 s (2). The 16 jobs that were not
killed were never reaped, including the ones running 10-VU k6 on a 250m request, so these runs showed no false
reaping under CPU contention. 2 workers at 500m did not fit the node, so config B uses 400m
(about 1.0 CPU is left for workers once the platform's roughly 2.8 CPU is accounted for).

## Defects the testing exposed

| Defect | How found | Fix |
|---|---|---|
| Reaper requeued in Redis before writing `pending` to the DB, so a replacement's `running` could be overwritten | code review of the first chaos script | DB-first claim (`a328318`, then `e6371ed`) |
| A stale worker could overwrite, ack or re-queue after losing ownership; cancelling did not stop a running job | design review; the earlier pod-kill runs could not show it | fencing epoch, 409, DB-before-Redis (`e6371ed`) |
| A job popped by a worker that died before reporting `running` stayed in `jobs:processing` forever | benchmark run: the next run's job was taken by a dying orphan pod | stranded-pop recovery (`57116c4`) |
| A crash between recording `failed` and the dead-letter push lost the dead-letter copy | limitations review | atomic dead-letter + reaper completes it (`f1088b4`, `a24c6f9`) |
| A cancel starting between the reaper's claim and its push could leave a queued entry | limitations review | Redis cancel marker checked atomically (`f1088b4`, `a24c6f9`) |

Several test-harness faults were also found and fixed (`grep -q` under `pipefail`, a force-deleted orphan pod still
popping jobs, result files counted as uncommitted changes). Run results from before each fix were re-run, not reused.

## Limitations

- **Delivery is at-least-once.** A retried job starts over, so completion time includes a full rerun and the SUT
  sees the load twice. During a partition the stale worker kept sending load for about 25-30 s until it was
  fenced. "Exactly once" here means exactly one recorded completion.
- **One node, one of everything.** No Redis, PostgreSQL, control-api or node failure was injected. The reaper runs
  inside the single control-api replica, so losing control-api stops recovery until it returns.
- **Partition is one-sided.** Only worker-to-control-api traffic was cut. A worker cut off from Redis, or from
  both, was not tested.
- **Crash windows are not injected live.** A reaper dying between claim and move, or a worker dying between its DB
  write and its Redis step, are covered by unit tests, a real-PostgreSQL test and real-Redis tests, not by live
  fault injection. The dead-letter path was never exercised live (no job exhausted its retries; dead-letter
  count was 0 in every run).
- **One cancel window remains by design.** A cancel that begins after the retry has been pushed is an ordinary
  cancel of a queued job. The worker refuses to start it, since its `running` write gets 409.
- **Recovery time is set by configuration** (20 s stale, 5 s heartbeat and scan). It was not tuned. Shorter
  thresholds recover faster but risk reaping slow-but-alive workers, which was only checked for the matrix's
  CPU load.
- **Small samples and narrow configurations.** n = 4 to 10 per experiment; worker CPU requests of 250m and 400m; three
  scenarios; 30-90 s jobs. Nothing was run at scale or for long durations.

## Reproduce

```bash
make okd-build && make okd-deploy      # images from a clean tree; see infra/okd/README.md
make okd-chaos-bench                    # 10 pod-kill runs
make okd-partition-bench                # 10 partition runs, healed while the stale worker runs
make okd-partition-late-bench           # 5 partition runs, healed after the stale worker gave up
make okd-chaos-matrix                   # multi-worker matrix (SKIP_A=1 for config B only)
```

Each target prints median/p95 via `infra/scripts/chaos-summary.sh`. Run from a clean tree (the results record the SHA),
with `API_KEY` in `.env`, and with the ScaledObject installed (the matrix pauses it).

## Resume-safe wording

> Built heartbeat-based worker failure recovery for a Redis-backed job queue (atomic claim, fencing tokens, retry
> and dead-letter), and verified it with 35 fault-injection runs (pod kill, network partition, multi-worker): every
> job completed exactly once with none lost, retry running 17-25 s after the fault.
