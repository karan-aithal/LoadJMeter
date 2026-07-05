# Runbook: SLO Breach

**Symptom:** `SLOErrorRateBreach` or `SLOP95*Breach` alert firing. Test verdict is `FAIL` or `INCONCLUSIVE`.

## Determine verdict first

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/tests?limit=1 \
  | jq '.[0] | {id, status, verdict, error_message}'
```

| Verdict | Meaning | Action |
|---------|---------|--------|
| `FAIL` | SUT SLO breached, fleet not saturated | Investigate SUT |
| `INCONCLUSIVE` | Fleet CPU > 80% during run | Scale workers or reduce VUs |
| `PASS` | All SLOs met | No action needed |

## For FAIL — investigate SUT

### 1 — Check error rate
Grafana → "LoadTest SUT (RED)" → "Errors (%)" panel.

### 2 — Check SUT logs
```bash
kubectl -n loadtest-system logs -l app=sut --tail=50
```

### 3 — Check per-endpoint p95
```promql
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
```

### 4 — Verify SLO thresholds in docs/slo.md

## For INCONCLUSIVE — fleet was bottleneck

### 1 — Confirm saturation
```promql
max(worker_cpu_saturation_ratio)
```
If > 0.8 during run → reduce VUs or add workers.

### 2 — Scale workers and re-run
```bash
kubectl -n loadtest-system scale deployment/worker --replicas=5
```

## Resolution checklist
- [ ] Verdict determined (FAIL vs INCONCLUSIVE)
- [ ] Root cause identified (SUT or fleet)
- [ ] If FAIL: SUT issue remediated
- [ ] If INCONCLUSIVE: fleet scaled, re-run produces PASS or FAIL
