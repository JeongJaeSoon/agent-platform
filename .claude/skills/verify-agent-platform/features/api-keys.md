# API key

운영자는 key CLI로 owner id와 scope를 정해 API key를 발급하고 폐기한다. 호출자는 `Authorization: Bearer <key>`로 `/v1`을 부르고, key가 가진 scope 밖의 동작은 403, 폐기된 key는 401을 받는다.

## Sub-features

- `key-create` `scripts/local.sh key <owner> --scopes …`가 key를 stdout에 한 번, `key_id …`를 stderr에 낸다.
- `key-whoami` `GET /v1`이 `owner_id`를 돌려준다.
- `key-scope-denied` scope 밖의 호출은 403 `This credential does not hold <scope>`.
- `key-revoke` `keys.ts revoke <key_id>` 뒤 같은 key는 401.

## How to get to it (user POV)

- 운영자 터미널: `scripts/local.sh key …`(api 컨테이너 안에서 key CLI를 돈다), 폐기는 `bun run keys revoke <key_id>`.
- 호출자: 아무 HTTP 클라이언트로 `Authorization: Bearer`.

## Driving it with lib.sh

Preconditions:

- `doctor.sh`가 ready.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh
KEY=$(ap_key verify --scopes sessions:read,sessions:write 2>"$VERIFY_RUN/key.err")
KID=$(sed -n 's/.*key_id \([^ ]*\).*/\1/p' "$VERIFY_RUN/key.err" | head -1)
echo "key issued: ${KEY:0:6}… (len ${#KEY}) key_id: $KID"
```

- **발급.** 위 블록 → `key issued: csp_…`와 UUID `key_id`.
- **누구인가.** `ap_get /v1` → `200` `{"status":"ok","owner_id":"verify"}`.
- **scope 밖.** read·write key로 `ap_post "/v1/sessions/<SID>/pause" '{"expected_revision":1,"reason":"verify"}'` → `403` `This credential does not hold sessions:control`. `<SID>`는 [sessions.md](./sessions.md)에서 만든 세션이다(scope 검사가 먼저라 아무 UUID여도 403).
- **폐기.** `ap_revoke "$KID"` → `revoked <key_id> owner=… revoked_at=…`.
- **폐기 후.** `ap_get /v1` → `401` `UNAUTHORIZED`.
- **증거.** `| tee "$EVIDENCE/api-keys.txt"`. key 값은 앞 6자만.

## Gotchas

- `local.sh key`는 env의 project를 따른다. `lib.sh`를 source하지 않은 셸에서 부르면 기본 스택에 발급한다.
- `bun run keys …`(package.json)는 기본 project 고정이라 이 스킬에서는 `ap_revoke`를 쓴다.
- key는 다시 볼 수 없다. 잃으면 새로 발급한다.
- 권한별 개인 key·에이전트 서비스 key는 아직 없다([musterrolle.md](./musterrolle.md) d).
