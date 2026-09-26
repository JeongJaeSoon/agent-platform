# Soak 운영

## P-2 보완 측정

RC4 24시간 soak의 최종 P-2가 실패했을 때만, 기존 stack과 10-session steady workload를 그대로 둔 채 보완 측정을 시작한다. 다른 Docker 작업을 함께 실행하지 않고, `rc.json`에 기록된 제품 SHA와 이미지 digest가 현재 stack의 것과 같은지 먼저 확인한다.

```bash
source "${SOAK_STATE:-${TMPDIR:-/tmp}/soak135-state}/vars.sh"
run_dir="$SOAK_STATE/rc-40864ef"
bun scripts/soak/p2-phase.ts "$run_dir/p2-phase" "$run_dir/rc.json"
```

스크립트는 `rc.json`의 제품 SHA·이미지 ID와 현재 고정 tag를 대조하고 비종료 세션이 정확히 10개인지 확인한 뒤, 즉시 `p2-phase.json`에 전체 계획표를 기록하고 15분 이상 warmup한다. 첫 표본 직전에도 10-session workload를 다시 확인한다. 이후 UTC 5분 경계에 맞춘 연속 24개 cycle에서 매분 한 번씩 총 120개의 `POST /v1/sessions` 요청을 보낸다. 각 요청은 재시도하거나 다른 표본으로 대체하지 않으며, 실제 전송 시각이 예약된 5초 창을 벗어나거나 201/202가 아니거나 표본·bucket 수가 맞지 않거나 nearest-rank p95가 500ms를 넘으면 `INVALID`다. 최종 JSON에는 계획표, 전체 표본, 60개 bucket별 개수, p95, 판정, 500ms 고정 slot의 진단 전용 host probe가 들어가며 `p2-phase.md`가 같은 내용을 요약한다.

**P-2 판정 및 보완 측정 규칙 — 2026-09-27 결정**

RC4 24시간 soak의 P-2는 실행 개시 시점의 규칙을 그대로 적용한다. 측정 창 안에서 전송되어 201 또는 202로 수락된 모든 `POST /v1/sessions` 표본을 포함하고, nearest-rank p95가 500ms 이하일 때만 통과한다. P-2에는 host stall, VM stall 또는 sub-1s host hiccup에 따른 표본 제외를 적용하지 않으며, 개별 표본을 삭제하거나 재분류하지 않는다.

실행 종료 전의 p95는 중간 관측값일 뿐 최종 판정이 아니다. 24시간 실행 종료 및 원본 artifact 확정 후 동일한 판정 코드로 산출한 값만 RC4 P-2 결과로 기록한다.

최종 P-2가 통과하면 그 결과를 채택한다. 최종 P-2가 실패하면 24시간 soak의 P-2는 `FAIL`로 보존하고 알파 판정을 `HOLD — P-2 보완 측정 대기`로 둔다. 원래 규칙으로 통과한 다른 기준은 W-1과 R-1을 포함한 실행 무결성이 확인되는 한 재사용한다.

HOLD 해제에는 동일한 RC4 제품 SHA `40864efa`, 동일한 제품 이미지 digest, 동일한 Docker Desktop 호스트와 10-session steady workload에서 수행한 독립 P-2 보완 측정이 필요하다. 보완 측정은 15분 warmup 뒤 120개의 create 요청을 측정하며, UTC wall-clock modulo 300초의 60개 5초 bucket 각각에 정확히 2개씩 배치한다. 각 요청은 기존 soak와 동일한 요청 형태 및 loopback 경로를 사용한다.

보완 측정은 120개 모두가 예약된 bucket에서 전송되고 201/202로 수락되며, 누락·재시도·대체 표본·동시 local Docker 작업이 없고, 동일한 nearest-rank 계산의 p95가 500ms 이하일 때만 `PASS`이다. `n=120`에서 이는 정렬된 114번째 표본이 500ms 이하인 것과 같다. Host probe 자료는 진단용으로 보존하되 보완 측정에서도 표본 제외에는 사용하지 않는다.

유효한 보완 측정이 통과하면 알파 판정을 `PASS (P-2 보완 측정)`으로 해제하되, RC4 24시간 soak의 P-2 실패와 보완 측정 결과를 모두 병기한다. 유효한 보완 측정이 실패하면 알파는 `FAIL`이다. phase coverage 누락, artifact 누락 또는 동시 호스트 작업으로 측정이 무효이면 알파는 `HOLD`를 유지하며, 실패 표본만 다시 측정하지 않는다.
