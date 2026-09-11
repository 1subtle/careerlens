# Optional end-to-end model monitor

This upstream diagnostic harness runs an isolated resume-tailoring workflow and records structural scores, PDF checks, model-judge results and logs. It is optional and uses real model requests when enabled.

From the repository root:

```bash
cd app/apps/backend
uv sync --frozen --extra dev --extra e2e-monitor
RM_E2E_MONITOR=1 uv run --frozen python -m e2e_monitor sweep --backend-port 18000 --frontend-port 13000
```

Configure a model before running. The monitor creates its own data directory and server processes, and refuses occupied ports. Use `--no-frontend` to omit frontend rendering. Results are written to `artifacts/e2e-monitor/<run-id>/` under the backend directory; inspect the summary and stage outputs to assess failures.

The generated data directory and raw diagnostic logs can contain model context or credentials. Keep them local. The default project tests exercise monitor helpers with synthetic data and mocked model boundaries; they do not enable a real sweep.

To update the comparison baseline after reviewing a run:

```bash
uv run --frozen python -m e2e_monitor update-baseline artifacts/e2e-monitor/<run-id>
```

Review the baseline diff before committing it. For ordinary CareerLens verification, use the root `scripts/smoke.py` workflow and `docs/验证说明.md`.
