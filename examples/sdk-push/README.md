# push 승인과 PR

`src/push.ts`는 에이전트가 만든 commit을 저장소로 내보내는 흐름을 돈다. 에이전트 key의 세션이 파일 하나를 commit하고(두 Bash 명령은 승인자가 정확히 일치할 때만 허락한다), 에이전트 key가 push를 요청한다. 승인자는 첫 요청을 거부하고(다시 승인하면 409 `PUSH_REQUEST_DECIDED`), 새 요청의 고정된 commit을 승인한다. push는 worker가 아니라 플랫폼이 승인 몇 초 뒤에 한다. 샘플은 `waitForPushRequest`로 결과를 기다려 push receipt를 읽고, push된 브랜치로 PR을 열고 코멘트를 단다. 공통 준비는 [examples/README.md](../README.md)에 있다.

## key와 실행

| 환경 변수 | 값 |
| --- | --- |
| `WERFT_API_KEY` | 에이전트 key(`sessions:read`, `sessions:write`, `sessions:control`) |
| `WERFT_AGENT_RELEASE_ID` | 그 에이전트 릴리스의 `sha256:…` ID. 비우면 `WERFT_PROFILE_ID`·`WERFT_REPOSITORY_ID`(기본 `claude-coding-local`·`sample-app`) |
| `WERFT_APPROVER_API_KEY` | 같은 workspace의 개인 key(`sessions:read`, `sessions:approve`). 생략하면 `WERFT_API_KEY`로 답하고 결정하므로 그 key에 승인 권한이 있어야 한다 |

```sh
bun examples/sdk-push/src/push.ts
```

## 실행 결과

로컬 FAKE 스택의 `sample-app`(Gitea)은 카탈로그에 push 자격 증명(`auth`)이 없다. 그래서 승인된 push는 `failed`(`no_push_credential`)로 끝나고, PR은 push되지 않은 요청이라 409 `PUSH_NOT_PUSHED`다. 샘플은 이 둘을 이 스택의 예상 결과로 출력하고 종료 코드 0으로 끝난다. 그 밖의 push 실패는 종료 코드 1이다.

```text
session …: created
permission req_…: allow "echo "written by the SDK push sample" > sdk-sample.txt"
permission req_…: allow "git add sdk-sample.txt && git commit -m "Add sdk-sample.txt""
turn 1: completed
push …: requested, 252d75fc3f29 -> agent/… (checkpoint 0)
push …: rejected, 252d75fc3f29 -> agent/… (checkpoint 0), reason "review the diff first"
approve after the reject: 409 PUSH_REQUEST_DECIDED
push …: approved, 252d75fc3f29 -> agent/… (checkpoint 0)
push …: failed, 252d75fc3f29 -> agent/… (checkpoint 0)
push receipt: failed, no_push_credential
push requests: failed, rejected
get …: failed
comment before a pull request: 409 PULL_REQUEST_MISSING no_pull_request
pull request: 409 PUSH_NOT_PUSHED not_pushed
close: receipt succeeded
```

push 자격이 있는 저장소에서는 `push …: pushed`, `push receipt: succeeded, refs/heads/agent/<session-id>`가 나온다. 그 저장소가 GitHub(GitHub App 또는 github.com PAT)면 PR을 열고 `sdk-sample` marker로 코멘트를 달며 그 응답을 출력한다. GitHub이 아닌 저장소(Gitea, GHES PAT)에 push된 브랜치면 PR은 403 `FORBIDDEN`(`no_forge`)이다. 이 두 경로는 가짜 API 테스트로만 확인했다.

- 승인은 요청이 고정한 `git_commit`을 그대로 보낸다. 다른 commit이거나 요청 뒤 세션이 새 checkpoint를 남겼으면 409 `CHECKPOINT_MOVED`다. SDK는 그때 다시 읽어 다시 승인하지 않는다. 검토한 commit만 승인한다.
- 한 세션에 열린 요청은 하나다. 거부한 뒤에 새로 요청한다.
- `openPullRequest`·`commentPullRequest`는 API에 Idempotency-Key가 없어 응답을 잃으면 SDK가 다시 보내지 않는다.

`bun test examples/sdk-push`가 가짜 API로 push된 경우(PR과 코멘트), 자격이 없는 경우, 그 밖의 실패(종료 코드 1)를 확인하고, 권한 답·결정·PR 호출이 승인자 key로 가는지 본다.
