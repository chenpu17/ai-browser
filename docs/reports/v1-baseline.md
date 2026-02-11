# v1 Baseline Report

- GeneratedAt: 2026-02-11T09:16:40.486Z
- Total: 10
- SuccessCount: 10
- SuccessRate: 100.0%
- AvgTTD(ms): 1058
- NoHumanRate: 100.0%
- Duration(ms): 14303

## AI Readability Metrics

- ToolResponses: 15
- AiFieldCoverageRate: 100.0%
- FollowUpActionAttempts: 5
- InvalidToolCallRate: 0.0%
- FollowUpActionSuccessRate: 100.0%

## Scenario Results

| Scenario | Success | TTD(ms) | Error |
|---|---:|---:|---|
| batch_article_1 | Y | 1058 |  |
| batch_form_1 | Y | 1059 |  |
| batch_select_1 | Y | 1063 |  |
| batch_long_1 | Y | 1067 |  |
| compare_article_form | Y | 1047 |  |
| compare_form_select | Y | 1057 |  |
| batch_2_urls | Y | 1061 |  |
| batch_3_urls | Y | 1061 |  |
| compare_article_long | Y | 1053 |  |
| batch_login_page | Y | 1054 |  |

## AI Field Coverage

| Tool | Covered | MissingFields |
|---|---:|---|
| create_session | Y | - |
| navigate | Y | - |
| get_page_info | Y | - |
| get_page_content | Y | - |
| list_tabs | Y | - |
| execute_javascript | Y | - |
| get_console_logs | Y | - |
| get_network_logs | Y | - |
| run_task_template | Y | - |
| run_task_template | Y | - |
| get_task_run | Y | - |
| get_artifact | Y | - |
| list_task_runs | Y | - |
| get_runtime_profile | Y | - |
| close_session | Y | - |

## Follow-up Action Attempts

| SourceTool | ActionTool | Success | InvalidCall | ErrorCode |
|---|---|---:|---:|---|
| get_console_logs | get_console_logs | Y | N | - |
| get_network_logs | get_network_logs | Y | N | - |
| run_task_template | get_task_run | Y | N | - |
| run_task_template | get_task_run | Y | N | - |
| get_task_run | get_artifact | Y | N | - |
