# 2026-11-06 CI 최적화 측정

측정 창은 2026-10-29 18:00 UTC 이상, 2026-11-05 18:00 UTC 미만의 168시간이다. workflow run 수는 전수 집계(3,421건), job·시간은 각 workflow의 창 안 최신 성공 실행 최대 3건을 표본으로 삼았다. Forbidden terms는 2건, CI image mirror는 창 안 실행이 2건이다. 취소·실패 실행의 runner 시간을 합산한 주간 사용량은 아니며, 최근 성공 표본이 한 시점의 계정 부하에 치우치는 한계가 있다.

`timing` API의 billable은 모든 표본에서 0이다. 공개 저장소의 무료 job이므로 청구 절감으로 해석하지 않는다. runner 분은 건너뛰지 않은 job의 `(completed_at - started_at) / 60` 합계, 큐 분은 `max(0, started_at - created_at) / 60`이다. 집계 job의 created_at은 선행 job 종료 뒤이므로 이 큐 수치에 의존성 대기는 포함하지 않는다. run elapsed는 timing API의 `run_duration_ms`이다.

| workflow | 7일 run 수 | 표본 수 | run당 전체/실행 job 중앙값 | runner 분 중앙값 | job 큐 분 p50 / p95 | billable 분 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CI | 1240 | 3 | 28 / 26 | 92.07 | 15.10 / 27.25 | 0 |
| Images | 1245 | 3 | 21 / 7 | 19.15 | 4.40 / 10.72 | 0 |
| D2 gate | 85 | 3 | 2 / 1 | 8.55 | 0.72 / 1.87 | 0 |
| sdk-release | 360 | 3 | 4 / 1 | 1.37 | 7.18 / 13.02 | 0 |
| main push run (정기 감시) | 14 | 3 | 1 / 1 | 5.28 | 0.03 / 0.72 | 0 |
| ui-release | 74 | 3 | 2 / 1 | 1.03 | 1.03 / 1.30 | 0 |
| Forbidden terms | 401 | 2 | 1 / 1 | 0.43 | 1.65 / 4.62 | 0 |
| CI image mirror | 2 | 2 | 11 / 11 | 4.47 | 0.07 / 3.02 | 0 |

표본 run:

- CI: [42073017680](https://github.com/JeongJaeSoon/werft/actions/runs/42073017680) — 전체 28, 실행 26 job, runner 92.07분, run elapsed 47.87분
- CI: [42072600553](https://github.com/JeongJaeSoon/werft/actions/runs/42072600553) — 전체 28, 실행 26 job, runner 89.95분, run elapsed 43.68분
- CI: [42072555391](https://github.com/JeongJaeSoon/werft/actions/runs/42072555391) — 전체 28, 실행 26 job, runner 93.18분, run elapsed 41.77분
- Images: [42078084146](https://github.com/JeongJaeSoon/werft/actions/runs/42078084146) — 전체 21, 실행 7 job, runner 19.15분, run elapsed 12.57분
- Images: [42077171129](https://github.com/JeongJaeSoon/werft/actions/runs/42077171129) — 전체 21, 실행 7 job, runner 23.45분, run elapsed 20.93분
- Images: [42076817449](https://github.com/JeongJaeSoon/werft/actions/runs/42076817449) — 전체 21, 실행 7 job, runner 16.00분, run elapsed 17.07분
- D2 gate: [42047578375](https://github.com/JeongJaeSoon/werft/actions/runs/42047578375) — 전체 2, 실행 1 job, runner 9.45분, run elapsed 10.20분
- D2 gate: [42037065731](https://github.com/JeongJaeSoon/werft/actions/runs/42037065731) — 전체 2, 실행 1 job, runner 8.48분, run elapsed 8.55분
- D2 gate: [42029901304](https://github.com/JeongJaeSoon/werft/actions/runs/42029901304) — 전체 2, 실행 1 job, runner 8.55분, run elapsed 11.82분
- sdk-release: [42078150233](https://github.com/JeongJaeSoon/werft/actions/runs/42078150233) — 전체 4, 실행 1 job, runner 1.37분, run elapsed 8.57분
- sdk-release: [42078084278](https://github.com/JeongJaeSoon/werft/actions/runs/42078084278) — 전체 4, 실행 1 job, runner 1.47분, run elapsed 5.42분
- sdk-release: [42072600556](https://github.com/JeongJaeSoon/werft/actions/runs/42072600556) — 전체 4, 실행 1 job, runner 1.28분, run elapsed 14.33분
- main push run: [41623783452](https://github.com/JeongJaeSoon/werft/actions/runs/41623783452) — 전체 1, 실행 1 job, runner 6.30분, run elapsed 6.35분
- main push run: [41436383771](https://github.com/JeongJaeSoon/werft/actions/runs/41436383771) — 전체 1, 실행 1 job, runner 5.28분, run elapsed 6.02분
- main push run: [41343241645](https://github.com/JeongJaeSoon/werft/actions/runs/41343241645) — 전체 1, 실행 1 job, runner 1.62분, run elapsed 1.68분
- ui-release: [42012550594](https://github.com/JeongJaeSoon/werft/actions/runs/42012550594) — 전체 2, 실행 1 job, runner 1.10분, run elapsed 2.40분
- ui-release: [42006230120](https://github.com/JeongJaeSoon/werft/actions/runs/42006230120) — 전체 2, 실행 1 job, runner 0.85분, run elapsed 1.68분
- ui-release: [42002260169](https://github.com/JeongJaeSoon/werft/actions/runs/42002260169) — 전체 2, 실행 1 job, runner 1.03분, run elapsed 2.10분
- Forbidden terms: [42079829149](https://github.com/JeongJaeSoon/werft/actions/runs/42079829149) — 전체 1, 실행 1 job, runner 0.38분, run elapsed 2.05분
- Forbidden terms: [42079388639](https://github.com/JeongJaeSoon/werft/actions/runs/42079388639) — 전체 1, 실행 1 job, runner 0.47분, run elapsed 5.18분
- CI image mirror: [41938409203](https://github.com/JeongJaeSoon/werft/actions/runs/41938409203) — 전체 11, 실행 11 job, runner 6.73분, run elapsed 4.32분
- CI image mirror: [41767111207](https://github.com/JeongJaeSoon/werft/actions/runs/41767111207) — 전체 11, 실행 11 job, runner 2.22분, run elapsed 0.50분

## 선택한 변경

CI의 lint·라이선스 검사를 typecheck runner에 합친다. 표본 세 건에서 이 두 runner는 각각 합계 50·53·51초를 사용했고, 직접 확인한 run 42072555391의 검사 자체는 lint 4초·라이선스 0초였다. 네 unit 부분과 integration 도메인은 계속 병렬로 돈다. 새 required context는 만들지 않는다. branch protection API가 반환한 `check`, `integration`, `e2e`, `quickstart`, `supply-chain`은 그대로다.

PR concurrency와 Bun 캐시는 이미 적용돼 있어 반복 추가하지 않는다. main push의 run별 concurrency 분리, 수동 `only=check`, `allow_parallel`, Images·release·publish·배포 job은 유지한다. `check (typecheck)`·`check (lint)`·`check (licenses)`는 필수 체크가 아닌 내부 matrix context이며 `check (static)`으로 모인다. 세 검사는 독립 step으로 남아 로그에서 원인을 구분한다.

문서 전용 감지는 quickstart·API 가이드의 실행 검증, 사이트 조립, supply-chain을 함께 판단해야 하므로 별도 PR에서 설계한다. 이 정적 검사 통합 PR에서는 draft의 무거운 job 생략을 적용하지 않는다.

## 재현

다음 읽기 전용 조회로 표를 다시 계산할 수 있다. GitHub의 created 필터 검색은 최대 1,000건이므로 날짜별로 조회하고, 11월 5일은 반일 두 구간으로 나눈 뒤 `created_at`이 위 측정 창 안인 run만 중복 id 없이 센다. 해당 날짜가 502를 반환한 조회는 네트워크 오류가 사라진 뒤 다시 읽었다.

```sh
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs?created=2026-11-04&per_page=100'
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs?created=2026-11-05T00:00:00Z..2026-11-05T11:59:59Z&per_page=100'
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs?created=2026-11-05T12:00:00Z..2026-11-05T23:59:59Z&per_page=100'
gh api --paginate 'repos/JeongJaeSoon/werft/actions/runs/42072555391/jobs?per_page=100'
gh api repos/JeongJaeSoon/werft/actions/runs/42072555391/timing
gh api repos/JeongJaeSoon/werft/branches/main/protection
```

## CI job별 변경 전 표본

위 CI 성공 실행 세 건에서 같은 job 이름을 묶었다. skipped job은 runner·큐 0으로 기록하며, 모든 job의 billable은 timing API에서 0이다.

| job | 표본 수 | runner 초 중앙값 | 큐 분 중앙값 | billable 분 |
| --- | ---: | ---: | ---: | ---: |
| storybook | 3 | 184 | 14.18 | 0 |
| integration (db) | 3 | 587 | 20.08 | 0 |
| helm-chart | 3 | 22 | 14.18 | 0 |
| docs | 3 | 136 | 12.23 | 0 |
| ui-pack | 3 | 53 | 12.68 | 0 |
| demo | 3 | 32 | 14.17 | 0 |
| integration (surface) | 3 | 603 | 14.52 | 0 |
| k8s-smoke | 3 | 436 | 17.82 | 0 |
| check (unit: packages) | 3 | 140 | 15.22 | 0 |
| e2e | 3 | 445 | 20.78 | 0 |
| integration (storage) | 3 | 111 | 18.65 | 0 |
| integration (docker) | 3 | 164 | 16.58 | 0 |
| integration (api) | 3 | 373 | 12.38 | 0 |
| quickstart | 3 | 458 | 19.85 | 0 |
| check (unit: worker, web) | 3 | 281 | 19.63 | 0 |
| integration (worker) | 3 | 246 | 23.32 | 0 |
| check (lint) | 3 | 28 | 14.37 | 0 |
| integration (egress) | 3 | 127 | 17.07 | 0 |
| check (typecheck) | 3 | 160 | 18.77 | 0 |
| check (unit: db) | 3 | 335 | 20.38 | 0 |
| check (unit: other apps, tests) | 3 | 460 | 22.18 | 0 |
| check (licenses) | 3 | 22 | 27.25 | 0 |
| pages | 3 | 18 | 11.03 | 0 |
| integration | 3 | 3 | 5.72 | 0 |
| storybook-pages | 3 | 0 | 0.00 | 0 |
| check | 3 | 3 | 7.60 | 0 |
| workspace-quota | 3 | 112 | 2.38 | 0 |
| agent-sdk-compat | 3 | 0 | 0.00 | 0 |

검증 상태와 변경 후 CI run의 전후 비교는 이 변경을 제출한 PR 본문·검증 기록에 남긴다. 다른 PR이나 과거 main run은 취소·재실행하지 않는다.


