# 과거 알파 부하 검증 도구와 결과

이 문서는 2026-09-27에 종료한 94S-135 검증의 결과와 남아 있는 도구를 기록한다. 현재 알파 배포 절차나 통과 gate가 아니다. 서버에서 이어서 확인할 항목은 [내부 알파 실서버 배포](alpha-deployment.md)를 따른다.

## 최종 판정

- RC4 24시간 soak(제품 `40864efa`)는 2026-09-27T05:05:02Z LocalStack OOM으로 **무효**다. 24시간 soak PASS 증거로 쓰지 않는다.
- 같은 제품의 interrupt-3h 캠페인은 기준 18개 중 17개를 통과했다. 실패한 P-2는 세션 생성 시각이 5분 위상 한 구간에 몰린 측정 설계 결함이었다.
- 무효화 시점 전 자료에서는 interrupt 뒤 `outcome_unknown` 3건과 engine 정지 지연 1건(P-3/L-1), terminate 수락 p95 577ms(P-5)가 발견됐다. 원인 계측과 수정은 [94S-479](https://linear.app/94soon/issue/94S-479), [94S-480](https://linear.app/94soon/issue/94S-480)으로 분리했다.
- 사용자 결정으로 24시간 soak를 다시 돌리지 않고 내부 알파를 진행한다. 실제 S3, 실제 provider, HTTPS와 장시간 부하는 [94S-303](https://linear.app/94soon/issue/94S-303)의 서버 배포에서 검증한다.

상세 판정과 원본 artifact 위치는 Linear [94S-135](https://linear.app/94soon/issue/94S-135)의 2026-09-27 최종 코멘트가 정본이다.

## 남아 있는 도구

`scripts/soak/rc.sh`, `stack.sh`, `campaign.sh`, `scripts/soak/p2-phase.ts`와 `tests/soak/`는 과거 판정을 재현하고 회귀를 조사하기 위해 남긴다. 이 도구의 존재나 성공을 현재 알파의 24시간 soak 통과로 해석하지 않는다.

P-2 보완 도구는 RC4의 제품 SHA·이미지 digest·10-session workload를 전후로 확인하고, 15분 warmup 뒤 UTC 5분 위상의 60개 5초 bucket마다 2개씩 총 120개 요청을 계획한다. 누락, 예약 창 이탈, 201/202가 아닌 응답, artifact 불완전, 동시 호스트 작업은 재시도하지 않고 측정을 `INVALID`로 만든다. nearest-rank p95의 114번째 표본이 500ms 이하일 때만 P-2가 통과하도록 구현돼 있다. 이 프로토콜은 실행되지 않았으며 최종 알파 판정을 바꾸지 않는다.
