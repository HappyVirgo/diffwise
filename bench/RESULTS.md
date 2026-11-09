# diffwise benchmark results

Measured 2026-11-09 on 12th Gen Intel(R) Core(TM) i7-12700 (16 logical cores), Windows_NT 10.0.26300, Node v24.14.0.
Command: `npm run bench`. Reviewer: offline `HeuristicReviewer` (no LLM calls). All fixtures are synthetic.

Matching is exact on (file, new-file line, rule id). Precision is n/a when a rule made no predictions.

## Dev split (fixtures used while writing the rules)

25 fixtures (5 clean).

| Rule | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| `aws-access-key` | 1 | 0 | 0 | 100.0% | 100.0% |
| `private-key` | 1 | 0 | 0 | 100.0% | 100.0% |
| `hardcoded-secret` | 3 | 0 | 0 | 100.0% | 100.0% |
| `sql-concat` | 4 | 0 | 0 | 100.0% | 100.0% |
| `eval-usage` | 3 | 0 | 0 | 100.0% | 100.0% |
| `debugger-statement` | 2 | 0 | 0 | 100.0% | 100.0% |
| `focused-test` | 2 | 0 | 0 | 100.0% | 100.0% |
| `empty-catch` | 4 | 0 | 0 | 100.0% | 100.0% |
| `skipped-test` | 3 | 0 | 0 | 100.0% | 100.0% |
| `debug-output` | 4 | 0 | 0 | 100.0% | 100.0% |
| `todo-comment` | 2 | 0 | 0 | 100.0% | 100.0% |
| `long-function` | 2 | 0 | 0 | 100.0% | 100.0% |
| `long-line` | 1 | 0 | 0 | 100.0% | 100.0% |
| **overall (micro)** | **32** | **0** | **0** | **100.0%** | **100.0%** |

## Held-out split (written separately; never used to tune rules)

10 fixtures (3 clean).

| Rule | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| `aws-access-key` | 1 | 0 | 0 | 100.0% | 100.0% |
| `private-key` | 1 | 0 | 0 | 100.0% | 100.0% |
| `hardcoded-secret` | 3 | 0 | 0 | 100.0% | 100.0% |
| `sql-concat` | 4 | 0 | 0 | 100.0% | 100.0% |
| `eval-usage` | 3 | 0 | 0 | 100.0% | 100.0% |
| `debugger-statement` | 2 | 0 | 0 | 100.0% | 100.0% |
| `focused-test` | 2 | 0 | 0 | 100.0% | 100.0% |
| `empty-catch` | 3 | 0 | 0 | 100.0% | 100.0% |
| `skipped-test` | 4 | 0 | 0 | 100.0% | 100.0% |
| `debug-output` | 2 | 0 | 0 | 100.0% | 100.0% |
| `todo-comment` | 3 | 0 | 0 | 100.0% | 100.0% |
| `long-function` | 1 | 0 | 0 | 100.0% | 100.0% |
| `long-line` | 1 | 0 | 0 | 100.0% | 100.0% |
| **overall (micro)** | **30** | **0** | **0** | **100.0%** | **100.0%** |

## Combined

| Rule | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| `aws-access-key` | 2 | 0 | 0 | 100.0% | 100.0% |
| `private-key` | 2 | 0 | 0 | 100.0% | 100.0% |
| `hardcoded-secret` | 6 | 0 | 0 | 100.0% | 100.0% |
| `sql-concat` | 8 | 0 | 0 | 100.0% | 100.0% |
| `eval-usage` | 6 | 0 | 0 | 100.0% | 100.0% |
| `debugger-statement` | 4 | 0 | 0 | 100.0% | 100.0% |
| `focused-test` | 4 | 0 | 0 | 100.0% | 100.0% |
| `empty-catch` | 7 | 0 | 0 | 100.0% | 100.0% |
| `skipped-test` | 7 | 0 | 0 | 100.0% | 100.0% |
| `debug-output` | 6 | 0 | 0 | 100.0% | 100.0% |
| `todo-comment` | 5 | 0 | 0 | 100.0% | 100.0% |
| `long-function` | 3 | 0 | 0 | 100.0% | 100.0% |
| `long-line` | 2 | 0 | 0 | 100.0% | 100.0% |
| **overall (micro)** | **62** | **0** | **0** | **100.0%** | **100.0%** |

## Parser / chunker throughput

Input: generated diff, 2,000 files, 528,050 lines, 25.67 MB; 1488 review units at a 6,000-token budget.

| Stage | Time | Lines/sec | MB/s |
| --- | ---: | ---: | ---: |
| parse (median of 7) | 84 ms | 6,269,464 | 304.8 |
| parse + filter + chunk (median of 7) | 166 ms | 3,190,355 | 155.1 |
| full heuristic review (single run) | 710 ms | 744,187 | 36.2 |
