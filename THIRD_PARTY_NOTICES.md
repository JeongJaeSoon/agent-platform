# 제3자 구성요소 고지

배포 이미지(control-host·worker·egress-proxy)에 들어가는 제3자 구성요소와 그 라이선스다. 각 npm 패키지의 라이선스 전문은 이미지 안 `/app/node_modules/<패키지>/`에 패키지와 함께 들어 있다.

이 파일은 `bun scripts/third-party-notices.ts`가 `bun.lock`에서 만든다. 손으로 고치지 않는다. CI의 `check (licenses)`가 `--check`로 최신인지 확인한다.

## 베이스 이미지와 OS 패키지

세 이미지 모두 `oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e`(Dockerfile의 `BUN_IMAGE`) 위에 만든다. 이 베이스는 Debian 13(trixie) slim이다. 빌드할 때 `apt-get upgrade`로 Debian 보안 수정을 올리므로 이미지의 Debian 패키지 버전은 베이스 digest의 것보다 새로울 수 있다.

### Bun 1.3.10 (`/usr/local/bin/bun`)

- **라이선스.** Bun 자체는 MIT다. 함께 링크된 라이브러리와 각각의 라이선스는 https://github.com/oven-sh/bun/blob/bun-v1.3.10/LICENSE.md 에 있다. 이미지에는 Oven이 배포한 실행 파일이 수정 없이 들어 있다.
- **빌드.** oven-sh/bun commit `30e609e08073cf7114bfb278506962a5b19d0677`(`bun --revision`)이다. images.yml이 빌드한 이미지마다 이 값을 확인한다.
- **LGPL-2.1 구성요소.** Bun은 아래 라이브러리를 정적으로 링크한다. LGPL-2.1 전문은 이미지 안 `/usr/share/common-licenses/LGPL-2.1`에 있다.
  - JavaScriptCore·WebCore(WebKit): https://github.com/oven-sh/WebKit/tree/4a6a32c32c11ffb9f5a94c310b10f50130bfe6de
  - TinyCC: https://github.com/oven-sh/tinycc/tree/12882eee073cfe5c7621bcfadf679e1372d4537b
- **대응 소스와 재링크.** 이 실행 파일 전체의 소스는 https://github.com/oven-sh/bun/tree/bun-v1.3.10 이다. 위 라이브러리를 고쳐 Bun을 다시 링크하는 절차는 https://github.com/oven-sh/bun/blob/bun-v1.3.10/CONTRIBUTING.md 의 "Building WebKit locally"다. WebKit을 위 commit으로 받아 `bun run build:local`로 빌드한다. LICENSE.md에 적힌 `make jsc`·`zig build`는 옛 절차다.

### Debian 패키지와 대응 소스

- **라이선스 전문.** 각 패키지의 저작권·라이선스 전문은 이미지 안 `/usr/share/doc/<패키지>/copyright`에 있다. GPL·LGPL 전문은 `/usr/share/common-licenses/`에 있다. images.yml이 빌드한 이미지마다 설치된 모든 패키지에 copyright 파일이 있는지 확인한다.
- **대응 소스.** 이미지마다 `/app/DEBIAN_SOURCES.md`가 설치된 모든 Debian 패키지의 source package 이름과 정확한 버전, 그 소스가 보관된 https://snapshot.debian.org/ 주소를 적는다. GPL·LGPL 패키지도 모두 여기에 들어 있다. 이 목록은 빌드할 때 그 이미지의 dpkg 데이터베이스에서 만든다(`bun scripts/third-party-notices.ts --debian-sources`). images.yml은 빌드한 이미지마다 목록이 실제 설치 상태와 같은지 확인한다. `apt-get upgrade` 때문에 빌드마다 버전이 달라질 수 있어, 목록은 저장소가 아니라 이미지에 둔다.
- **Dockerfile이 추가로 설치하는 Debian 패키지.** control-host는 git(GPL-2.0)·tini(MIT), worker는 ca-certificates(MPL-2.0·GPL-2.0+)·git·tini·xfsprogs(GPL-2.0·LGPL-2.1)다. egress-proxy는 추가 패키지가 없다.

### Claude Code 실행 파일 (worker)

- **권리와 조건.** `@anthropic-ai/claude-agent-sdk@0.3.270`과 그 플랫폼 빌드가 싣는 `claude` 실행 파일은 오픈소스가 아니다. © Anthropic PBC. All rights reserved. 이용 조건은 Anthropic Commercial Terms of Service(https://www.anthropic.com/legal/commercial-terms)와 Claude Code 법률 고지(https://code.claude.com/docs/en/legal-and-compliance)를 따른다.
- **싣는 방식.** Anthropic이 npm에 게시한 실행 파일을 수정하지 않고 그대로 싣는다. musl 빌드만 이미지에서 뺀다.
- **내장 런타임.** 이 실행 파일은 Bun 1.4.3 런타임을 내장한다. 따라서 JavaScriptCore(LGPL-2.1)도 정적으로 링크되어 있다. images.yml이 worker 이미지마다 이 버전을 확인한다.

## 배포 조건이 붙은 구성요소

허용 목록(MIT·Apache-2.0·BSD 계열·ISC 등) 밖의 라이선스다. 각각 스크립트의 `REVIEWED`에 검토 사유가 있다.

- `@anthropic-ai/claude-agent-sdk@0.3.270` (SEE LICENSE IN README.md): Anthropic 독점 소프트웨어다(패키지 LICENSE.md: © Anthropic PBC. All rights reserved). Anthropic Commercial Terms와 Claude Code를 제품에 싣는 조건을 따른다(위 "Claude Code 실행 파일" 절). worker 이미지에만 들어간다.
- `@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.270` (SEE LICENSE IN LICENSE.md): 위 SDK가 싣는 플랫폼별 Claude Code 실행 파일이고, 조건도 같다. 수정하지 않고 그대로 싣는다. musl 빌드는 worker Dockerfile이 지운다.
- `@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.270` (SEE LICENSE IN LICENSE.md): 위 SDK가 싣는 플랫폼별 Claude Code 실행 파일이고, 조건도 같다. 수정하지 않고 그대로 싣는다. musl 빌드는 worker Dockerfile이 지운다.
- `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.270` (SEE LICENSE IN LICENSE.md): 위 SDK가 싣는 플랫폼별 Claude Code 실행 파일이고, 조건도 같다. 수정하지 않고 그대로 싣는다. musl 빌드는 worker Dockerfile이 지운다.
- `@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.270` (SEE LICENSE IN LICENSE.md): 위 SDK가 싣는 플랫폼별 Claude Code 실행 파일이고, 조건도 같다. 수정하지 않고 그대로 싣는다. musl 빌드는 worker Dockerfile이 지운다.

Apache-2.0 패키지가 NOTICE 파일을 싣고 있으면 그 전문을 아래 "NOTICE 전문"에 옮긴다.

## npm 패키지 (production closure)

| 패키지 | 버전 | 라이선스 | 이미지 |
|---|---|---|---|
| @anthropic-ai/claude-agent-sdk | 0.3.270 | SEE LICENSE IN README.md | worker |
| @anthropic-ai/claude-agent-sdk-linux-arm64 | 0.3.270 | SEE LICENSE IN LICENSE.md | worker |
| @anthropic-ai/claude-agent-sdk-linux-arm64-musl | 0.3.270 | SEE LICENSE IN LICENSE.md | worker |
| @anthropic-ai/claude-agent-sdk-linux-x64 | 0.3.270 | SEE LICENSE IN LICENSE.md | worker |
| @anthropic-ai/claude-agent-sdk-linux-x64-musl | 0.3.270 | SEE LICENSE IN LICENSE.md | worker |
| @anthropic-ai/sdk | 0.125.0 | MIT | worker |
| @aws-sdk/checksums | 3.1001.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/client-s3 | 3.1131.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/client-secrets-manager | 3.1138.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/core | 3.978.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/core | 3.978.1 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-env | 3.972.71 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-env | 3.972.72 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-http | 3.972.73 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-http | 3.972.74 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-ini | 3.973.16 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-ini | 3.973.17 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-login | 3.972.78 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-login | 3.972.79 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-node | 3.972.83 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-node | 3.972.84 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-process | 3.972.71 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-process | 3.972.72 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-sso | 3.973.15 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-sso | 3.973.16 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-web-identity | 3.972.77 | Apache-2.0 | control-host, worker |
| @aws-sdk/credential-provider-web-identity | 3.972.78 | Apache-2.0 | control-host, worker |
| @aws-sdk/middleware-sdk-s3 | 3.972.76 | Apache-2.0 | control-host, worker |
| @aws-sdk/nested-clients | 3.997.45 | Apache-2.0 | control-host, worker |
| @aws-sdk/nested-clients | 3.997.46 | Apache-2.0 | control-host, worker |
| @aws-sdk/signature-v4-multi-region | 3.996.46 | Apache-2.0 | control-host, worker |
| @aws-sdk/signature-v4-multi-region | 3.996.47 | Apache-2.0 | control-host, worker |
| @aws-sdk/token-providers | 3.1129.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/token-providers | 3.1138.0 | Apache-2.0 | control-host, worker |
| @aws-sdk/types | 3.974.5 | Apache-2.0 | control-host, worker |
| @aws-sdk/types | 3.974.6 | Apache-2.0 | control-host, worker |
| @aws-sdk/xml-builder | 3.972.40 | Apache-2.0 | control-host, worker |
| @aws-sdk/xml-builder | 3.972.41 | Apache-2.0 | control-host, worker |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | control-host, worker |
| @babel/runtime | 7.29.7 | MIT | worker |
| @electric-sql/pglite | 0.3.10 | Apache-2.0 | control-host, worker |
| @hono/node-server | 2.1.1 | MIT | worker |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | worker |
| @radix-ui/primitive | 1.1.7 | MIT | worker |
| @radix-ui/react-compose-refs | 1.1.5 | MIT | worker |
| @radix-ui/react-context | 1.2.2 | MIT | worker |
| @radix-ui/react-dialog | 1.1.23 | MIT | worker |
| @radix-ui/react-dismissable-layer | 1.1.19 | MIT | worker |
| @radix-ui/react-focus-guards | 1.1.6 | MIT | worker |
| @radix-ui/react-focus-scope | 1.1.16 | MIT | worker |
| @radix-ui/react-id | 1.1.4 | MIT | worker |
| @radix-ui/react-portal | 1.1.17 | MIT | worker |
| @radix-ui/react-presence | 1.1.10 | MIT | worker |
| @radix-ui/react-primitive | 2.1.10 | MIT | worker |
| @radix-ui/react-slot | 1.3.3 | MIT | worker |
| @radix-ui/react-use-callback-ref | 1.1.4 | MIT | worker |
| @radix-ui/react-use-controllable-state | 1.2.6 | MIT | worker |
| @radix-ui/react-use-effect-event | 0.0.5 | MIT | worker |
| @radix-ui/react-use-layout-effect | 1.1.4 | MIT | worker |
| @smithy/core | 3.34.1 | Apache-2.0 | control-host, worker |
| @smithy/core | 3.35.0 | Apache-2.0 | control-host, worker |
| @smithy/credential-provider-imds | 4.5.2 | Apache-2.0 | control-host, worker |
| @smithy/fetch-http-handler | 5.8.0 | Apache-2.0 | control-host, worker |
| @smithy/node-http-handler | 4.12.1 | Apache-2.0 | control-host, worker |
| @smithy/signature-v4 | 5.7.3 | Apache-2.0 | control-host, worker |
| @smithy/types | 4.18.0 | Apache-2.0 | control-host, worker |
| @smithy/types | 4.19.0 | Apache-2.0 | control-host, worker |
| @stablelib/base64 | 1.0.1 | MIT | worker |
| @types/node | 26.5.1 | MIT | control-host, worker |
| @types/pg | 8.15.5 | MIT | control-host, worker |
| @types/react | 19.3.0 | MIT | worker |
| @types/react-dom | 19.3.0 | MIT | worker |
| accepts | 2.0.0 | MIT | worker |
| ajv | 8.20.0 | MIT | worker |
| ajv-formats | 3.0.1 | MIT | worker |
| aria-hidden | 1.2.6 | MIT | worker |
| body-parser | 2.3.0 | MIT | worker |
| bowser | 2.14.1 | MIT | control-host, worker |
| bun-types | 1.3.10 | MIT | control-host, worker |
| bytes | 3.1.2 | MIT | worker |
| call-bind-apply-helpers | 1.0.2 | MIT | worker |
| call-bound | 1.0.4 | MIT | worker |
| clsx | 2.1.1 | MIT | worker |
| content-disposition | 1.1.0 | MIT | worker |
| content-type | 1.0.5 | MIT | worker |
| content-type | 2.1.0 | MIT | worker |
| cookie | 0.7.2 | MIT | worker |
| cookie-signature | 1.2.2 | MIT | worker |
| cors | 2.8.6 | MIT | worker |
| cross-spawn | 7.0.6 | MIT | worker |
| csstype | 3.2.3 | MIT | worker |
| debug | 4.4.3 | MIT | worker |
| depd | 2.0.0 | MIT | worker |
| detect-node-es | 1.1.0 | MIT | worker |
| drizzle-orm | 0.45.2 | Apache-2.0 | control-host, worker |
| dunder-proto | 1.0.1 | MIT | worker |
| ee-first | 1.1.1 | MIT | worker |
| encodeurl | 2.0.0 | MIT | worker |
| es-define-property | 1.0.1 | MIT | worker |
| es-errors | 1.3.0 | MIT | worker |
| es-object-atoms | 1.1.2 | MIT | worker |
| escape-html | 1.0.3 | MIT | worker |
| etag | 1.8.1 | MIT | worker |
| eventsource | 3.0.7 | MIT | worker |
| eventsource-parser | 3.1.1 | MIT | worker |
| express | 5.2.1 | MIT | worker |
| express-rate-limit | 8.7.0 | MIT | worker |
| fast-deep-equal | 3.1.3 | MIT | worker |
| fast-sha256 | 1.3.0 | Unlicense | worker |
| fast-uri | 3.1.7 | BSD-3-Clause | worker |
| finalhandler | 2.1.1 | MIT | worker |
| forwarded | 0.2.0 | MIT | worker |
| fresh | 2.0.0 | MIT | worker |
| function-bind | 1.1.2 | MIT | worker |
| get-intrinsic | 1.3.0 | MIT | worker |
| get-nonce | 1.0.1 | MIT | worker |
| get-proto | 1.0.1 | MIT | worker |
| gopd | 1.2.0 | MIT | worker |
| has-symbols | 1.1.0 | MIT | worker |
| hasown | 2.0.4 | MIT | worker |
| hono | 4.13.7 | MIT | control-host, worker |
| http-errors | 2.0.1 | MIT | worker |
| iconv-lite | 0.7.3 | MIT | worker |
| inherits | 2.0.4 | ISC | worker |
| ip-address | 10.7.0 | MIT | worker |
| ipaddr.js | 1.9.1 | MIT | worker |
| is-promise | 4.0.0 | MIT | worker |
| isexe | 2.0.0 | ISC | worker |
| jose | 6.2.12 | MIT | worker |
| json-schema-to-ts | 3.1.1 | MIT | worker |
| json-schema-traverse | 1.0.0 | MIT | worker |
| json-schema-typed | 8.0.2 | BSD-2-Clause | worker |
| math-intrinsics | 1.1.0 | MIT | worker |
| media-typer | 1.1.1 | MIT | worker |
| merge-descriptors | 2.0.0 | MIT | worker |
| mime-db | 1.54.0 | MIT | worker |
| mime-types | 3.0.2 | MIT | worker |
| ms | 2.1.3 | MIT | worker |
| negotiator | 1.1.0 | MIT | worker |
| object-assign | 4.1.1 | MIT | worker |
| object-inspect | 1.13.4 | MIT | worker |
| on-finished | 2.4.1 | MIT | worker |
| once | 1.4.0 | ISC | worker |
| parseurl | 1.3.3 | MIT | worker |
| path-key | 3.1.1 | MIT | worker |
| path-to-regexp | 8.4.2 | MIT | worker |
| pg | 8.16.3 | MIT | control-host, worker |
| pg-cloudflare | 1.4.0 | MIT | control-host, worker |
| pg-connection-string | 2.14.0 | MIT | control-host, worker |
| pg-int8 | 1.0.1 | ISC | control-host, worker |
| pg-pool | 3.14.0 | MIT | control-host, worker |
| pg-protocol | 1.16.0 | MIT | control-host, worker |
| pg-types | 2.2.0 | MIT | control-host, worker |
| pgpass | 1.0.5 | MIT | control-host, worker |
| pkce-challenge | 5.0.1 | MIT | worker |
| postgres-array | 2.0.0 | MIT | control-host, worker |
| postgres-bytea | 1.0.1 | MIT | control-host, worker |
| postgres-date | 1.0.7 | MIT | control-host, worker |
| postgres-interval | 1.2.0 | MIT | control-host, worker |
| proxy-addr | 2.0.7 | MIT | worker |
| qs | 6.16.0 | BSD-3-Clause | worker |
| range-parser | 1.3.0 | MIT | worker |
| raw-body | 3.0.2 | MIT | worker |
| react | 19.3.0 | MIT | worker |
| react-dom | 19.3.0 | MIT | worker |
| react-remove-scroll | 2.7.2 | MIT | worker |
| react-remove-scroll-bar | 2.3.8 | MIT | worker |
| react-style-singleton | 2.2.3 | MIT | worker |
| require-from-string | 2.0.2 | MIT | worker |
| router | 2.2.0 | MIT | worker |
| safer-buffer | 2.1.2 | MIT | worker |
| scheduler | 0.28.0 | MIT | worker |
| send | 1.2.1 | MIT | worker |
| serve-static | 2.2.1 | MIT | worker |
| setprototypeof | 1.2.0 | ISC | worker |
| shebang-command | 2.0.0 | MIT | worker |
| shebang-regex | 3.0.0 | MIT | worker |
| side-channel | 1.1.1 | MIT | worker |
| side-channel-list | 1.0.1 | MIT | worker |
| side-channel-map | 1.0.1 | MIT | worker |
| side-channel-weakmap | 1.0.2 | MIT | worker |
| split2 | 4.2.0 | ISC | control-host, worker |
| standardwebhooks | 1.1.1 | MIT | worker |
| statuses | 2.0.2 | MIT | worker |
| toidentifier | 1.0.1 | MIT | worker |
| ts-algebra | 2.0.0 | MIT | worker |
| tslib | 2.8.1 | 0BSD | control-host, worker |
| type-is | 2.1.0 | MIT | worker |
| undici-types | 8.9.0 | MIT | control-host, worker |
| unpipe | 1.0.0 | MIT | worker |
| use-callback-ref | 1.3.3 | MIT | worker |
| use-sidecar | 1.1.3 | MIT | worker |
| vary | 1.1.2 | MIT | worker |
| which | 2.0.2 | ISC | worker |
| wrappy | 1.0.2 | ISC | worker |
| xtend | 4.0.2 | MIT | control-host, worker |
| yaml | 2.9.1 | ISC | control-host, worker |
| zod | 3.25.76 | MIT | worker |
| zod | 4.6.5 | MIT | control-host, worker |
| zod-to-json-schema | 3.25.2 | ISC | worker |

## NOTICE 전문

없음.
