# @werft-ai/ui

웹 콘솔(I1)·받은편지함(I2)·연결(I3)·기억(I4) 화면이 공유하는 표현 계층이다.

## 경계

이 패키지는 **서버가 준 상태를 그리는 일만 한다**.

- fetch·권한 판정·상태 전이 정책을 넣지 않는다. URL도 만들지 않는다(`href`는 화면이 준다).
- API 계약 패키지를 모른다. 계약 타입을 받는 조각은 `@werft-ai/react/components`에 있다.
- `react`·`react-dom`은 쓰는 쪽 앱의 것을 쓴다(peerDependencies). 두 벌이 되면 hook이 깨진다.
- 런타임 의존성은 shadcn/ui가 쓰는
  `@radix-ui/react-checkbox`·`@radix-ui/react-dialog`·`@radix-ui/react-radio-group`·`@radix-ui/react-slot`·`@radix-ui/react-tabs`·`class-variance-authority`·`clsx`·`tailwind-merge`,
  아이콘 `lucide-react`뿐이다. 런타임에 import하는 패키지는 devDependencies가 아니라 여기에 둔다.
  예외는 `fonts.css`가 `@import`하는 `pretendard`다. 폰트를 배포물에 어떻게 실을지 정할 때까지 devDependencies에 둔다.
- Radix는 `src/primitives/` 안에서만 import한다. Dialog 구현이 둘이 되지 않게 하려는 것이다.
- `src/package.test.ts`가 이 경계를 검사한다. 새 의존성을 넣으려면 그 테스트를 먼저 고쳐야 한다.
  worker 이미지는 모든 workspace의 dependencies를 설치하므로, 새 의존성은 `bun scripts/third-party-notices.ts`로
  `THIRD_PARTY_NOTICES.md`도 다시 만든다.

## shadcn/ui

`src/primitives/`는 shadcn/ui(new-york, Radix 판, Tailwind 4) 항목을 복사해 들인 것이다. 설정은 `components.json`에 있다.
새 항목을 들일 때는 이 디렉터리에서 `bunx shadcn@<버전> add <이름>`으로 받은 뒤, 이 저장소 규칙에 맞게
import를 상대 경로(`../foundations/cn.ts`)로 바꾸고 `src/primitives/index.ts`로 내보낸다.
upstream과 다른 점은 각 파일 머리 주석에 적었다. 공통으로 `dark:` variant를 쓰지 않는다. 다크는 토큰이 바꾸고,
Tailwind의 `dark:`는 수동 전환(`data-theme`)을 보지 못하기 때문이다.

- **색.** shadcn 의미 이름(`primary`·`border`·`ring`…)은 런타임 변수로 두지 않는다. `theme.css`의 Tailwind 키
  (`--color-primary` 등)가 `--ap-*` 토큰을 바로 가리킨다. 그래서 키트는 접두사 없는 `--primary`·`--border`를 선언하지
  않고, 같은 이름을 쓰는 앱(shadcn을 쓰는 앱 등)의 변수와 부딪치지 않는다. shadcn의 `accent`는 hover용 조용한 바탕이고, 우리 브랜드 색은
  `primary`(= `--ap-color-accent`)다. 상태 색처럼 도메인 전용 색은 `--ap-tone-*`을 직접 쓴다.
- **Tailwind 연결.** `src/foundations/theme.css`가 토큰을 유틸리티에 잇는 유일한 곳이다. 색(`bg-primary`·`bg-sidebar`…),
  글자 크기(`text-control`·`text-description`·`text-title` 등), `font-sans`·`font-mono`, `rounded-control|card`, `shadow-pop`이
  여기서 나온다. 쓰는 쪽 CSS는
  `tailwindcss`·`styles.css`·`theme.css` 순으로 import하고 `@source`로 이 패키지의 `src`를 스캔해야 한다
  (`apps/web/src/styles.css`가 예다). Tailwind 없이 쓰면 primitive는 모양 없이 그려진다.
- **cascade layer.** `tokens.css`와 `styles.css`의 규칙은 모두 `@layer ap` 안에 있다. `tokens.css`가
  `@layer theme, base, components, utilities, ap;`로 순서를 정하므로, 이 파일과 Tailwind 중 무엇을 먼저 import하든 `ap-*`
  규칙은 Tailwind 유틸리티를 이기고 쓰는 쪽 앱의 layer 밖 규칙에는 진다. 쓰는 쪽 앱이 이 파일보다 먼저 layer 순서를
  선언하면 그 순서가 이긴다. 그때도 `ap`는 `utilities` 뒤에 두어야 한다. `ConfirmDialog`는 앞의 성질로 shadcn Dialog 위에서 기존 모양과
  reduced-motion 규칙을 유지한다. 그래서 `ap-*` 클래스를 그리는 컴포넌트(`ConfirmDialog`·`DestructiveActionDialog`·
  `EmptyState`·`ErrorState`·`Skeleton`, 그리고 `@werft-ai/react/components`의 `StatusLabel`·`ReceiptSummary`·`ReceiptLink`)에 `className`으로 넘긴 유틸리티는
  BEM 규칙과 같은 속성이면 적용되지 않는다. 바꾸려면 쓰는 쪽 앱의 layer 밖 CSS로 덮는다. BEM 클래스는 화면을 옮기면서
  (W11·W17) 지운다.
- **box-sizing.** `styles.css`가 키트 요소(`ap-*` 클래스와 `data-slot`)에만 `border-box`를 건다. Tailwind preflight가 없는
  앱에서도 `Input` 높이가 콘솔과 같다.

## 공개 API

`package.json`의 `exports`가 경계다. 여기 없는 경로(`src/primitives/button.tsx` 같은 파일 경로)는 import하지 않는다.

| 진입점 | 내용 |
|---|---|
| `@werft-ai/ui` | 세 층 전부. 지금 import는 대부분 이것이다 |
| `@werft-ai/ui/primitives` | primitives 층만 |
| `@werft-ai/ui/patterns` | patterns 층만 |
| `@werft-ai/ui/styles.css` | 폰트·토큰·`ap-*` 규칙 |
| `@werft-ai/ui/theme.css` | Tailwind v4가 토큰을 유틸리티로 쓰게 잇는 `@theme inline` |
| `@werft-ai/ui/tokens.css` | `--ap-*` 변수만 |

- 층 index에 없는 이름은 내부다. shadcn 파일이 export해도(`badgeVariants`·`DialogPortal` 등) index에 올리지 않았으면 공개 API가 아니다.
  쓰는 곳이 생기면 그때 index에 올린다.
- `"sideEffects": ["*.css"]`: JS 모듈은 import만으로 하는 일이 없어 번들러가 쓰지 않는 것을 버린다. CSS는 import 자체가 일이라 남긴다.
  모듈 최상위에서 무언가를 등록하는 코드를 넣으면 이 선언이 그 모듈을 버리게 하니 넣지 않는다.
- `./test-support/dom`·`./test-support/html`은 이 저장소의 테스트(`apps/*`·`packages/*`)만 쓰는 도우미다. 공개 API가 아니고,
  배포용 package.json에서는 뺀다.
- 패키지는 아직 `private`다. exports가 `src`를 가리켜 워크스페이스는 빌드 없이 소스를 읽는다.

## 토큰

색·간격·타이포·radius·shadow·모션은 `src/foundations/tokens.css` **한 곳**에만 있다. 라이트가 기본이고,
다크는 시스템 설정(`prefers-color-scheme`)과 수동 전환(`:root[data-theme="dark"]`) 양쪽으로 온다.

값은 콘솔 디자인 캔버스 v35 규칙표를 따른다. 간격은 4·8·12·16·24·32, 글자는 12·13·14·20·24, 반경은 컨트롤 6·카드 8·pill,
그림자는 떠 있는 요소용 `--ap-shadow-pop` 하나다. 바탕은 사이드바 `--ap-color-sidebar`와 메인·카드 `--ap-color-surface` 둘이다. 사이드바 nav 행은 hover에 `bg-sidebar-hover`, 현재 페이지에 `bg-sidebar-accent`를 쓴다.
`--ap-color-canvas`는 `--ap-color-surface`의 옛 이름으로, apps/docs가 읽어서 남겨 두었다. 새 코드에서 쓰지 않는다.

Tailwind 4의 `@theme` 블록 대신 `--ap-` 접두사를 붙인 평범한 커스텀 프로퍼티를 쓴다.
`@theme`는 Tailwind 컴파일러를 거쳐야만 살아남는데, 이 패키지는 Tailwind 없이도 렌더돼야 하기 때문이다.
Tailwind에는 `theme.css`가 이어 붙인다(`--color-surface: var(--ap-color-surface)` 식). 접두사가 없으면
`--color-surface: var(--color-surface)`가 되어 순환한다. 접두사는 그것을 막는다.

## 화면 구성 원칙

화면은 정보를 위에서 아래로 한 줄씩 쌓아 만들지 않는다. 값은 위 v35 규칙표를 따른다.

- 같은 대상에 대한 정보는 한 덩어리로 묶는다. 제목·개수·링크·카드를 각각 한 줄씩 쌓지 않는다.
- 개수·상태는 제목 옆 배지로, 대상 이름·기한은 카드 첫 줄 한 줄로 둔다.
- 짧은 항목이 여러 개면 가로로 놓는다(한 줄 메타, 2~3열 그리드, 오른쪽 정렬 버튼). 세로로 나열하는 것은 순서에 의미가 있을 때뿐이다.
- 같은 정보를 한 화면에 두 번 보이지 않는다.
- 버튼은 내용 폭이고 높이는 `--ap-control-height`(32px)다. 폭을 채우는 버튼은 390px 폭 화면의 주 동작에만 쓴다.
- 섹션 사이는 `--ap-space-section`(32px), 같은 섹션 안 블록 사이는 `--ap-space-block`(16px)이다. 한 섹션 안에 블록이 셋을 넘으면 묶을 수 있는지 먼저 본다.
- PR마다 1440px 스크린샷에서 위에서 아래로 나열만 된 곳이 있는지 보고, PR의 검증 sticky comment에 적는다.

예를 들어 제목, "N건" 줄, 대상 ID 줄, 반폭 카드, 표를 차례로 쌓고 같은 대상을 표에 또 보이는 영역은 첫째·둘째·넷째 원칙을 어긴다.
개수는 제목 옆 배지로, ID는 카드 첫 줄로 옮기고, 표에서는 그 대상을 뺀다.

## 들어 있는 것

`src`는 아는 것에 따라 층으로 나뉜다. 층마다 `index.ts`가 있고, 루트 `src/index.ts`가 층 index를 다시 내보낸다.
층 안의 파일끼리는 index를 거치지 않고 파일 경로로 import한다.

| 층 · 디렉터리 | 아는 것 | 들어 있는 것 |
|---|---|---|
| foundations · `src/foundations/` | 없음 | `tokens.css`·`styles.css`·`theme.css`·`fonts.css`(+`fonts/`), `cn`, `useReducedMotion`, `formatTimestamp` |
| primitives · `src/primitives/` | foundations | shadcn 항목 `Button`·`Badge`·`Card*`·`Input`·`Textarea`·`NativeSelect*`·`Checkbox`·`RadioGroup*`·`Tabs*`·`Dialog*`·`Field*`, 그리고 `Skeleton`. 도메인을 모른다. 의미 있는 상태는 `Badge`가 아니라 `StatusLabel`로 |
| patterns · `src/patterns/` | primitives | `ConfirmDialog`·`DestructiveActionDialog`(결과 설명이 필수이고, 파괴적 동작은 이름을 입력해야 열린다), `EmptyState`, `ErrorState`(제목·할 일·원문·재시도·증거 링크. 할 일 문구는 쓰는 쪽이 준다), 페이지 머리 `PageHeader`(h1 + 설명 + 동작), `Stepper`, 상세 화면 두 칸 배치 `useDetailLayout` |

계약 타입을 받는 도메인 조각은 `packages/react/src/components`(`@werft-ai/react/components`)에 있다: `StatusLabel`(admission·turn·receipt·execution **네 축**을 따로 그린다), `ReceiptSummary`·`ReceiptLink`(`unknown`은 성공으로 그리지 않는다), `ApiErrorState`(`error.code`별 "할 일"을 채운 `ErrorState`), `Session*`·`Timeline`·`Message`·`Composer`·`ApprovalCard`·`QuestionCard`·`StageIndicator`.

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
렌더로 관측할 수 없다. 둘 다 `src/foundations/styles.test.ts`가 스타일시트의 성질로 검사한다.

## 눈으로 보기

```bash
bun run --cwd packages/ui demo   # http://localhost:5173/demo.html
```

shadcn primitive가 Tailwind를 거쳐야 그려지므로 데모는 apps/web과 같은 Vite + `@tailwindcss/vite`로 띄운다.

`?theme=dark`·`?theme=light`로 테마를, `?dialog=confirm`·`?dialog=destructive`로 다이얼로그를 연다.
스타일시트 검사가 못 보는 것(실제 폭에서의 넘침, 대비, 모션)은 여기서 본다 —
실제로 이 미리보기가 360px에서 다이얼로그가 18px 넘치던 `box-sizing` 문제를 잡았다.
