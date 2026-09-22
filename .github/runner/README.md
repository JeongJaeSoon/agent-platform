# self-hosted runner

GitHub Actions의 포함 분을 쓰지 않는 Linux 러너를 개발 머신 안의 전용 VM으로 띄운다. [self-hosted runner 실행은 무료](https://docs.github.com/en/billing/concepts/product-billing/github-actions)이고, [private 저장소에는 권장](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)되는 구성이다(공개 저장소에는 fork PR이 임의 코드를 돌릴 수 있어 권장되지 않는다 — 이 저장소는 private).

## 왜 컨테이너가 아니라 VM인가

`integration`은 postgres와 localstack을 **service container**로 띄우고 `DOCKER_BACKEND_TEST=1`로 Docker 데몬을 직접 쓴다. service container는 [Docker가 설치된 Linux 러너를 요구](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)하므로 macOS 러너에는 붙일 수 없다.

호스트의 Docker 소켓을 마운트한 러너 컨테이너로도 흉내 낼 수는 있지만, 그러면 모든 CI job이 **개발에 쓰는 바로 그 Docker 데몬**을 제어하게 된다. VM은 그 경계를 실제로 긋는다.

## 구축

```bash
brew install lima
limactl start --name=agent-platform-ci .github/runner/lima.yaml
.github/runner/install-runner.sh
```

`lima.yaml`은 Ubuntu 24.04(aarch64)를 Apple Virtualization.framework로 띄우고 6 vCPU / 12 GiB / 80 GiB를 준다. **`mounts: []` — 호스트 파일시스템이 VM에 전혀 올라가지 않는다.** CI job은 GitHub-hosted 러너에서와 똑같이 `git clone`으로만 코드를 얻는다.

`install-runner.sh`는 호스트에서 돈다. 최신 러너를 받아 VM의 `/opt/actions-runner`에 풀고, 인증된 `gh`로 등록 토큰을 받아 **stdin으로만** VM에 넘긴 뒤 systemd 서비스로 올린다. 재실행하면 같은 이름의 등록을 대체한다.

## 연결

러너 라벨은 `agent-platform-ci`다. 저장소 변수 하나로 세 job이 한꺼번에 옮겨 간다.

```bash
gh variable set CI_RUNS_ON --body agent-platform-ci    # self-hosted로
gh variable delete CI_RUNS_ON                          # GitHub-hosted로 복귀
```

`ci.yml`의 `runs-on: ${{ vars.CI_RUNS_ON || 'ubuntu-24.04' }}`가 전부다. **되돌리기가 변수 삭제 한 번**이라는 점이 이 방식을 고른 이유다 — 러너가 죽어 있어도 변수만 지우면 CI가 다시 돈다.

## 격리

VM을 띄우는 것만으로는 격리되지 않는다. Lima 기본값 두 가지가 양방향으로 열려 있어 `lima.yaml`이 둘 다 닫는다.

**바깥으로 — VM이 맥에 닿는 것.** VM은 NAT 게이트웨이를 통해 호스트와 LAN에 그대로 접근한다. 실측으로 `host.lima.internal:5432`와 맥의 LAN 주소 `:5432`·`:4566`이 전부 열려 있었다 — CI job이 개발용 postgres를 읽고 쓸 수 있다는 뜻이다. guest의 nftables가 eth0로 나가는 **새** 연결 중 목적지가 사설 대역(RFC1918 + `169.254.0.0/16` + CGNAT)인 것을 거부한다. `established,related`는 통과시킨다 — 그러지 않으면 `limactl shell`이 쓰는 SSH의 응답이 막힌다.

**안으로 — 맥이 VM에 닿는 것.** Lima는 listen 중인 guest 포트를 호스트 `127.0.0.1`에 자동 공개한다. 그대로 두면 service container의 5432가 개발자 본인의 postgres를 가린다. `portForwards`의 `ignore` 규칙으로 끈다. 규칙은 bind 주소별로 따로 써야 한다 — `guestIP` 기본값(`127.0.0.1`)만 쓴 규칙은 `0.0.0.0`에 bind된 포트, 즉 공개된 컨테이너 포트를 잡지 못한다.

| | |
| --- | --- |
| 격리 경계 | VM. 호스트 마운트 없음, 호스트 Docker 소켓 접근 없음 |
| VM → 맥·LAN | 차단 (nftables, 사설 대역 대상 신규 연결 거부) |
| 맥 → VM | 차단 (`portForwards` 전부 `ignore`). `limactl shell`의 SSH만 예외 |
| VM → 인터넷 | 허용. CI는 GitHub·npm·Docker Hub에 닿아야 한다 |
| 컨테이너끼리 | 허용. service container가 존재하는 이유다 |
| 러너 사용자 | `runner` (non-root). `docker` 그룹이라 **VM 안에서는 root와 동등**하다 — 그래서 경계가 사용자가 아니라 VM이다 |
| VM에 남는 인증정보 | 없음. 등록 토큰은 1시간 만료이고 파일로 쓰지 않는다 |
| 대상 | 이 저장소 하나(repository-level 등록) |

`lima.yaml`을 고친 뒤에는 양방향을 다시 잰다. VM에서 `host.lima.internal:5432`와 `169.254.169.254:80`이 모두 거부되는지, 그리고 guest에서 임의 포트를 열었을 때 맥의 `127.0.0.1` 같은 포트에 아무것도 뜨지 않는지 확인한다.

**남아 있는 위험.** 러너는 ephemeral이 아니다. job 사이에 파일시스템 상태가 남으므로, 한 job이 심어 둔 것이 다음 job에 보인다. 이 저장소는 fork PR이 없는 1인 private 저장소라 현재 위협 모델에서는 감수한다. nftables는 IP 계층만 보므로 공용 인터넷으로 나가는 것은 무엇이든 통과한다 — 유출 경로를 막는 장치가 아니다.

<!-- ponytail: ephemeral 러너를 쓰지 않았다. 매 job마다 재등록하려면 VM에 장기 PAT를 두어야 하는데, 지금 막는 위협보다 그 토큰이 더 큰 노출이다. 이 저장소에 다른 기여자가 생기거나 이 러너를 다른 저장소와 공유하는 순간 `--ephemeral` + repo 범위 fine-grained PAT로 올린다. -->

상태가 의심스러우면 VM을 통째로 버린다. 30분이면 재구축된다.

```bash
limactl delete -f agent-platform-ci
limactl start --name=agent-platform-ci .github/runner/lima.yaml && .github/runner/install-runner.sh
```

## 아키텍처 차이

이 러너는 **arm64**, GitHub-hosted `ubuntu-24.04`는 **amd64**다. `CI_RUNS_ON`을 켜면 amd64에서 도는 실행이 없어진다. 쓰는 이미지(`postgres:16`, `localstack/localstack:3`, `busybox`)와 도구(Bun, uv, Python 3.13)는 전부 multi-arch라 동작 자체는 문제없지만, **아키텍처에 민감한 버그는 걸리지 않는다.** `ci.yml`의 `ponytail:` 주석에 이 선택과 되돌릴 조건을 적어 두었다.

## 유지보수

```bash
limactl shell agent-platform-ci -- sudo -u runner docker system prune -af --volumes   # 디스크 회수
limactl shell agent-platform-ci -- df -h /                                            # 남은 공간
.github/runner/install-runner.sh                                                      # 러너 버전 갱신
gh api repos/JeongJaeSoon/agent-platform/actions/runners --jq '.runners[]|"\(.name) \(.status)"'
```

`--disableupdate`로 등록했으므로 러너가 스스로 업데이트하지 않는다. GitHub이 구 버전 거부를 시작하면 위 스크립트를 다시 돌린다.

VM은 `limactl start`로 켜야 job을 받는다. 노트북이 꺼져 있거나 VM이 내려가 있으면 job은 실패하지 않고 **큐에 머문다** — 그 상태가 오래 가면 `CI_RUNS_ON`을 지워 GitHub-hosted로 되돌린다.

## Mac Studio 이행

이행이 옮기는 것은 **이 디렉터리의 두 파일과 저장소 변수 하나뿐**이다. Mac Studio도 arm64라 아키텍처 이야기가 그대로고, 라벨(`agent-platform-ci`)이 같으므로 `CI_RUNS_ON`은 건드리지 않는다. `ci.yml`도 그대로다.

머신마다 다른 것은 VM 크기뿐인데, `lima.yaml`을 고치지 않고 기동할 때 덮어쓴다.

```bash
brew install lima
limactl start --name=agent-platform-ci --set '.cpus=10 | .memory="24GiB"' .github/runner/lima.yaml
.github/runner/install-runner.sh
```

**순서가 있다.** 등록은 이름(`agent-platform-ci`)으로 대체되므로, 새 머신에서 `install-runner.sh`를 돌리는 순간 옛 머신의 러너 등록이 무효가 되고 그쪽 systemd 서비스는 인증 실패로 떨어진다. 그러니 **옛 머신을 먼저 정리**한다.

```bash
# 1. 옛 머신 (MacBook Pro)
limactl delete -f agent-platform-ci

# 2. 새 머신 (Mac Studio) — 위 세 줄
# 3. 확인
gh api repos/JeongJaeSoon/agent-platform/actions/runners --jq '.runners[]|"\(.name) \(.status)"'
```

두 머신을 겹쳐 두고 싶으면 이름만 다르게 주면 된다 — 라벨이 같으므로 GitHub이 둘 중 노는 쪽에 job을 보낸다. 이행 중 무중단이 필요할 때만 쓴다.

```bash
RUNNER_NAME=agent-platform-ci-studio .github/runner/install-runner.sh
```

이행의 주된 이유는 성능이 아니라 가용성이다. 노트북이 닫혀 있으면 job은 실패하지 않고 **큐에 머무는데**, 항상 켜져 있는 머신에서는 그 상태가 없어진다. 옮긴 뒤 격리는 새 머신에서 다시 잰다 — LAN 구성이 다르면 막아야 할 주소도 다르다.
