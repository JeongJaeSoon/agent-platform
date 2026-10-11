# 운영 조회

운영자와 호출자는 스택이 준비됐는지, API 문서와 설치 상한·세션 사용량이 어떤지 읽는다.

## Sub-features

- `readyz` `GET /readyz` → `{"status":"ready","checks":{"database":"ok","schema":"ok","config":"ok"}}`.
- `docs` `GET /docs` → API reference HTML.
- `limits` `GET /v1/limits` → 설치 상한과 사용량.
- `usage` `GET /v1/sessions/{id}/usage` → 세션 비용·대기 입력 수.

## How to get to it (user POV)

- 브라우저나 curl로 `$API/readyz`, `$API/docs`.
- key 호출자: `/v1/limits`, `/v1/sessions/{id}/usage`.

## Driving it with lib.sh

Preconditions:

- `doctor.sh <run id>`가 ready. `/v1/*`에는 `sessions:read` key.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh <run id>
```

- **준비.** `curl -sS "$API/readyz"` → 위 JSON.
- **문서.** `curl -sS -o "$EVIDENCE/docs.html" -w '%{http_code} %{content_type}\n' "$API/docs"` → `200 text/html; charset=utf-8`.
- **상한.** `ap_get /v1/limits` → `200`, `scope: "installation"`, `limits.execution_slot_limit` 등.
- **사용량.** `ap_get "/v1/sessions/$SID/usage"` → `200`.
- **브라우저 확인**이 필요하면 Orca의 `orca tab`으로 `$API/docs`를 연다(작업 전 브라우저 잠금이 있으면 잡고, 끝나면 푼다).

## Gotchas

- `/readyz`는 인증이 없다. `/v1`은 key가 없으면 401.
- `/docs`는 외부 스크립트 없이 열리는 정적 HTML이다. 브라우저 확인은 필수가 아니다.
