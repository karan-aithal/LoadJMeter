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

# Fleet saturation (inconclusive flag)
rate(process_cpu_seconds_total[1m]) > 0.8
```

## Baselines (expected under no load, single node)

| Endpoint     | Typical p50 | Typical p95 |
|--------------|-------------|-------------|
| `/fast`      | ~2 ms       | ~5 ms       |
| `/slow`      | ~200 ms     | ~210 ms     |
| `/cpu-heavy` | ~5 ms       | ~10 ms      |

> `SLOW_DELAY_MS` env var controls `/slow` delay (default 200 ms).
> `FIB_N` env var controls `/cpu-heavy` computation depth (default 35).
