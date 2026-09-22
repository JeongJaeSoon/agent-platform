# @agent-platform/ui

웹 콘솔(I1)·받은편지함(I2)·연결(I3)·기억(I4) 화면이 공유하는 표현 계층이다.
정본은 Obsidian `Project/agent-platform/interface/02 UX 설계` §4(상태 표현)·§6(반응형·접근성)·§8(컴포넌트 인벤토리)·§9(카피 톤).

## 경계

이 패키지는 **서버가 준 상태를 그리는 일만 한다**(Kollegium §12.4).

- fetch·권한 판정·상태 전이 정책을 넣지 않는다. URL도 만들지 않는다(`href`는 화면이 준다).
- 런타임 의존성은 `react`·`react-dom`·`@radix-ui/react-dialog`·`clsx`·`@agent-platform/contracts`(타입 전용)뿐이다.
- `src/package.test.ts`가 이 경계를 검사한다. 새 의존성을 넣으려면 그 테스트를 먼저 고쳐야 한다.

## 토큰

색·간격·타이포·radius·shadow·모션은 `src/tokens.css` **한 곳**에만 있다. 라이트가 기본이고,
다크는 시스템 설정(`prefers-color-scheme`)과 수동 전환(`:root[data-theme="dark"]`) 양쪽으로 온다.

Tailwind 4의 `@theme` 블록 대신 `--ap-` 접두사를 붙인 평범한 커스텀 프로퍼티를 쓴다.
`@theme`는 Tailwind 컴파일러를 거쳐야만 살아남는데, 이 패키지는 Tailwind 없이도 렌더돼야 하기 때문이다.
`apps/web`(94S-158)에서 한 줄로 이어 붙인다:

```css
@import "@agent-platform/ui/styles.css"; /* tokens.css를 함께 가져온다 */
@theme inline {
  --color-canvas: var(--ap-color-canvas);
  --color-surface: var(--ap-color-surface);
  /* ... */
}
```

접두사가 없으면 `--color-canvas: var(--color-canvas)`가 되어 순환한다. 접두사는 그것을 막는다.

## 들어 있는 것

| 컴포넌트 | 하는 일 |
|---|---|
| `StatusLabel` | admission·turn·receipt·execution **네 축**을 각각의 문구·색·아이콘으로. 한 배지로 합치지 않는다(§4.1) |
| `ReceiptSummary` · `ReceiptLink` | 접수(`accepted`)와 확정(`succeeded`)을 구분해서 그린다. `unknown`은 성공으로 그리지 않는다 |
| `EmptyState` · `ErrorState` · `Skeleton` | 빈 화면은 조용하게, 오류는 `error.code`별 "할 일"을 원문보다 먼저 |
| `ConfirmDialog` · `DestructiveActionDialog` | Radix Dialog 위. 결과 설명이 필수이고, 파괴적 동작은 이름을 입력해야 열린다 |

`Timeline`·`Message`·`Composer`·`ApprovalCard`는 I1-3~5에서, `ArtifactPreview`는 I4-9에서 온다.

## 테스트

`bun test packages/ui` — happy-dom + Testing Library. 두 가지 규칙이 있다.

1. **DOM은 파일마다 붙였다 뗀다.** `bun test`는 저장소 전체를 한 프로세스에서 돌리는데,
   happy-dom 등록은 DOM뿐 아니라 `fetch`·`Request`·`setTimeout`까지 바꾼다. 그대로 두면
   뒤따라 도는 API·worker 스위트가 가짜 네트워크를 받는다.
2. **DOM을 건드리는 모듈은 `setupDom()` 뒤에 import한다.** Radix는 import 시점에 DOM 유무를 보고
   `useLayoutEffect`를 no-op으로 바꾼다(그러면 포털이 영영 안 붙는다). Testing Library도 `document`를
   그때 캡처한다. 그래서 `setupDom()`이 Testing Library를 직접 돌려주고, Radix를 쓰는 컴포넌트는
   `await import(...)`로 가져온다. 자세한 사정은 `src/test-support/dom.ts`에 적어 뒀다.

레이아웃 엔진이 없는 환경이라 "360px에서 가로 스크롤 없음"과 "`prefers-reduced-motion` 존중"은
렌더로 관측할 수 없다. 둘 다 `src/styles.test.ts`가 스타일시트의 성질로 검사한다.
