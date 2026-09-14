# 94S-91 Agent SDK 호환성 게이트

이 디렉터리는 제품 코드와 분리된 process-level 조사 harness다. 실제 `@anthropic-ai/claude-agent-sdk`가 번들 Claude Code process를 실행하고, 로컬 fake Anthropic Messages API와 HTTP/SSE로 왕복하는 계약을 고정한다. 실제 Anthropic 계정·API key·과금 호출은 사용하지 않는다.

## 고정 후보

| 항목 | 값 |
| --- | --- |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.270` |
| 번들 Claude Code | `2.1.270` |
| 현재 실행 플랫폼 | macOS arm64 |
| Messages endpoint | `POST /v1/messages?beta=true` |
| system prompt | `claude_code` preset + platform append |
| filesystem settings | `settingSources: ["project"]` |

## 실행

```bash
bun install --cwd spikes/94s-91 --frozen-lockfile
bun run --cwd spikes/94s-91 probe:version
bun run --cwd spikes/94s-91 probe:smoke
bun run --cwd spikes/94s-91 check
```

`probe:smoke`와 `test:contract`는 loopback HTTP server를 열 수 있어야 한다. 외부 네트워크와 실제 Claude credential은 필요하지 않다.

## 현재 실측 결과

다음 항목은 실제 SDK와 실제 번들 Claude Code process로 통과했다.

- `CLAUDE.md`, project custom command, project Skill 로딩과 실제 호출
- `claude_code` system preset append
- local plugin namespaced command 실제 호출
- SDK in-process MCP server와 tool 실제 호출
- programmatic subagent 실제 호출과 부모 turn 결과 전달
- `PreToolUse`·`PostToolUse` hook 및 `canUseTool`의 `requestId`·`toolUseID` 전달
- 같은 assistant message의 `AskUserQuestion` 2개가 동시에 callback되고 답변이 각각의 `toolUseID`에 유지됨
- `default`, `acceptEdits`, `plan`, `dontAsk` mode의 실제 실행 결과
- bare `allowedTools: ["Bash"]`가 `canUseTool`을 우회함
- project deny는 `allowedTools`보다 우선하고 project ask는 allow보다 우선함
- headless SDK의 신뢰하지 않은 임시 workspace에서는 project allow rule이 보류되고 host callback으로 fall through함
- `plan` mode라도 host `canUseTool`이 명시적으로 allow하면 Bash가 실행됨. 플랫폼의 plan policy는 callback에서도 fail-closed해야 함
- 첫 CLI process의 완료된 Bash tool을 새 CLI process가 같은 session ID로 resume해도 중복 실행하지 않음
- streaming-input session에서 `interrupt()`가 현재 turn만 중단하고 같은 process의 후속 입력을 처리함

## 아직 게이트를 닫지 못한 항목

- `AbortController`, `SIGTERM`, `SIGKILL` 각각의 PID·terminal subtype·transcript·file change 차이
- 승인 대기 중 abort/kill과 resume 시 callback 및 tool 재실행 여부
- hook의 `defer`와 외부 승인 저장소 적용 여부
- native SDK message를 제품 public SSE event로 투영하는 확정 매핑표
- user/project/local settings, memory, credential의 tenant 격리 전체 행렬
- 실제 LiteLLM proxy + local fake upstream의 streaming, tool payload, beta header, alias, error, timeout, cancel 전달
- Linux amd64 container/CI에서의 동일 version 및 bundled executable 검증
- 별도 승인과 비용이 필요한 paid Claude smoke

이 항목들이 끝나기 전에는 94S-91을 Done으로 전환하거나 94S-18 등 blocked 티켓의 SDK 구현을 시작하지 않는다.
