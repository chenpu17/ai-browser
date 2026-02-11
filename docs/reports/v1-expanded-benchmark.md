# v1 Expanded Readability Benchmark

- GeneratedAt: 2026-02-11T09:15:49.431Z
- Duration(ms): 3872
- TotalScenarios: 6
- Passed: 6
- PassRate: 100.0%
- DeltaCoverageRate: 100.0%
- AdaptiveCoverageRate: 100.0%
- SchemaGuidanceCoverageRate: 100.0%

## Scenario Results

| Scenario | Success | Notes |
|---|---:|---|
| schema_repair_guidance | Y | missing=2, type=1 |
| adaptive_task_polling | Y | status=running, detail=brief |
| delta_task_run | Y | first=initial snapshot; second=no significant change |
| delta_console_logs | Y | second delta: no significant change |
| run_list_pagination | Y | hasMore=true, cursor={"offset":1,"limit":1} |
| partial_failure_mix | Y | status=partial_success |
