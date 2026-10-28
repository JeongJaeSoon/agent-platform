# SDK 샘플 실행 설정

다음 값은 서버 설정이 아니라 `examples/sdk-approver/src/session-close.ts` CLI의 선택 설정이다. 전체 준비와 실행 방법은 [샘플 README](../../examples/sdk-approver/README.md)에 있다.

| 환경 변수 | 동작 |
| --- | --- |
| `WERFT_AGENT_RELEASE_ID` | 에이전트 key로 실행할 배포 ID. 설정하면 세션 생성에 `agent_release_id`를 보내며 profile·repository 설정은 사용하지 않는다. 생략하면 기존 사용자 key 예제의 profile·repository 경로를 사용한다. |
| `WERFT_APPROVER_API_KEY` | 세션을 읽고 승인할 별도 사용자 key. `sessions:read`와 `sessions:approve` 및 세션 접근 권한이 필요하다. 생략하면 기본 SDK 클라이언트로 답한다. 에이전트 key에는 승인 권한을 줄 수 없으므로 에이전트 경로에서는 별도 승인자가 필요하다. |

샘플은 FAKE 모델 전용이다. API key를 소스나 로그에 넣지 않고 실행 환경으로 전달한다.
