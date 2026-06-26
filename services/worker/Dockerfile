# syntax=docker/dockerfile:1
# Phase 1: pure k6 runner image.
# Phase 3 will add a Node layer on top for queue-driven orchestration.

FROM grafana/k6:0.51.0

WORKDIR /scripts

# Copy k6 scripts and shared thresholds
COPY scripts/ /scripts/

# Default: run the full mixed scenario.
# Override CMD to target a specific script:
#   docker run loadtest/worker run /scripts/k6/fast-endpoint.js
ENTRYPOINT ["k6", "run"]
CMD ["/scripts/k6/base-scenario.js"]
