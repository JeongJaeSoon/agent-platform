export const githubKo = {
  "github.nav": "GitHub 연결 설정",
  "github.description":
    "에이전트가 GitHub 저장소에 쓰는 App, 워크스페이스가 허용하는 기능, App마다의 권한과 설치된 저장소입니다.",
  "github.descriptionMember":
    "에이전트가 GitHub 저장소에 쓰는 App과 워크스페이스가 허용한 기능입니다. 소유자와 관리자가 바꿀 수 있습니다.",
  "github.add": "App 추가",
  "github.added": "{name}을(를) 추가했습니다.",
  "github.rotated": "{name}의 키를 교체했습니다.",
  "github.empty.title": "GitHub App을 추가하면 에이전트가 저장소를 쓸 수 있습니다",
  "github.empty.hint":
    "작성용 App으로 clone·push·PR을 하고, 리뷰 승인용 App으로 PR에 리뷰를 남깁니다.",
  "github.role.author.title": "작성용 App",
  "github.role.author.hint":
    "에이전트가 저장소를 clone하고, 승인된 결과를 push하고, PR을 열 때 쓰는 App입니다.",
  "github.role.author.badge": "작성용",
  "github.role.author.features": "작성용 App으로 켤 수 있는 기능",
  "github.role.author.add": "작성용 App 추가",
  "github.role.author.none": "작성용 App이 없습니다.",
  "github.role.reviewer.title": "리뷰 승인용 App",
  "github.role.reviewer.hint":
    "에이전트가 PR에 리뷰를 남길 때 쓰는 App입니다. GitHub는 PR을 연 App의 승인을 받지 않으므로 작성용과 다른 App이어야 합니다.",
  "github.role.reviewer.badge": "리뷰 승인용",
  "github.role.reviewer.features": "리뷰 승인용 App으로 켤 수 있는 기능",
  "github.role.reviewer.add": "리뷰 승인용 App 추가",
  "github.role.reviewer.none": "리뷰 승인용 App이 없습니다.",
  "github.ceiling.baseMeta": "GitHub를 쓰는 에이전트 모두",
  "github.ceiling.unsaved": "저장 전",
  "github.ceiling.theirs": "다른 사람이 바꿈",
  "github.ceiling.footChanged":
    "{role} 기능 {count}개를 바꿉니다. 저장하면 아래 표의 필요 권한이 이대로 적용되고 변경 기록에 남습니다.",
  "github.ceiling.footLowered":
    "끄는 기능을 켠 에이전트({list})의 다음 GitHub 요청부터 거절됩니다.",
  "github.ceiling.save": "저장",
  "github.card.keyRejected": "키 거절됨",
  "github.card.memberLine": "App ID {id}",
  "github.card.settings": "GitHub에서 App 설정",
  "github.card.rotate": "키 교체",
  "github.card.rotateName": "{name} 키 교체",
  "github.card.lackingTitle": "이 App에 {list} 권한이 없습니다",
  "github.card.lackingNow": "켠 기능의 요청을 GitHub가 거절합니다.",
  "github.card.lackingDraft":
    "이대로 저장하면 켠 기능의 요청을 GitHub가 거절합니다.",
  "github.card.lackingFix":
    "GitHub의 App 설정에서 권한을 더하고, 설치마다 변경을 승인하세요.",
  "github.card.accounts": "{name}을(를) 설치한 GitHub 계정",
  "github.card.selectionAll": "모든 저장소 {count}개",
  "github.card.selectionSelected": "선택한 저장소 {count}개",
  "github.card.manageInstallation": "GitHub에서 설치 관리",
  "github.card.noInstallation": "이 App을 설치한 GitHub 계정이 없습니다.",
  "github.permissions.col.install": "설치",
  "github.permissions.changedRow": "(저장 전 변경)",
  "github.permissions.pendingCell": "(승인 대기)",
  "github.permissions.folded": "필요 {need} · App {app} · 설치 {granted}",
  "github.permissions.changedNote":
    "파란 줄은 저장하지 않은 기능 변경으로 바뀐 필요 권한입니다: {list}.",
  "github.permissions.status.beyond": "안내보다 넓음",
  "github.permissions.status.unused": "현재 필요 없음",
  "github.permissions.status.pending": "설치 승인 대기",
  "github.repos.title": "설치된 저장소",
  "github.repos.col.name": "저장소",
  "github.repos.col.branch": "기본 브랜치",
  "github.repos.col.agents": "고른 에이전트",
  "github.repos.agents": "{count}개",
  "github.repos.empty": "이 설치가 닿는 저장소가 없습니다.",
  "github.repos.range": "{from}–{to} / {total}",
  "github.repos.pages": "{page} / {pages}",
  "github.repos.nav": "{label} 저장소 페이지",
  "github.repos.previous": "{label} 이전 페이지",
  "github.repos.next": "{label} 다음 페이지",
  "github.repos.retry": "다시 시도",
  "github.repos.unavailable.title": "GitHub에서 저장소 목록을 받지 못했습니다",
  "github.repos.unavailable.body":
    "잠시 뒤 다시 시도하세요. 저장된 설정과 에이전트 실행에는 영향이 없습니다.",
  "github.repos.auth.title": "이 App의 키를 GitHub가 받지 않습니다",
  "github.repos.auth.body":
    "GitHub의 App 설정에서 새 private key를 만들어 키를 교체하세요.",
  "github.repos.suspended.title": "이 설치가 GitHub에서 중지됐습니다",
  "github.repos.suspended.body":
    "설치 관리에서 다시 켜기 전까지 이 계정 저장소의 요청이 거절됩니다.",
  "github.outside.title": "설치 밖 저장소",
  "github.outside.hint":
    "에이전트가 고른 적 있지만 지금 어느 작성용 설치도 닿지 않는 저장소입니다. 이 저장소를 쓰는 에이전트의 GitHub 요청은 거절됩니다.",
  "github.outside.badge": "설치 밖",
  "github.outside.unchecked": "확인 안 됨",
  "github.repo.editTitle": "기본 브랜치 바꾸기",
  "github.addDialog.title": "GitHub App 추가",
  "github.addDialog.hint":
    "GitHub에서 만든 App의 ID와 private key를 넣습니다. 저장하면 GitHub에 물어 App 이름·권한·설치를 읽습니다. GitHub는 키의 공개 부분만 보관하므로, 예전 .pem이 없으면 App 설정 › Private keys에서 새로 만드세요.",
  "github.addDialog.role": "용도",
  "github.addDialog.authorHint": "clone·push·PR에 씁니다.",
  "github.addDialog.reviewerHint": "작성용과 다른 App이어야 합니다.",
  "github.addDialog.taken":
    "연결된 App이 있습니다. 바꾸려면 위험 구역에서 연결을 해제하세요.",
  "github.addDialog.full":
    "작성용과 리뷰 승인용 App이 모두 연결돼 있습니다. 다른 App으로 바꾸려면 위험 구역에서 지금 App의 연결을 해제한 뒤 추가하세요.",
  "github.addDialog.submit": "추가",
  "github.addDialog.close": "닫기",
  "github.rotate.title": "{name} 키 교체",
  "github.rotate.hint":
    "같은 App에서 새로 만든 private key를 넣습니다. GitHub가 받아들이면 이전 키 대신 씁니다.",
  "github.rotate.appIdHint": "키를 교체할 App입니다.",
  "github.rotate.submit": "확인하고 교체",
  "github.disconnect.row": "{name} 연결 해제",
  "github.disconnect.action": "연결 해제",
  "github.disconnect.title": "{name} 연결을 해제할까요?",
  "github.disconnect.done": "{name} 연결을 해제했습니다.",
  "github.disconnect.authorHint":
    "다시 추가할 때까지 에이전트의 clone·push·PR 요청과 진행 중 세션의 GitHub 요청이 거절됩니다. GitHub의 App과 설치는 그대로 남습니다.",
  "github.disconnect.reviewerHint":
    "다시 추가할 때까지 에이전트의 리뷰 요청이 거절됩니다. GitHub의 App과 설치는 그대로 남습니다.",
  "github.disconnect.userLink": "구성원 계정 연결도 끊깁니다.",
  "github.app": "GitHub App",
  "github.appHint":
    "에이전트는 이 App 하나로 clone·push·PR·Actions를 합니다. 권한 원본은 GitHub에 있고, 여기서는 플랫폼이 필요한 수준과 비교해 보여 줍니다.",
  "github.unset": "등록 안 됨",
  "github.unsetLine":
    "App ID와 private key를 등록하면 저장소에 설치할 수 있습니다.",
  "github.connected": "키 확인됨",
  "github.summary.label": "연결 요약",
  "github.summary.accounts": "연결된 GitHub 계정",
  "github.summary.accountsValue": "{count}곳",
  "github.summary.repositoriesValue": "{count}개",
  "github.summary.needsCheck": "{count}개 확인 필요",
  "github.summary.userLink": "구성원 계정 연결",
  "github.summary.ready": "준비됨",
  "github.summary.setupNeeded": "설정 필요",
  "github.checkFailed": "확인 실패",
  "github.unreachable":
    "지금 GitHub에 연결하지 못해 설치 상태를 확인하지 못했습니다. 잠시 뒤 다시 열어 보세요.",
  "github.rejectedNow":
    "GitHub가 이 App을 받지 않습니다. App이 삭제되었거나 키가 폐기되었다면 새 키로 다시 등록하세요.",
  "github.appLine": "App ID {id} · 키 {at} 저장 · 저장한 사람 {by}",
  "github.appLineAt": "App ID {id} · 키 {at} 저장",
  "github.register": "등록",
  "github.replace": "교체",
  "github.install": "GitHub에서 설치",
  "github.manageRepositories": "GitHub에서 저장소 관리",
  "github.appId": "App ID",
  "github.appIdHint": "GitHub App 설정 페이지 위쪽에 있는 숫자입니다.",
  "github.appIdMissing": "App ID를 숫자로 넣어 주세요.",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "키는 GitHub에서 확인한 뒤 암호화해 저장하고, 저장한 뒤에는 다시 보여 주지 않습니다. 저장했으면 내려받은 파일은 지우세요.",
  "github.keyMissing": ".pem 파일을 골라 주세요.",
  "github.save": "확인하고 저장",
  "github.addExisting": "이미 있는 App 추가",
  "github.addExistingHint":
    "조직에 쓰던 GitHub App이 있으면 App ID와 개인 키 파일로 연결합니다. GitHub는 키의 공개 부분만 보관해서, 예전에 받은 .pem을 다시 내려받을 수 없습니다. 파일이 없으면 App 설정 › Private keys에서 새로 만드세요.",
  "github.privateKeysLink": "GitHub 문서: 개인 키 관리",
  "github.connect": "연결",
  "github.connectNote":
    "연결하면 GitHub에서 권한과 설치를 바로 읽어 이 화면에 보여 줍니다.",
  "github.saved": "GitHub App을 저장했습니다.",
  "github.invalidKey":
    "이 파일은 RSA private key가 아닙니다. GitHub App 페이지의 Private keys에서 받은 .pem 파일을 고르세요.",
  "github.rejected":
    "GitHub가 이 App ID와 키를 받지 않았습니다. App ID와, 그 App에서 받은 키인지 확인하세요.",
  "github.saveUnreachable":
    "GitHub에 연결하지 못해 저장하지 않았습니다. 잠시 뒤 다시 시도하세요.",
  "github.installations": "설치된 GitHub 계정",
  "github.installationsEmpty": "아직 어디에도 설치되지 않았습니다.",
  "github.installationLine": "{selection} · 에이전트 저장소 {count}개",
  "github.installationApproved": "권한 승인됨",
  "github.selectionAll": "모든 저장소",
  "github.selectionSelected": "고른 저장소만",
  "github.openOnGitHub": "GitHub에서 보기",
  "github.repositories": "에이전트가 쓰는 저장소",
  "github.repositoriesHint":
    "App이 설치된 저장소는 등록 없이 GitHub 설치 목록에서 바로 읽습니다. 에이전트마다 쓸 저장소는 에이전트의 GitHub 탭에서 고릅니다.",
  "github.repositoriesByAccount": "계정별 저장소 보기 ↓",
  "github.repositoriesEmpty":
    "아직 에이전트가 고른 저장소가 없습니다. 에이전트의 GitHub 탭에서 App이 설치된 저장소를 고르면 여기에 나옵니다.",
  "github.repositoriesFoot":
    "고르기와 브랜치 변경은 감사 기록(receipt)에 남습니다. 처음 한 번 config/repositories.yaml에서 가져온 저장소도 여기서 고칩니다. 로그인 비밀값이 필요한 저장소는 운영자가 설정 파일에서 관리합니다.",
  "github.repo.browse": "설치된 저장소 보기",
  "github.repo.pickTitle": "App이 설치된 저장소",
  "github.repo.pickHint":
    "GitHub가 App 설치에 허용한 저장소입니다. 목록에 없으면 GitHub에서 App 설치에 저장소를 더하세요.",
  "github.repo.pickEmpty": "이 설치에 허용된 저장소가 없습니다.",
  "github.repo.pickNoApp": "작성용 App을 먼저 등록하세요.",
  "github.repo.pickFileHeld":
    "운영자 설정 파일이 자체 자격 증명으로 이 저장소를 이미 등록했습니다. 목록의 그 항목을 쓰세요.",
  "github.repo.pickNameHeld":
    "같은 이름을 쓰던 다른 저장소의 항목이 남아 있습니다. GitHub에서 이름이 바뀐 그 저장소를 먼저 한 번 고르면 항목이 새 이름으로 바뀝니다.",
  "github.repo.pickNoInstallation":
    "App이 아직 어디에도 설치되지 않았습니다. GitHub에서 App을 설치하세요.",
  "github.repo.installationReviewer": "{account} (리뷰용 App)",
  "github.repo.installation": "설치",
  "github.repo.pageOf": "{total}개 중 {from}–{to}",
  "github.repo.previousPage": "이전",
  "github.repo.nextPage": "다음",
  "github.repo.agentCount": "에이전트 {count}개가 사용",
  "github.repo.private": "비공개",
  "github.repo.branch": "기본 브랜치",
  "github.repo.branchHint":
    "세션이 이 브랜치에서 시작합니다. 바꾸면 이 저장소에서 실행 중인 세션은 다음 저장소 요청부터 거절됩니다.",
  "github.repo.branchInvalid": "브랜치 이름이 올바르지 않습니다.",
  "github.repo.edit": "편집",
  "github.repo.save": "저장",
  "github.repo.editName": "{name} 편집",
  "github.repo.saved": "{name}의 기본 브랜치를 {branch}(으)로 바꿨습니다.",
  "github.repo.conflict":
    "다른 곳에서 이 저장소를 먼저 바꿨습니다. 새로 읽은 값을 확인하고 다시 저장하세요.",
  "github.repo.file": "설정 파일",
  "github.repo.fileHint":
    "운영자 설정 파일의 저장소입니다. 콘솔에서 바꾸지 않습니다.",
  "github.repo.seed": "yaml에서 가져옴",
  "github.installed": "설치됨",
  "github.notInstalled": "설치 안 됨",
  "github.unknown": "확인 못 함",
  "github.delete": "GitHub App 삭제",
  "github.deleteHint":
    "다시 등록할 때까지 이 App을 쓰는 저장소는 clone·push·PR을 할 수 없습니다. GitHub의 App과 설치는 그대로 남습니다.",
  "github.deleteTitle": "GitHub App을 삭제할까요?",
  "github.deleted": "GitHub App을 삭제했습니다.",
  "github.replaceRow": "GitHub App 교체",
  "github.replaceRowHint":
    "App ID와 private key를 다시 등록합니다. 영향은 다음 단계에서 확인합니다.",
  "github.replaceHint":
    "App ID와 private key를 다시 등록합니다. 다른 App으로 바꾸면 새 App이 설치되지 않은 저장소는 clone·push·PR을 할 수 없고, 사용자 계정 연결의 Client secret이 지워집니다.",
  "github.replaceTitle": "GitHub App을 교체할까요?",
  "github.replaceNext": "다음 단계에서 새 App ID와 private key를 고릅니다.",
  "github.newTab": "(새 탭에서 열림)",
  "github.permissions.title": "권한",
  "github.permissions.hint": "문제 있는 권한이 위에 옵니다",
  "github.permissions.unread":
    "아직 GitHub에서 권한을 읽지 않았습니다. 소유자나 관리자가 이 화면을 열면 읽습니다.",
  "github.permissions.waiting": "필요한 수준을 읽는 중입니다.",
  "github.permissions.col.name": "권한",
  "github.permissions.col.need": "필요",
  "github.permissions.col.app": "App",
  "github.permissions.col.status": "상태",
  "github.permissions.levelNone": "없음",
  "github.permissions.use.base": "기본",
  "github.permissions.use.actions": "Actions 실행에 씀",
  "github.permissions.use.actionsOff": "Actions 실행을 켜면 씀",
  "github.permissions.use.workflows": "워크플로 파일 수정에 씀",
  "github.permissions.use.workflowsOff": "워크플로 파일 수정을 켜면 씀",
  "github.permissions.use.none": "플랫폼이 쓰지 않음",
  "github.permissions.status.missing": "App에 없음",
  "github.permissions.status.short": "App에 부족",
  "github.permissions.status.wide": "필요보다 넓음",
  "github.permissions.status.ok": "맞음",
  "github.permissions.foot":
    "권한은 GitHub의 App 설정에서 바꿉니다. 바꾼 뒤 계정마다 설치에서 변경을 승인해야 토큰에 들어갑니다.",
  "github.permissions.wideTitle":
    "작성용 App이 안내보다 넓은 권한을 가졌습니다",
  "github.permissions.wideBody":
    "{list}. 플랫폼은 이 권한으로 토큰을 발급하지 않지만, 키가 새면 GitHub에서는 쓸 수 있습니다. GitHub의 App 설정에서 빼고 설치의 권한 변경을 승인하세요.",
  "github.permissions.level.read": "읽기",
  "github.permissions.level.write": "쓰기",
  "github.permissions.level.admin": "관리",
  "github.permissions.name.contents": "저장소 내용",
  "github.permissions.name.pull_requests": "Pull request",
  "github.permissions.name.metadata": "메타데이터",
  "github.permissions.name.actions": "Actions",
  "github.permissions.name.checks": "Checks",
  "github.permissions.name.issues": "Issues",
  "github.permissions.name.workflows": "Workflows",
  "github.permissions.name.administration": "Administration",
  "github.ceiling.title": "에이전트가 켤 수 있는 최대 권한",
  "github.ceiling.hint":
    "에이전트 GitHub 탭은 여기서 허용한 기능만 켤 수 있습니다. 기능은 묶음 머리에 적힌 App의 권한으로 토큰을 받습니다. 여기서 켜도 App에 권한이 없으면 GitHub가 거절합니다. 낮추면 이미 켠 에이전트도 다음 GitHub 요청부터 거절됩니다.",
  "github.ceiling.groupAuthor": "{name}의 권한으로",
  "github.ceiling.groupAuthorUnset": "작성용 App의 권한으로",
  "github.ceiling.groupReviewer": "리뷰 승인용 App의 권한으로",
  "github.ceiling.viewApp": "App 권한 보기 ↑",
  "github.ceiling.needLabel": "필요한 App 권한",
  "github.ceiling.heldOk": "있음",
  "github.ceiling.heldShort": "App은 {level}",
  "github.ceiling.heldNone": "App에 없음",
  "github.ceiling.appShort": "App에 권한 부족",
  "github.ceiling.base": "PR 작성·수정",
  "github.ceiling.baseBadge": "기본",
  "github.ceiling.baseHint":
    "clone, push, PR 열기·코멘트. GitHub를 쓰는 모든 에이전트가 가집니다.",
  "github.ceiling.always": "항상 켜짐",
  "github.ceiling.feature.review": "PR 리뷰",
  "github.ceiling.feature.reviewHint":
    "작성용 App이 연 PR에 코멘트·변경 요청·승인 리뷰를 남깁니다. 리뷰 승인용 App을 추가하면 켤 수 있습니다.",
  "github.ceiling.feature.actions": "Actions 실행",
  "github.ceiling.feature.actionsHint":
    "에이전트 허용 목록의 워크플로를 실행하거나 다시 실행합니다.",
  "github.ceiling.feature.workflows": "워크플로 파일 수정",
  "github.ceiling.feature.workflowsHint":
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다.",
  "github.ceiling.agentsUsing": "활성 릴리스에서 켠 에이전트 {count}개",
  "github.ceiling.allowed": "허용",
  "github.ceiling.denied": "허용 안 함",
  "github.ceiling.receiptNote":
    "바꾸면 감사 기록(receipt)에 남습니다. 검사 결과 쓰기·이슈 쓰기는 아직 작업이 없어 목록에서 뺐습니다.",
  "github.ceiling.revert": "되돌리기",
  "github.ceiling.saved": "기능 설정을 저장했습니다.",
  "github.ceiling.conflict":
    "다른 사람이 먼저 기능 설정을 바꿨습니다. 바꾼 칸을 표시했으니 확인하고 다시 저장하세요.",
  "github.ceiling.lowerTitle": "기능을 끌까요?",
  "github.ceiling.lowerBody":
    "{features} 권한을 끕니다. 앞 릴리스로 도는 세션도 다음 GitHub 요청부터 거절됩니다.",
  "github.ceiling.lowerItem":
    "{feature}(활성 릴리스에서 켠 에이전트 {count}개)",
  "github.ceiling.lowerConfirm": "끄고 저장",
  "github.approvalPending": "권한 변경 승인 대기",
  "github.sameAsReviewer":
    "리뷰용 App으로 등록된 App입니다. 작성용 App은 다른 App이어야 합니다.",
  "github.reviewer.title": "리뷰 승인용 App",
  "github.reviewer.hint":
    "에이전트가 PR에 리뷰(코멘트·승인)를 남기려면 위 App과 다른 App이 하나 더 필요합니다. GitHub는 PR을 연 계정의 승인을 받지 않기 때문입니다. 등록하지 않으면 리뷰는 사람이 합니다.",
  "github.reviewer.advanced": "고급",
  "github.reviewer.advancedUnset": "고급 · 등록 안 됨",
  "github.reviewer.open": "설정 열기",
  "github.reviewer.close": "접기",
  "github.reviewer.app": "리뷰용 App",
  "github.reviewer.unsetLine":
    "등록하면 에이전트 GitHub 탭에서 리뷰 승인을 켤 수 있습니다.",
  "github.reviewer.permissionsTitle": "권장 권한",
  "github.reviewer.permissions":
    "Contents 읽기, Pull requests 읽기·쓰기, Metadata 읽기. 리뷰할 저장소에 설치하세요.",
  "github.reviewer.riskTitle": "같은 에이전트의 작성과 승인",
  "github.reviewer.risk":
    "같은 에이전트가 작성용 App으로 연 PR을 이 App으로 승인할 수 있고, 플랫폼은 이를 막지 않습니다. 필수 리뷰가 1명인 저장소라면 그 승인만으로 병합 조건이 채워질 수 있습니다. 사람 리뷰가 꼭 필요하면 GitHub에서 필수 리뷰어를 2명 이상 두거나 CODEOWNERS로 사람 리뷰를 요구하세요.",
  "github.reviewer.saved": "리뷰용 App을 저장했습니다.",
  "github.reviewer.sameApp":
    "작성용 App과 같은 App은 리뷰용으로 등록할 수 없습니다. 리뷰용 App을 따로 만들어 등록하세요.",
  "github.reviewer.noAuthorApp":
    "작성용 App을 먼저 등록해야 리뷰용 App을 등록할 수 있습니다.",
  "github.reviewer.delete": "리뷰용 App 삭제",
  "github.reviewer.deleteHint":
    "다시 등록할 때까지 에이전트의 리뷰 요청은 거절됩니다. GitHub의 App과 설치는 그대로 남습니다.",
  "github.reviewer.deleteTitle": "리뷰용 App을 삭제할까요?",
  "github.reviewer.deleted": "리뷰용 App을 삭제했습니다.",
  "github.reviewer.replaceRow": "리뷰용 App 교체",
  "github.reviewer.replaceHint":
    "App ID와 private key를 다시 등록합니다. 다른 App으로 바꾸면 새 App이 설치되지 않은 저장소의 리뷰 요청은 거절됩니다.",
  "github.reviewer.replaceTitle": "리뷰용 App을 교체할까요?",
};

export const githubEn: Record<keyof typeof githubKo, string> = {
  "github.nav": "GitHub connection",
  "github.description":
    "The Apps agents reach GitHub repositories with, the features the workspace allows, and each App's permissions and installed repositories.",
  "github.descriptionMember":
    "The Apps agents reach GitHub repositories with, and the features the workspace allows. Owners and admins can change them.",
  "github.add": "Add App",
  "github.added": "Added {name}.",
  "github.rotated": "Replaced the key of {name}.",
  "github.empty.title": "Add a GitHub App so agents can work in repositories",
  "github.empty.hint":
    "An author App clones, pushes and opens pull requests; a reviewer App leaves reviews on them.",
  "github.role.author.title": "Author App",
  "github.role.author.hint":
    "The App agents clone repositories, push approved results and open pull requests with.",
  "github.role.author.badge": "Author",
  "github.role.author.features": "Features the author App allows",
  "github.role.author.add": "Add author App",
  "github.role.author.none": "No author App.",
  "github.role.reviewer.title": "Reviewer App",
  "github.role.reviewer.hint":
    "The App agents review pull requests with. GitHub does not accept an approval from the App that opened the pull request, so it must be another App than the author's.",
  "github.role.reviewer.badge": "Reviewer",
  "github.role.reviewer.features": "Features the reviewer App allows",
  "github.role.reviewer.add": "Add reviewer App",
  "github.role.reviewer.none": "No reviewer App.",
  "github.ceiling.baseMeta": "Every agent that uses GitHub",
  "github.ceiling.unsaved": "Unsaved",
  "github.ceiling.theirs": "Changed by someone else",
  "github.ceiling.footChanged":
    "Changes {count} {role} feature(s). Saving applies the needed permissions in the tables below and is recorded.",
  "github.ceiling.footLowered":
    "Agents that turned on a feature being turned off ({list}) are refused from their next GitHub request.",
  "github.ceiling.save": "Save",
  "github.card.keyRejected": "Key refused",
  "github.card.memberLine": "App ID {id}",
  "github.card.settings": "App settings on GitHub",
  "github.card.rotate": "Replace key",
  "github.card.rotateName": "Replace the key of {name}",
  "github.card.lackingTitle": "This App lacks {list}",
  "github.card.lackingNow":
    "GitHub refuses the requests of the features turned on.",
  "github.card.lackingDraft":
    "Saved as is, GitHub refuses the requests of the features turned on.",
  "github.card.lackingFix":
    "Add the permissions in the App's settings on GitHub, then approve the change on each installation.",
  "github.card.accounts": "GitHub accounts {name} is installed on",
  "github.card.selectionAll": "All repositories: {count}",
  "github.card.selectionSelected": "Selected repositories: {count}",
  "github.card.manageInstallation": "Manage installation on GitHub",
  "github.card.noInstallation": "No GitHub account has installed this App.",
  "github.permissions.col.install": "Install",
  "github.permissions.changedRow": "(unsaved change)",
  "github.permissions.pendingCell": "(approval pending)",
  "github.permissions.folded": "Need {need} · App {app} · Install {granted}",
  "github.permissions.changedNote":
    "Blue rows are needs the unsaved feature changes alter: {list}.",
  "github.permissions.status.beyond": "Beyond guidance",
  "github.permissions.status.unused": "Not needed now",
  "github.permissions.status.pending": "Approval pending",
  "github.repos.title": "Installed repositories",
  "github.repos.col.name": "Repository",
  "github.repos.col.branch": "Default branch",
  "github.repos.col.agents": "Agents",
  "github.repos.agents": "{count}",
  "github.repos.empty": "This installation reaches no repositories.",
  "github.repos.range": "{from}–{to} of {total}",
  "github.repos.pages": "{page} / {pages}",
  "github.repos.nav": "{label} repository pages",
  "github.repos.previous": "{label} previous page",
  "github.repos.next": "{label} next page",
  "github.repos.retry": "Try again",
  "github.repos.unavailable.title": "GitHub did not return the repositories",
  "github.repos.unavailable.body":
    "Try again shortly. Saved settings and agent runs are not affected.",
  "github.repos.auth.title": "GitHub does not accept this App's key",
  "github.repos.auth.body":
    "Make a new private key in the App's settings on GitHub and replace the key.",
  "github.repos.suspended.title": "This installation is suspended on GitHub",
  "github.repos.suspended.body":
    "Requests to this account's repositories are refused until it is resumed in the installation settings.",
  "github.outside.title": "Repositories outside the installations",
  "github.outside.hint":
    "Repositories agents picked that no author installation reaches now. GitHub requests of agents using them are refused.",
  "github.outside.badge": "Not installed",
  "github.outside.unchecked": "Not checked",
  "github.repo.editTitle": "Change the default branch",
  "github.addDialog.title": "Add a GitHub App",
  "github.addDialog.hint":
    "Enter the ID and private key of an App made on GitHub. Saving asks GitHub for the App's name, permissions and installations. GitHub keeps only the public half of a key, so without the old .pem, make a new one under the App's settings › Private keys.",
  "github.addDialog.role": "Role",
  "github.addDialog.authorHint": "Clones, pushes and opens pull requests.",
  "github.addDialog.reviewerHint": "Must be another App than the author's.",
  "github.addDialog.taken":
    "An App is connected. Disconnect it in the danger zone to change it.",
  "github.addDialog.full":
    "Both an author and a reviewer App are connected. To change one, disconnect it in the danger zone, then add the other App.",
  "github.addDialog.submit": "Add",
  "github.addDialog.close": "Close",
  "github.rotate.title": "Replace the key of {name}",
  "github.rotate.hint":
    "Enter a private key made for the same App. Once GitHub accepts it, it is used instead of the old one.",
  "github.rotate.appIdHint": "The App whose key is replaced.",
  "github.rotate.submit": "Check and replace",
  "github.disconnect.row": "Disconnect {name}",
  "github.disconnect.action": "Disconnect",
  "github.disconnect.title": "Disconnect {name}?",
  "github.disconnect.done": "Disconnected {name}.",
  "github.disconnect.authorHint":
    "Until an App is added again, agents' clone, push and pull request requests and running sessions' GitHub requests are refused. The App and its installations stay on GitHub.",
  "github.disconnect.reviewerHint":
    "Until an App is added again, agents' review requests are refused. The App and its installations stay on GitHub.",
  "github.disconnect.userLink": "Members' account linking stops too.",
  "github.app": "GitHub App",
  "github.appHint":
    "Agents clone, push, open pull requests and run Actions with this one App. Its permissions live on GitHub; here they are compared with what the platform needs.",
  "github.unset": "Not registered",
  "github.unsetLine":
    "Register the App ID and private key, then install the App on repositories.",
  "github.connected": "Key verified",
  "github.summary.label": "Connection summary",
  "github.summary.accounts": "Connected GitHub accounts",
  "github.summary.accountsValue": "{count}",
  "github.summary.repositoriesValue": "{count}",
  "github.summary.needsCheck": "{count} to check",
  "github.summary.userLink": "Member account linking",
  "github.summary.ready": "Ready",
  "github.summary.setupNeeded": "Needs setup",
  "github.checkFailed": "Check failed",
  "github.unreachable":
    "GitHub could not be reached, so the installations were not checked. Open this page again shortly.",
  "github.rejectedNow":
    "GitHub no longer accepts this App. If the App was deleted or its key revoked, register it again with a new key.",
  "github.appLine": "App ID {id} · key saved {at} by {by}",
  "github.appLineAt": "App ID {id} · key saved {at}",
  "github.register": "Register",
  "github.replace": "Replace",
  "github.install": "Install on GitHub",
  "github.manageRepositories": "Manage repositories on GitHub",
  "github.appId": "App ID",
  "github.appIdHint":
    "The number at the top of the GitHub App's settings page.",
  "github.appIdMissing": "Enter the App ID as a number.",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "The key is checked with GitHub, then stored encrypted and never shown again. Delete the downloaded file once it is saved.",
  "github.keyMissing": "Choose the .pem file.",
  "github.save": "Check and save",
  "github.addExisting": "Add an existing App",
  "github.addExistingHint":
    "If your organization already has a GitHub App, connect it with its App ID and private key file. GitHub keeps only the public part of a key, so a .pem you downloaded before cannot be downloaded again. Without the file, generate a new one under the App's settings › Private keys.",
  "github.privateKeysLink": "GitHub docs: managing private keys",
  "github.connect": "Connect",
  "github.connectNote":
    "Once connected, the App's permissions and installations are read from GitHub and shown here.",
  "github.saved": "Saved the GitHub App.",
  "github.invalidKey":
    "This file is not an RSA private key. Choose the .pem file from the GitHub App's Private keys.",
  "github.rejected":
    "GitHub did not accept this App ID and key. Check the App ID and that the key belongs to that App.",
  "github.saveUnreachable":
    "GitHub could not be reached, so nothing was saved. Try again shortly.",
  "github.installations": "Installed on",
  "github.installationsEmpty": "Not installed anywhere yet.",
  "github.installationLine": "{selection} · {count} agent repositories",
  "github.installationApproved": "Permissions approved",
  "github.selectionAll": "All repositories",
  "github.selectionSelected": "Selected repositories",
  "github.openOnGitHub": "View on GitHub",
  "github.repositories": "Repositories agents use",
  "github.repositoriesHint":
    "Repositories the App is installed on are read from GitHub's installation list, without registering them. Each agent's repositories are picked on its GitHub tab.",
  "github.repositoriesByAccount": "Repositories by account ↓",
  "github.repositoriesEmpty":
    "No agent has picked a repository yet. Pick one the App is installed on from an agent's GitHub tab and it shows here.",
  "github.repositoriesFoot":
    "Picks and branch changes are kept in the audit record (receipts). Repositories imported once from config/repositories.yaml are edited here too. Repositories that need a login secret stay in the operator's file.",
  "github.repo.browse": "Browse installed repositories",
  "github.repo.pickTitle": "Repositories the App is installed on",
  "github.repo.pickHint":
    "The repositories GitHub lets the App's installation reach. If one is missing, add it to the App's installation on GitHub.",
  "github.repo.pickEmpty": "This installation reaches no repository.",
  "github.repo.pickNoApp": "Register the author App first.",
  "github.repo.pickFileHeld":
    "The operator's file already lists this repository with its own credential. Use that entry from the list.",
  "github.repo.pickNameHeld":
    "Another repository's entry still holds this name. Pick that repository, renamed on GitHub, once first and its entry takes the new name.",
  "github.repo.pickNoInstallation":
    "The App is not installed anywhere yet. Install it on GitHub.",
  "github.repo.installationReviewer": "{account} (reviewer App)",
  "github.repo.installation": "Installation",
  "github.repo.pageOf": "{from}–{to} of {total}",
  "github.repo.previousPage": "Previous",
  "github.repo.nextPage": "Next",
  "github.repo.agentCount": "Used by {count} agents",
  "github.repo.private": "Private",
  "github.repo.branch": "Default branch",
  "github.repo.branchHint":
    "Sessions start from this branch. A change refuses the next repository request of sessions running on it.",
  "github.repo.branchInvalid": "That is not a valid branch name.",
  "github.repo.edit": "Edit",
  "github.repo.save": "Save",
  "github.repo.editName": "Edit {name}",
  "github.repo.saved": "{name} now starts from {branch}.",
  "github.repo.conflict":
    "Someone changed this repository first. Check the values just read and save again.",
  "github.repo.file": "Operator file",
  "github.repo.fileHint":
    "A repository in the operator's file. It is not changed from the console.",
  "github.repo.seed": "From yaml",
  "github.installed": "Installed",
  "github.notInstalled": "Not installed",
  "github.unknown": "Unknown",
  "github.delete": "Delete the GitHub App",
  "github.deleteHint":
    "Until an App is registered again, repositories that use it cannot be cloned, pushed to or get pull requests. The App and its installations stay on GitHub.",
  "github.deleteTitle": "Delete the GitHub App?",
  "github.deleted": "Deleted the GitHub App.",
  "github.replaceRow": "Replace the GitHub App",
  "github.replaceRowHint":
    "Registers an App ID and private key again. The next step shows what changes.",
  "github.replaceHint":
    "Registers an App ID and private key again. Switching to another App stops clones, pushes and pull requests on repositories it is not installed on, and clears the Client secret for linking user accounts.",
  "github.replaceTitle": "Replace the GitHub App?",
  "github.replaceNext": "Next, choose the new App ID and private key.",
  "github.newTab": "(opens in a new tab)",
  "github.permissions.title": "Permissions",
  "github.permissions.hint": "problems first",
  "github.permissions.unread":
    "The permissions have not been read from GitHub yet. They are read when an owner or admin opens this page.",
  "github.permissions.waiting": "Reading what the platform needs.",
  "github.permissions.col.name": "Permission",
  "github.permissions.col.need": "Needed",
  "github.permissions.col.app": "App",
  "github.permissions.col.status": "Status",
  "github.permissions.levelNone": "none",
  "github.permissions.use.base": "default",
  "github.permissions.use.actions": "for running Actions",
  "github.permissions.use.actionsOff": "needed once Run Actions is on",
  "github.permissions.use.workflows": "for changing workflow files",
  "github.permissions.use.workflowsOff":
    "needed once Change workflow files is on",
  "github.permissions.use.none": "the platform never uses it",
  "github.permissions.status.missing": "Not on the App",
  "github.permissions.status.short": "App holds less",
  "github.permissions.status.wide": "Wider than needed",
  "github.permissions.status.ok": "Matches",
  "github.permissions.foot":
    "Permissions are changed in the App's settings on GitHub. After a change, each account approves it on its installation before tokens carry it.",
  "github.permissions.wideTitle": "The author App holds more than the guidance",
  "github.permissions.wideBody":
    "{list}. The platform issues no token with these, but a leaked key could use them on GitHub. Remove them in the App's settings on GitHub and approve the change on the installation.",
  "github.permissions.level.read": "read",
  "github.permissions.level.write": "write",
  "github.permissions.level.admin": "admin",
  "github.permissions.name.contents": "Contents",
  "github.permissions.name.pull_requests": "Pull requests",
  "github.permissions.name.metadata": "Metadata",
  "github.permissions.name.actions": "Actions",
  "github.permissions.name.checks": "Checks",
  "github.permissions.name.issues": "Issues",
  "github.permissions.name.workflows": "Workflows",
  "github.permissions.name.administration": "Administration",
  "github.ceiling.title": "Most an agent may turn on",
  "github.ceiling.hint":
    "An agent's GitHub tab turns on only what is allowed here. Each feature's token comes from the App named over its group; allowed here, it is still refused by GitHub if that App lacks the permission. Lowering it refuses agents that already use it from their next GitHub request.",
  "github.ceiling.groupAuthor": "With {name}'s permissions",
  "github.ceiling.groupAuthorUnset": "With the author App's permissions",
  "github.ceiling.groupReviewer": "With the reviewer App's permissions",
  "github.ceiling.viewApp": "View App permissions ↑",
  "github.ceiling.needLabel": "App permission needed",
  "github.ceiling.heldOk": "held",
  "github.ceiling.heldShort": "App has {level}",
  "github.ceiling.heldNone": "not on the App",
  "github.ceiling.appShort": "App lacks permission",
  "github.ceiling.base": "Write pull requests",
  "github.ceiling.baseBadge": "Default",
  "github.ceiling.baseHint":
    "Clone, push, open and comment on pull requests. Every agent that uses GitHub has it.",
  "github.ceiling.always": "Always on",
  "github.ceiling.feature.review": "Review pull requests",
  "github.ceiling.feature.reviewHint":
    "Leave comments, change requests and approvals on pull requests. Needs a reviewer App.",
  "github.ceiling.feature.actions": "Run Actions",
  "github.ceiling.feature.actionsHint":
    "Run or rerun the workflows on an agent's allow list.",
  "github.ceiling.feature.workflows": "Change workflow files",
  "github.ceiling.feature.workflowsHint":
    "Push commits that change files under .github/workflows.",
  "github.ceiling.agentsUsing":
    "{count} agents turn it on in their active release",
  "github.ceiling.allowed": "Allowed",
  "github.ceiling.denied": "Not allowed",
  "github.ceiling.receiptNote":
    "A change is kept in the audit log (receipt). Writing checks and issues have no work behind them yet, so they are not listed.",
  "github.ceiling.revert": "Revert",
  "github.ceiling.saved": "Saved what agents may turn on.",
  "github.ceiling.conflict":
    "Someone changed the features first. The switches they changed are marked; check them and save again.",
  "github.ceiling.lowerTitle": "Lower what agents may turn on?",
  "github.ceiling.lowerBody":
    "Turns off: {features}. Sessions still on an earlier release are refused from their next GitHub request too.",
  "github.ceiling.lowerItem":
    "{feature} ({count} agents in their active release)",
  "github.ceiling.lowerConfirm": "Lower and save",
  "github.approvalPending": "Permission change pending",
  "github.sameAsReviewer":
    "This App is registered as the reviewer App. The author App must be a different App.",
  "github.reviewer.title": "Reviewer App",
  "github.reviewer.hint":
    "For agents to review pull requests (comments and approvals), a second App is needed: GitHub does not take an approval from the account that opened the pull request. Without one, people review.",
  "github.reviewer.advanced": "Advanced",
  "github.reviewer.advancedUnset": "Advanced · not registered",
  "github.reviewer.open": "Open settings",
  "github.reviewer.close": "Close",
  "github.reviewer.app": "Reviewer App",
  "github.reviewer.unsetLine":
    "Once registered, review approval can be turned on in an agent's GitHub tab.",
  "github.reviewer.permissionsTitle": "Recommended permissions",
  "github.reviewer.permissions":
    "Contents read, Pull requests read & write, Metadata read. Install it on the repositories it reviews.",
  "github.reviewer.riskTitle": "One agent opening and approving",
  "github.reviewer.risk":
    "An agent can approve, with this App, a pull request it opened with the author App; the platform does not stop it. Where one review is required, that approval alone can meet the rule. If a person's review must be required, require two or more reviewers on GitHub, or a person's review through CODEOWNERS.",
  "github.reviewer.saved": "Saved the reviewer App.",
  "github.reviewer.sameApp":
    "The author App cannot also be the reviewer App. Create a separate reviewer App and register it.",
  "github.reviewer.noAuthorApp":
    "Register the author App before the reviewer App.",
  "github.reviewer.delete": "Delete reviewer App",
  "github.reviewer.deleteHint":
    "Agents' review requests are refused until it is registered again. The App and its installations stay on GitHub.",
  "github.reviewer.deleteTitle": "Delete the reviewer App?",
  "github.reviewer.deleted": "Deleted the reviewer App.",
  "github.reviewer.replaceRow": "Replace the reviewer App",
  "github.reviewer.replaceHint":
    "Registers an App ID and private key again. Switching to another App refuses review requests on repositories it is not installed on.",
  "github.reviewer.replaceTitle": "Replace the reviewer App?",
};

export const githubJa: Record<keyof typeof githubKo, string> = {
  "github.nav": "GitHub 連携設定",
  "github.description":
    "エージェントが GitHub リポジトリに使う App、ワークスペースが許可する機能、App ごとの権限とインストール済みリポジトリです。",
  "github.descriptionMember":
    "エージェントが GitHub リポジトリに使う App と、ワークスペースが許可した機能です。オーナーと管理者が変更できます。",
  "github.add": "App を追加",
  "github.added": "{name} を追加しました。",
  "github.rotated": "{name} のキーを交換しました。",
  "github.empty.title":
    "GitHub App を追加すると、エージェントがリポジトリを使えます",
  "github.empty.hint":
    "作成用 App で clone・push・PR を行い、レビュー承認用 App で PR にレビューを残します。",
  "github.role.author.title": "作成用 App",
  "github.role.author.hint":
    "エージェントがリポジトリを clone し、承認された結果を push し、PR を開くときに使う App です。",
  "github.role.author.badge": "作成用",
  "github.role.author.features": "作成用 App で有効にできる機能",
  "github.role.author.add": "作成用 App を追加",
  "github.role.author.none": "作成用 App はありません。",
  "github.role.reviewer.title": "レビュー承認用 App",
  "github.role.reviewer.hint":
    "エージェントが PR にレビューを残すときに使う App です。GitHub は PR を開いた App の承認を受け付けないため、作成用とは別の App にしてください。",
  "github.role.reviewer.badge": "レビュー承認用",
  "github.role.reviewer.features": "レビュー承認用 App で有効にできる機能",
  "github.role.reviewer.add": "レビュー承認用 App を追加",
  "github.role.reviewer.none": "レビュー承認用 App はありません。",
  "github.ceiling.baseMeta": "GitHub を使うすべてのエージェント",
  "github.ceiling.unsaved": "未保存",
  "github.ceiling.theirs": "ほかの人が変更",
  "github.ceiling.footChanged":
    "{role} の機能を {count} 件変更します。保存すると下の表の必要な権限がこのとおり適用され、変更記録に残ります。",
  "github.ceiling.footLowered":
    "無効にする機能を有効にしたエージェント({list})は、次の GitHub リクエストから拒否されます。",
  "github.ceiling.save": "保存",
  "github.card.keyRejected": "キー拒否",
  "github.card.memberLine": "App ID {id}",
  "github.card.settings": "GitHub で App 設定",
  "github.card.rotate": "キーを交換",
  "github.card.rotateName": "{name} のキーを交換",
  "github.card.lackingTitle": "この App に {list} の権限がありません",
  "github.card.lackingNow": "有効にした機能のリクエストを GitHub が拒否します。",
  "github.card.lackingDraft":
    "このまま保存すると、有効にした機能のリクエストを GitHub が拒否します。",
  "github.card.lackingFix":
    "GitHub の App 設定で権限を追加し、インストールごとに変更を承認してください。",
  "github.card.accounts": "{name} をインストールした GitHub アカウント",
  "github.card.selectionAll": "すべてのリポジトリ {count} 件",
  "github.card.selectionSelected": "選択したリポジトリ {count} 件",
  "github.card.manageInstallation": "GitHub でインストールを管理",
  "github.card.noInstallation":
    "この App をインストールした GitHub アカウントはありません。",
  "github.permissions.col.install": "インストール",
  "github.permissions.changedRow": "(未保存の変更)",
  "github.permissions.pendingCell": "(承認待ち)",
  "github.permissions.folded":
    "必要 {need} · App {app} · インストール {granted}",
  "github.permissions.changedNote":
    "青い行は、保存していない機能の変更で変わった必要な権限です: {list}。",
  "github.permissions.status.beyond": "ガイドより広い",
  "github.permissions.status.unused": "現在は不要",
  "github.permissions.status.pending": "インストールの承認待ち",
  "github.repos.title": "インストール済みリポジトリ",
  "github.repos.col.name": "リポジトリ",
  "github.repos.col.branch": "デフォルトブランチ",
  "github.repos.col.agents": "選んだエージェント",
  "github.repos.agents": "{count} 件",
  "github.repos.empty": "このインストールが届くリポジトリはありません。",
  "github.repos.range": "{from}–{to} / {total}",
  "github.repos.pages": "{page} / {pages}",
  "github.repos.nav": "{label} のリポジトリのページ",
  "github.repos.previous": "{label} の前のページ",
  "github.repos.next": "{label} の次のページ",
  "github.repos.retry": "再試行",
  "github.repos.unavailable.title":
    "GitHub からリポジトリ一覧を受け取れませんでした",
  "github.repos.unavailable.body":
    "しばらくしてから再試行してください。保存された設定とエージェントの実行には影響しません。",
  "github.repos.auth.title": "この App のキーを GitHub が受け付けません",
  "github.repos.auth.body":
    "GitHub の App 設定で新しい private key を作成し、キーを交換してください。",
  "github.repos.suspended.title": "このインストールは GitHub で停止されています",
  "github.repos.suspended.body":
    "インストール管理で再開するまで、このアカウントのリポジトリへのリクエストは拒否されます。",
  "github.outside.title": "インストール外のリポジトリ",
  "github.outside.hint":
    "エージェントが選んだことはあるが、今はどの作成用インストールも届かないリポジトリです。これを使うエージェントの GitHub リクエストは拒否されます。",
  "github.outside.badge": "インストール外",
  "github.outside.unchecked": "未確認",
  "github.repo.editTitle": "デフォルトブランチを変更",
  "github.addDialog.title": "GitHub App を追加",
  "github.addDialog.hint":
    "GitHub で作成した App の ID と private key を入力します。保存すると GitHub に問い合わせて App の名前・権限・インストールを読み込みます。GitHub はキーの公開部分しか保管しないため、以前の .pem がなければ App 設定 › Private keys で新しく作成してください。",
  "github.addDialog.role": "用途",
  "github.addDialog.authorHint": "clone・push・PR に使います。",
  "github.addDialog.reviewerHint": "作成用とは別の App にしてください。",
  "github.addDialog.taken":
    "接続済みの App があります。変更するには危険な操作で接続を解除してください。",
  "github.addDialog.full":
    "作成用とレビュー承認用の App がどちらも接続されています。別の App に変えるには、危険な操作で今の App の接続を解除してから追加してください。",
  "github.addDialog.submit": "追加",
  "github.addDialog.close": "閉じる",
  "github.rotate.title": "{name} のキーを交換",
  "github.rotate.hint":
    "同じ App で新しく作成した private key を入力します。GitHub が受け付けると、以前のキーの代わりに使います。",
  "github.rotate.appIdHint": "キーを交換する App です。",
  "github.rotate.submit": "確認して交換",
  "github.disconnect.row": "{name} の接続を解除",
  "github.disconnect.action": "接続を解除",
  "github.disconnect.title": "{name} の接続を解除しますか?",
  "github.disconnect.done": "{name} の接続を解除しました。",
  "github.disconnect.authorHint":
    "再び追加するまで、エージェントの clone・push・PR リクエストと実行中セッションの GitHub リクエストは拒否されます。GitHub の App とインストールはそのまま残ります。",
  "github.disconnect.reviewerHint":
    "再び追加するまで、エージェントのレビューリクエストは拒否されます。GitHub の App とインストールはそのまま残ります。",
  "github.disconnect.userLink": "メンバーのアカウント連携も切れます。",
  "github.app": "GitHub App",
  "github.appHint":
    "エージェントはこの App 一つで clone・push・PR・Actions を行います。権限の元は GitHub にあり、ここではプラットフォームが必要とする水準と比べて表示します。",
  "github.unset": "未登録",
  "github.unsetLine":
    "App ID と private key を登録すると、リポジトリにインストールできます。",
  "github.connected": "鍵確認済み",
  "github.summary.label": "連携の概要",
  "github.summary.accounts": "連携した GitHub アカウント",
  "github.summary.accountsValue": "{count} 件",
  "github.summary.repositoriesValue": "{count} 件",
  "github.summary.needsCheck": "{count} 件 要確認",
  "github.summary.userLink": "メンバーのアカウント連携",
  "github.summary.ready": "準備完了",
  "github.summary.setupNeeded": "設定が必要",
  "github.checkFailed": "確認失敗",
  "github.unreachable":
    "GitHub に接続できず、インストール状態を確認できませんでした。しばらくしてから開き直してください。",
  "github.rejectedNow":
    "GitHub がこの App を受け付けません。App が削除されたか鍵が失効した場合は、新しい鍵で登録し直してください。",
  "github.appLine": "App ID {id} · 鍵を {at} に保存 · 保存した人 {by}",
  "github.appLineAt": "App ID {id} · 鍵を {at} に保存",
  "github.register": "登録",
  "github.replace": "置き換え",
  "github.install": "GitHub でインストール",
  "github.manageRepositories": "GitHub でリポジトリを管理",
  "github.appId": "App ID",
  "github.appIdHint": "GitHub App の設定ページ上部にある数字です。",
  "github.appIdMissing": "App ID を数字で入力してください。",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "鍵は GitHub で確認してから暗号化して保存し、保存後は二度と表示しません。保存したら、ダウンロードしたファイルは削除してください。",
  "github.keyMissing": ".pem ファイルを選んでください。",
  "github.save": "確認して保存",
  "github.addExisting": "既存の App を追加",
  "github.addExistingHint":
    "組織で使っている GitHub App があれば、App ID と秘密鍵ファイルで接続します。GitHub は鍵の公開部分しか保管しないため、以前取得した .pem を再ダウンロードすることはできません。ファイルがなければ App 設定 › Private keys で新しく作成してください。",
  "github.privateKeysLink": "GitHub ドキュメント: 秘密鍵の管理",
  "github.connect": "接続",
  "github.connectNote":
    "接続すると、GitHub から権限とインストールをすぐに読み取ってこの画面に表示します。",
  "github.saved": "GitHub App を保存しました。",
  "github.invalidKey":
    "このファイルは RSA private key ではありません。GitHub App の Private keys から取得した .pem ファイルを選んでください。",
  "github.rejected":
    "GitHub がこの App ID と鍵を受け付けませんでした。App ID と、その App の鍵かどうかを確認してください。",
  "github.saveUnreachable":
    "GitHub に接続できなかったため、保存しませんでした。しばらくしてから再試行してください。",
  "github.installations": "インストール先の GitHub アカウント",
  "github.installationsEmpty": "まだどこにもインストールされていません。",
  "github.installationLine":
    "{selection} · エージェントのリポジトリ {count} 件",
  "github.installationApproved": "権限承認済み",
  "github.selectionAll": "すべてのリポジトリ",
  "github.selectionSelected": "選択したリポジトリのみ",
  "github.openOnGitHub": "GitHub で見る",
  "github.repositories": "エージェントが使うリポジトリ",
  "github.repositoriesHint":
    "App がインストールされたリポジトリは、登録せずに GitHub のインストール一覧から読み取ります。エージェントごとのリポジトリはエージェントの GitHub タブで選びます。",
  "github.repositoriesByAccount": "アカウント別のリポジトリ ↓",
  "github.repositoriesEmpty":
    "まだエージェントが選んだリポジトリはありません。エージェントの GitHub タブで App がインストールされたリポジトリを選ぶと、ここに表示されます。",
  "github.repositoriesFoot":
    "選択とブランチ変更は監査記録(receipt)に残ります。最初に config/repositories.yaml から取り込んだリポジトリもここで編集します。ログイン用の秘密値が必要なリポジトリは運用者が設定ファイルで管理します。",
  "github.repo.browse": "インストール済みのリポジトリを見る",
  "github.repo.pickTitle": "App がインストールされたリポジトリ",
  "github.repo.pickHint":
    "GitHub が App のインストールに許可したリポジトリです。一覧にない場合は GitHub で App のインストールにリポジトリを加えてください。",
  "github.repo.pickEmpty":
    "このインストールで許可されたリポジトリはありません。",
  "github.repo.pickNoApp": "先に作成用 App を登録してください。",
  "github.repo.pickFileHeld":
    "運用者の設定ファイルが独自の認証情報でこのリポジトリをすでに登録しています。一覧のその項目を使ってください。",
  "github.repo.pickNameHeld":
    "同じ名前を使っていた別のリポジトリの項目が残っています。GitHub で名前が変わったそのリポジトリを先に一度選ぶと、項目が新しい名前になります。",
  "github.repo.pickNoInstallation":
    "App はまだどこにもインストールされていません。GitHub で App をインストールしてください。",
  "github.repo.installationReviewer": "{account}(レビュー用 App)",
  "github.repo.installation": "インストール先",
  "github.repo.pageOf": "{total} 件中 {from}–{to}",
  "github.repo.previousPage": "前へ",
  "github.repo.nextPage": "次へ",
  "github.repo.agentCount": "{count} 件のエージェントが使用",
  "github.repo.private": "非公開",
  "github.repo.branch": "デフォルトブランチ",
  "github.repo.branchHint":
    "セッションはこのブランチから始まります。変えると、このリポジトリで実行中のセッションは次のリポジトリ要求から拒否されます。",
  "github.repo.branchInvalid": "ブランチ名が正しくありません。",
  "github.repo.edit": "編集",
  "github.repo.save": "保存",
  "github.repo.editName": "{name} を編集",
  "github.repo.saved": "{name} のデフォルトブランチを {branch} に変えました。",
  "github.repo.conflict":
    "ほかの場所で先にこのリポジトリが変更されました。読み直した値を確かめて、もう一度保存してください。",
  "github.repo.file": "設定ファイル",
  "github.repo.fileHint":
    "運用者の設定ファイルにあるリポジトリです。コンソールからは変更しません。",
  "github.repo.seed": "yaml から取り込み",
  "github.installed": "インストール済み",
  "github.notInstalled": "未インストール",
  "github.unknown": "不明",
  "github.delete": "GitHub App を削除",
  "github.deleteHint":
    "再登録するまで、この App を使うリポジトリは clone・push・PR ができません。GitHub 上の App とインストールはそのまま残ります。",
  "github.deleteTitle": "GitHub App を削除しますか?",
  "github.deleted": "GitHub App を削除しました。",
  "github.replaceRow": "GitHub App を置き換え",
  "github.replaceRowHint":
    "App ID と private key を登録し直します。影響は次の手順で確認します。",
  "github.replaceHint":
    "App ID と private key を登録し直します。別の App に替えると、新しい App がインストールされていないリポジトリは clone・push・PR ができなくなり、ユーザーアカウント連携の Client secret は消去されます。",
  "github.replaceTitle": "GitHub App を置き換えますか?",
  "github.replaceNext": "次の手順で新しい App ID と private key を選びます。",
  "github.newTab": "(新しいタブで開きます)",
  "github.permissions.title": "権限",
  "github.permissions.hint": "問題のある権限が上に来ます",
  "github.permissions.unread":
    "まだ GitHub から権限を読んでいません。オーナーか管理者がこの画面を開くと読みます。",
  "github.permissions.waiting": "必要な水準を読み込んでいます。",
  "github.permissions.col.name": "権限",
  "github.permissions.col.need": "必要",
  "github.permissions.col.app": "App",
  "github.permissions.col.status": "状態",
  "github.permissions.levelNone": "なし",
  "github.permissions.use.base": "基本",
  "github.permissions.use.actions": "Actions の実行に使う",
  "github.permissions.use.actionsOff": "Actions の実行を有効にすると使う",
  "github.permissions.use.workflows": "ワークフローファイルの変更に使う",
  "github.permissions.use.workflowsOff":
    "ワークフローファイルの変更を有効にすると使う",
  "github.permissions.use.none": "プラットフォームは使わない",
  "github.permissions.status.missing": "App にない",
  "github.permissions.status.short": "App で不足",
  "github.permissions.status.wide": "必要より広い",
  "github.permissions.status.ok": "一致",
  "github.permissions.foot":
    "権限は GitHub の App 設定で変更します。変更後、アカウントごとにインストールで承認すると、トークンに入ります。",
  "github.permissions.wideTitle": "作成用 App が案内より広い権限を持っています",
  "github.permissions.wideBody":
    "{list}。プラットフォームはこの権限でトークンを発行しませんが、鍵が漏れると GitHub では使えます。GitHub の App 設定で外し、インストールで権限の変更を承認してください。",
  "github.permissions.level.read": "読み取り",
  "github.permissions.level.write": "書き込み",
  "github.permissions.level.admin": "管理",
  "github.permissions.name.contents": "リポジトリの内容",
  "github.permissions.name.pull_requests": "Pull request",
  "github.permissions.name.metadata": "メタデータ",
  "github.permissions.name.actions": "Actions",
  "github.permissions.name.checks": "Checks",
  "github.permissions.name.issues": "Issues",
  "github.permissions.name.workflows": "Workflows",
  "github.permissions.name.administration": "Administration",
  "github.ceiling.title": "エージェントが有効にできる最大の権限",
  "github.ceiling.hint":
    "エージェントの GitHub タブは、ここで許可した機能だけを有効にできます。機能はグループの見出しにある App の権限でトークンを受け取ります。ここで許可しても App に権限がなければ GitHub が拒否します。下げると、すでに有効にしたエージェントも次の GitHub リクエストから拒否されます。",
  "github.ceiling.groupAuthor": "{name} の権限で",
  "github.ceiling.groupAuthorUnset": "作成用 App の権限で",
  "github.ceiling.groupReviewer": "レビュー承認用 App の権限で",
  "github.ceiling.viewApp": "App の権限を見る ↑",
  "github.ceiling.needLabel": "必要な App の権限",
  "github.ceiling.heldOk": "あり",
  "github.ceiling.heldShort": "App は {level}",
  "github.ceiling.heldNone": "App にない",
  "github.ceiling.appShort": "App の権限不足",
  "github.ceiling.base": "PR の作成・修正",
  "github.ceiling.baseBadge": "基本",
  "github.ceiling.baseHint":
    "clone、push、PR の作成・コメント。GitHub を使うすべてのエージェントが持ちます。",
  "github.ceiling.always": "常に有効",
  "github.ceiling.feature.review": "PR レビュー",
  "github.ceiling.feature.reviewHint":
    "PR にコメント・変更依頼・承認のレビューを残します。レビュー承認用 App を登録すると有効にできます。",
  "github.ceiling.feature.actions": "Actions の実行",
  "github.ceiling.feature.actionsHint":
    "エージェントの許可リストにあるワークフローを実行・再実行します。",
  "github.ceiling.feature.workflows": "ワークフローファイルの変更",
  "github.ceiling.feature.workflowsHint":
    ".github/workflows 以下のファイルを変えた commit も push します。",
  "github.ceiling.agentsUsing":
    "有効なリリースで有効にしたエージェント {count} 件",
  "github.ceiling.allowed": "許可",
  "github.ceiling.denied": "許可しない",
  "github.ceiling.receiptNote":
    "変更は監査記録(receipt)に残ります。チェック結果と Issue の書き込みは、まだ作業がないため一覧から外しました。",
  "github.ceiling.revert": "元に戻す",
  "github.ceiling.saved": "機能の設定を保存しました。",
  "github.ceiling.conflict":
    "ほかの人が先に機能の設定を変更しました。変更された項目に印を付けたので、確認してからもう一度保存してください。",
  "github.ceiling.lowerTitle": "機能を無効にしますか?",
  "github.ceiling.lowerBody":
    "{features} の権限を無効にします。以前のリリースで動いているセッションも、次の GitHub リクエストから拒否されます。",
  "github.ceiling.lowerItem":
    "{feature}(有効なリリースで有効にしたエージェント {count} 件)",
  "github.ceiling.lowerConfirm": "下げて保存",
  "github.approvalPending": "権限変更の承認待ち",
  "github.sameAsReviewer":
    "レビュー用 App として登録されている App です。作成用 App は別の App にしてください。",
  "github.reviewer.title": "レビュー承認用 App",
  "github.reviewer.hint":
    "エージェントが PR にレビュー(コメント・承認)を残すには、上の App とは別の App がもう一つ必要です。GitHub は PR を開いたアカウントの承認を受け付けないためです。登録しなければ、レビューは人が行います。",
  "github.reviewer.advanced": "詳細",
  "github.reviewer.advancedUnset": "詳細 · 未登録",
  "github.reviewer.open": "設定を開く",
  "github.reviewer.close": "閉じる",
  "github.reviewer.app": "レビュー用 App",
  "github.reviewer.unsetLine":
    "登録すると、エージェントの GitHub タブでレビュー承認を有効にできます。",
  "github.reviewer.permissionsTitle": "推奨する権限",
  "github.reviewer.permissions":
    "Contents 読み取り、Pull requests 読み取り・書き込み、Metadata 読み取り。レビューするリポジトリにインストールしてください。",
  "github.reviewer.riskTitle": "同じエージェントによる作成と承認",
  "github.reviewer.risk":
    "同じエージェントが作成用 App で開いた PR を、この App で承認できます。プラットフォームはこれを止めません。必須レビューが 1 人のリポジトリでは、その承認だけでマージ条件が満たされることがあります。人のレビューが必ず必要なら、GitHub で必須レビュアーを 2 人以上にするか、CODEOWNERS で人のレビューを求めてください。",
  "github.reviewer.saved": "レビュー用 App を保存しました。",
  "github.reviewer.sameApp":
    "作成用 App と同じ App はレビュー用に登録できません。レビュー用 App を別に作って登録してください。",
  "github.reviewer.noAuthorApp":
    "レビュー用 App を登録する前に、作成用 App を登録してください。",
  "github.reviewer.delete": "レビュー用 App を削除",
  "github.reviewer.deleteHint":
    "再登録するまで、エージェントのレビューリクエストは拒否されます。GitHub の App とインストールはそのまま残ります。",
  "github.reviewer.deleteTitle": "レビュー用 App を削除しますか?",
  "github.reviewer.deleted": "レビュー用 App を削除しました。",
  "github.reviewer.replaceRow": "レビュー用 App を置き換え",
  "github.reviewer.replaceHint":
    "App ID と private key を登録し直します。別の App に替えると、新しい App がインストールされていないリポジトリのレビューリクエストは拒否されます。",
  "github.reviewer.replaceTitle": "レビュー用 App を置き換えますか?",
};
