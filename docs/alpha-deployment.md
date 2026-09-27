# 내부 알파 실서버 배포

이 문서는 빈 Linux 서버 한 대를 내부 알파에 올리고 첫 세션, 백업, 재부팅, 업그레이드와 롤백까지 확인하는 **상위 순서표**다. 실제 명령과 실패 복구는 [test-ops 운영 runbook](test-ops.md), [백업과 복원](backup-restore.md), [운영 참고](operations.md), [quickstart](quickstart.md), [실제 Claude로 확인하기](real-claude.md)의 해당 절을 정본으로 삼는다. 이 문서와 정본이 다르면 정본을 따른다.

## 배포 결정

- 대상은 신뢰된 내부 사용자 3–5명, 단일 서버, `local-docker` 실행 기반이다. Kubernetes와 HA는 범위 밖이다.
- 이번 알파는 24시간 soak를 다시 돌리지 않고 진행한다. 실 AWS S3, HTTPS, 실제 provider 호출을 포함한 남은 증거는 [94S-303](https://linear.app/94soon/issue/94S-303) 서버 배포에서 수집한다.
- provider key는 운영자 key 하나를 공유한다. 사용자별 API key의 owner가 세션 owner이며, 사용자마다 별도 owner와 API key를 발급한다. 외부 공개 전에는 BYOK 결정과 구현([94S-376](https://linear.app/94soon/issue/94S-376))이 필요하다.
- 알파의 object store는 전용 AWS S3 bucket이다. 같은 호스트의 LocalStack은 재부팅 때 object를 잃으므로 실서버 알파의 지속성 근거로 쓰지 않는다.
- 기본 접근은 loopback bind와 SSH tunnel이다. reverse proxy는 TLS와 VPN 또는 IP allowlist가 모두 준비된 때만 선택한다.

## 1. 호스트를 준비한다

다음 항목이 모두 준비되기 전에는 release나 secret을 서버에 옮기지 않는다. 제품이 강제하는 버전과 quota 조건은 [test-ops의 호스트 요구 사항](test-ops.md#호스트-요구-사항)을 따른다.

- [ ] 지원되는 Linux와 CPU architecture다.
- [ ] Docker Engine 28 이상, Docker Compose 2.24.6 이상이다.
- [ ] Docker data root가 XFS `prjquota`로 mount됐고 용량과 inode에 20% 이상 여유가 있다.
- [ ] NTP가 동기화됐고 시간 동기화 실패를 감지할 수 있다.
- [ ] Docker 서비스가 호스트 재부팅 뒤 자동으로 시작하도록 설정됐다.
- [ ] 방화벽은 SSH와 선택한 TLS endpoint만 허용한다. API, Gitea, PostgreSQL 포트와 Docker socket은 인터넷에 열지 않는다.
- [ ] `git`, `jq`, `curl`, Bun 1.3.14가 있고 checkout에서 dependency 설치를 마칠 수 있다.
- [ ] GHCR package를 읽을 수 있는 최소 권한 token이 있다. `docker login`에는 stdin으로 전달하고 명령 인자, shell history, 로그에 값을 남기지 않는다.

Docker socket은 scheduler 컨테이너가 worker를 관리할 때만 read/write로 사용한다. 호스트 TCP socket을 켜거나 reverse proxy로 전달하지 않는다.

## 2. 네트워크 경로를 고정한다

### 기본: SSH tunnel

[test-ops의 접근 절차](test-ops.md#접근)대로 API와 Gitea는 `127.0.0.1`에 둔다. 각 사용자는 SSH tunnel을 열고 자신의 로컬 loopback으로 접속한다. PostgreSQL은 운영자가 서버 안에서만 접근한다.

### 선택: Nginx + TLS + allowlist 또는 VPN

API만 내부 DNS 이름으로 내보내고 upstream은 계속 loopback을 사용한다. 다음은 필요한 성질을 보여 주는 예시이며, 인증서 경로와 VPN 대역은 실제 값으로 바꾼다.

```nginx
server {
    listen 443 ssl;
    server_name alpha.internal.example;

    ssl_certificate /etc/ssl/alpha/fullchain.pem;
    ssl_certificate_key /etc/ssl/alpha/privkey.pem;

    allow 10.8.0.0/24;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

SSE는 연결을 오래 유지하므로 buffering을 끄고 read timeout을 짧게 두지 않는다. Gitea는 별도 필요가 없으면 SSH tunnel에만 남긴다. 어떤 경로를 택해도 PostgreSQL과 Docker socket은 proxy 또는 방화벽에 노출하지 않는다.

## 3. 전용 S3를 준비한다

[test-ops의 AWS 준비](test-ops.md#aws-준비s3에서만)를 그대로 따른다. 이 작업은 실제 AWS 권한과 비용이 생기므로 배포 담당자가 서버 배포 창에서 수행한다.

- [ ] 알파 전용 bucket 하나이며 region은 `ap-northeast-1`이다.
- [ ] versioning과 Object Lock이 켜져 있고 기본 retention은 없다.
- [ ] 기본 암호화는 SSE-S3 `AES256`이고 public access는 차단됐다.
- [ ] API와 복원 훈련에 필요한 최소 IAM만 부여됐다. bucket 생성 권한은 runtime 자격 증명에 없다.
- [ ] 알파 동안 object version을 만료시키는 lifecycle rule을 두지 않는다. 기존 조직 정책이 있다면 이 bucket 또는 checkpoint prefix가 제외됐다는 증거를 남긴다.
- [ ] `TEST_OPS_OBJECT_STORE=s3` preflight가 create-only upload, legal hold, version read, hold 해제와 scratch version 삭제 왕복을 통과했다.

legal hold된 version을 lifecycle이나 수동 정리 대상으로 삼지 않는다. checkpoint 정리는 제품의 checkpoint GC가 version id와 hold 상태를 확인하며 수행한다.

## 4. release와 설정을 봉인한다

1. `main`의 검증된 commit에 `v*` tag를 만들고 Images workflow가 게시한 세 이미지 digest를 확인한다.
2. [release manifest](test-ops.md#release-manifest)에 `source_commit`, control-host·worker·egress-proxy digest, catalog revision을 기록한다. tag만 적지 않는다.
3. `/etc/agent-platform` 아래에 [env 파일과 카탈로그](test-ops.md#env-파일)를 만들고 요구된 mode를 적용한다. env 파일은 `0600`, 상태 디렉터리는 `0700`, 비밀이 없는 catalog 파일은 API 컨테이너가 읽을 수 있는 mode를 사용한다.
4. provider key, S3 key, PostgreSQL password, egress token, GHCR token을 shell history, PR, evidence 파일, 터미널 캡처와 로그에 넣지 않는다. secret 값은 저장소 밖 env 또는 각 도구의 credential store로만 전달한다.
5. release manifest와 catalog revision을 배포 증거 디렉터리에 복사한다. env 파일과 credential은 복사하지 않는다.

## 5. 설치하고 첫 사용을 확인한다

[test-ops 배포](test-ops.md#배포)의 순서를 바꾸지 않는다.

1. release의 `source_commit`을 checkout하고 dependency를 고정 설치한다.
2. S3 object store로 `preflight`를 먼저 실행한다. 실패하면 `deploy`하지 않는다.
3. 같은 manifest로 `deploy`하고 `/readyz`, scheduler와 reconciler health를 [감시 지점](test-ops.md#감시-지점)에서 확인한다.
4. [배포 절차의 Gitea 단계](test-ops.md#배포)대로 owner와 public sample repository를 만든다. 무작위 password는 화면이나 evidence에 기록하지 않는다.
5. [API key 발급 절차](test-ops.md#api-key-발급과-폐기)로 첫 사용자의 owner와 key를 만든다. 평문 key는 한 번만 직접 전달하고 evidence에는 key id만 남긴다.
6. [quickstart의 curl 준비](quickstart.md#2-curl-준비)를 API key와 서버 endpoint에 맞춘다. 로컬 스택 기동·초기화 명령과 `GATE-SPEC` 대본은 실행하지 않고, `body`의 `profile_id`는 배포 catalog의 `claude-coding`을 쓴다.
7. [실제 Claude 직접 대화](real-claude.md#b-실제-claude와-직접-대화하기)의 첫 요청처럼 파일 작성·README 수정·commit을 명시한 자연어 작업으로 세션 하나를 만든다. 들어오는 permission 요청을 허용하고 turn이 `idle`이 될 때까지 기다린 뒤 SSE event, 완료된 turn, Gitea의 commit과 파일 내용을 확인한다.
8. 그 세션을 pause하고 checkpoint revision이 생긴 뒤 resume하여 admission state가 `active`가 되는 데까지만 확인한다. 첫 사용 smoke에서는 추가 메시지를 보내지 않아 실제 provider turn을 하나로 제한한다. 성공 판정은 응답 문장이 아니라 API·turn·admission 상태, checkpoint revision, Gitea 작업공간 결과로 한다.
9. 세션 usage와 Anthropic Console의 실제 비용을 함께 기록한다. key 취급과 비용 판정 기준은 [실제 Claude 확인 문서](real-claude.md#key-입력과-폐기)와 [비용 절](real-claude.md#비용)을 따른다. 이 서버에서는 그 문서의 로컬 `local.sh` 명령을 실행하지 않는다.

알파 owner 모델은 **API-key owner**다. 같은 provider key를 쓰더라도 사용자마다 다른 owner/API key를 발급하며, 한 사용자의 key를 다른 사용자에게 공유하지 않는다.

## 6. 백업과 복원 기준을 운영한다

[test-ops 백업](test-ops.md#백업)과 [백업 번들의 형식·검증](backup-restore.md)을 정본으로 사용한다.

- 일정: 매일 사용이 적은 시간, 그리고 모든 업그레이드 직전에 백업한다.
- 보존: 호스트에는 최근 14일 성공본, 암호화한 off-host 보관소에는 최근 90일 성공본을 둔다. `.partial`과 `.failed`는 성공본으로 세지 않는다.
- 복제: 성공본만 checksum과 함께 off-host로 복제한다. DB, Gitea 설정과 API key hash가 들어 있으므로 전송·보관 암호화와 최소 접근 권한을 적용한다.
- 알림: 명령의 non-zero exit, 서비스를 다시 열지 못한 경우, 26시간 동안 새 성공본이 없는 경우를 실패로 경보한다.
- 복원 훈련: 한 달에 한 번, 그리고 업그레이드 뒤 첫 백업마다 [restore drill](test-ops.md#복원-훈련)을 `--keep`으로 실행한다. 출력된 drill project, 검증 로그와 loopback 포트를 기록하고 검사한 뒤, 출력된 명령으로 그 project만 지운다. S3 drill bucket은 같은 정본 절의 마지막 문단대로 legal hold, object version과 delete marker를 정리한 뒤 삭제한다.

`restore-drill`은 postgres·object store·Gitea까지만 복원하고 API endpoint를 띄우지 않으므로, 이 결과를 세션 연속성 증거로 쓰지 않는다. [실스택에서 복원 뒤 재개 확인](backup-restore.md#실스택에서-복원-뒤-재개-확인-94s-324)은 synthetic project와 fake provider를 쓰는 제품 검증이며, 실운영 backup·provider transcript·paused 세션의 복구 증거가 아니다. 현재 도구만으로 그 실운영 연속성을 안전하게 검사할 수 없으므로 [94S-303](https://linear.app/94soon/issue/94S-303)에는 `UNVERIFIED`와 도구 공백을 기록하고, 별도 절차가 마련되기 전까지 복원 훈련을 `partial`로 판정한다.

## 7. 업그레이드와 롤백을 연습한다

[test-ops 업그레이드](test-ops.md#업그레이드)를 그대로 따른다.

1. 업그레이드 직전 성공 백업과 off-host 복제를 확인한다.
2. 새 manifest로 preflight를 실행한다.
3. worker image가 바뀌면 자동 restore-plan gate가 내놓은 영향 세션을 확인한다. 불완전하거나 혼합된 판정은 fail-closed이며 우회하지 않는다.
4. 승인 없이 호환 세션만 이어지는 경우 또는 정확한 영향 목록을 승인한 경우에만 upgrade한다.
5. first session smoke와 `status`를 다시 확인한다.

롤백은 이전 release manifest를 `upgrade`에 다시 적용하는 작업이다. 이전 worker로 돌아갈 때도 같은 호환성 gate와 백업 조건을 적용한다. `start_fresh`는 checkpoint context를 버리므로 단순 롤백 수단으로 쓰지 않는다.

## 8. 물리 재부팅을 확인한다

알파 사용자에게 점검 시간을 알리고 진행한다.

### 재부팅 전

- [ ] 진행 중인 turn이 없고 첫 세션이 pause되어 checkpoint revision을 가진다.
- [ ] `status`가 정상이고 최근 백업과 off-host 복제가 성공했다.
- [ ] `backup --stop`으로 새 백업을 만든 뒤 writer가 멈춘 상태임을 확인한다.
- [ ] release manifest, backup 경로, 세션 id와 checkpoint revision을 evidence에 적는다. credential은 적지 않는다.

### 재부팅 뒤

- [ ] NTP, XFS `prjquota`, Docker 자동 기동, 디스크·inode 여유를 다시 확인한다.
- [ ] S3 설치의 [재시작 절차](test-ops.md#s3)로 현재 manifest를 다시 적용한다.
- [ ] `status`, `/readyz`, scheduler, reconciler가 정상이다.
- [ ] 재부팅 전 세션을 resume하고 새 worker가 이전 workspace를 이어 가는지 확인한다.
- [ ] API와 Gitea는 선택한 내부 경로에서만 접근되고 PostgreSQL·Docker socket은 외부에서 닫혀 있다.

## 9. Day 1을 운영한다

- [ ] 시작, 1시간 뒤, 업무 종료 전에 `scripts/test-ops.sh status` 결과를 확인한다.
- [ ] API·scheduler·reconciler 구조화 로그와 디스크·inode·quota를 확인한다.
- [ ] [Datadog 모니터링 지침](https://github.com/JeongJaeSoon/agent-platform/blob/main/docs/monitoring-datadog.md)의 readyz, Docker 로그, host/disk monitor를 적용한다([94S-486](https://linear.app/94soon/issue/94S-486)). 그 문서가 아직 배포 release에 없다면 [test-ops 감시 지점](test-ops.md#감시-지점)을 임시 기준으로 사용하고 미적용 사실을 evidence에 적는다.
- [ ] backup 자동 실행과 실패 알림을 시험하되 운영 backup을 삭제하지 않는다.
- [ ] 사용자별 API key 전달과 폐기 연락 경로를 확인한다.
- [ ] provider usage와 실제 비용을 확인하고 세션 상한과 Anthropic 월 상한을 기록한다.

## 10. 증거를 남긴다

[94S-303](https://linear.app/94soon/issue/94S-303)의 서버 배포 증거는 저장소나 PR이 아니라 서버의 다음 디렉터리에 둔다.

```text
/var/lib/agent-platform/test-ops/evidence/94S-303/<UTC timestamp>/
```

운영자만 읽을 수 있게 하고 off-host 보관소에 암호화해 복제한다. 최소한 다음을 남긴다.

| 파일 | 내용 |
|---|---|
| `release.json` | 배포한 manifest와 source commit, image digest, catalog revision |
| `preflight.txt` | S3 왕복을 포함한 성공 출력. credential과 scratch object 내용은 제거 |
| `status.txt` | 배포 직후와 Day 1의 readyz·scheduler·reconciler·disk 상태 |
| `first-session.md` | owner/key id, session id, turn 상태, SSE·승인·checkpoint·resume 판정. 평문 key 제외 |
| `provider.md` | provider 호출 시각, usage, 플랫폼 추정 비용, Console 실제 비용 |
| `backup-restore.md` | backup 경로·checksum, off-host 복제, restore drill과 세션 연속성 판정 |
| `reboot.md` | 재부팅 전후 상태와 같은 세션의 resume 결과 |
| `monitoring.md` | 적용한 monitor, alert 전달 시험, 알려진 계측 공백 |

실제 AWS·DNS·provider 작업을 하지 않은 항목은 `UNVERIFIED`로 남긴다. CI, 문서 검토, preflight, 실제 서버 동작, 비용 확인은 서로 다른 증거로 기록한다.
