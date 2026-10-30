export const githubKo = {
  "github.nav": "GitHub 연결 설정",
  "github.description":
    "에이전트가 GitHub 저장소를 clone하고, 승인된 결과를 push하고, PR을 열 때 쓰는 GitHub App입니다. 소유자와 관리자만 바꿀 수 있습니다.",
  "github.app": "GitHub App",
  "github.appHint":
    "워크스페이스에 App 하나를 등록합니다. GitHub의 App 설정에서 App ID를 확인하고, Private keys에서 받은 .pem 파일을 고르세요.",
  "github.unset": "등록 안 됨",
  "github.unsetLine":
    "App ID와 private key를 등록하면 저장소에 설치할 수 있습니다.",
  "github.connected": "연결됨",
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
  "github.appId": "App ID",
  "github.appIdHint": "GitHub App 설정 페이지 위쪽에 있는 숫자입니다.",
  "github.appIdMissing": "App ID를 숫자로 넣어 주세요.",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "키는 GitHub에서 확인한 뒤 암호화해 저장하고, 저장한 뒤에는 다시 보여 주지 않습니다. 저장했으면 내려받은 파일은 지우세요.",
  "github.keyMissing": ".pem 파일을 골라 주세요.",
  "github.save": "확인하고 저장",
  "github.saved": "GitHub App을 저장했습니다.",
  "github.invalidKey":
    "이 파일은 RSA private key가 아닙니다. GitHub App 페이지의 Private keys에서 받은 .pem 파일을 고르세요.",
  "github.rejected":
    "GitHub가 이 App ID와 키를 받지 않았습니다. App ID와, 그 App에서 받은 키인지 확인하세요.",
  "github.saveUnreachable":
    "GitHub에 연결하지 못해 저장하지 않았습니다. 잠시 뒤 다시 시도하세요.",
  "github.installations": "설치",
  "github.installationsHint":
    "App이 설치된 GitHub 계정과 조직입니다. 저장소를 더하거나 빼려면 GitHub의 설치 설정에서 바꿉니다.",
  "github.installationsEmpty": "아직 어디에도 설치되지 않았습니다.",
  "github.selectionAll": "모든 저장소",
  "github.selectionSelected": "고른 저장소만",
  "github.openOnGitHub": "GitHub에서 보기",
  "github.repositories": "저장소",
  "github.repositoriesHint":
    "카탈로그에서 이 App을 쓰는 저장소(auth: kind github_app)입니다. 설치되지 않은 저장소는 세션을 시작할 때 clone하지 못합니다.",
  "github.repositoriesEmpty":
    "이 App을 쓰는 저장소가 카탈로그에 없습니다. 운영자가 config/repositories.yaml에 추가합니다.",
  "github.installed": "설치됨",
  "github.notInstalled": "설치 안 됨",
  "github.unknown": "확인 못 함",
  "github.delete": "GitHub App 삭제",
  "github.deleteHint":
    "다시 등록할 때까지 이 App을 쓰는 저장소는 clone·push·PR을 할 수 없습니다. GitHub의 App과 설치는 그대로 남습니다.",
  "github.deleteTitle": "GitHub App을 삭제할까요?",
  "github.deleted": "GitHub App을 삭제했습니다.",
  "github.newTab": "(새 탭에서 열림)",
  "github.permissions.title": "App 권한",
  "github.permissions.hint":
    "작성용 App이 GitHub에 요청한 권한을 마지막으로 읽은 값입니다. 플랫폼은 작업마다 필요한 권한만 골라 토큰을 발급합니다.",
  "github.permissions.unread":
    "아직 GitHub에서 권한을 읽지 않았습니다. 소유자나 관리자가 이 화면을 열면 읽습니다.",
  "github.permissions.notGuided": "안내에 없음 · 플랫폼이 쓰지 않음",
  "github.permissions.guidedDefault": "안내 {level} · 기본",
  "github.permissions.guidedOptional": "안내 {level} · 선택",
  "github.permissions.app": "App {level}",
  "github.permissions.appNone": "App에 없음",
  "github.permissions.appWide": "App {level} · 안내보다 넓음",
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
    "에이전트 GitHub 탭은 여기서 허용한 권한 안에서만 켭니다. 실행 프로필의 상한처럼 소유자와 관리자만 바꿉니다. 낮추면 이미 켠 에이전트도 다음 GitHub 요청부터 거절됩니다.",
  "github.ceiling.base": "PR 작성·수정",
  "github.ceiling.baseBadge": "기본",
  "github.ceiling.baseHint":
    "clone, push, PR 열기·코멘트. GitHub를 쓰는 모든 에이전트가 가집니다.",
  "github.ceiling.always": "항상 켜짐",
  "github.ceiling.feature.review": "리뷰 승인",
  "github.ceiling.feature.reviewHint":
    "리뷰용 App으로 PR에 승인 리뷰를 남깁니다.",
  "github.ceiling.feature.actions": "Actions 실행",
  "github.ceiling.feature.actionsHint":
    "에이전트 허용 목록의 워크플로를 실행하거나 다시 실행합니다.",
  "github.ceiling.feature.checks": "검사 결과 쓰기",
  "github.ceiling.feature.checksHint": "check run을 만들고 결과를 올립니다.",
  "github.ceiling.feature.issues": "이슈 쓰기",
  "github.ceiling.feature.issuesHint": "이슈를 열고 코멘트를 남깁니다.",
  "github.ceiling.feature.workflows": "워크플로 파일 수정",
  "github.ceiling.feature.workflowsHint":
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다.",
  "github.ceiling.agentsUsing": "활성 릴리스에서 켠 에이전트 {count}개",
  "github.ceiling.appLacks":
    "App에 권한 없음 · 허용해도 GitHub가 토큰 발급을 거절합니다.",
  "github.ceiling.noReviewer":
    "리뷰용 App 없음 · 허용해도 리뷰 요청은 거절됩니다.",
  "github.ceiling.allowed": "허용",
  "github.ceiling.denied": "허용 안 함",
  "github.ceiling.receiptNote": "바꾸면 감사 기록(receipt)에 남습니다.",
  "github.ceiling.revert": "되돌리기",
  "github.ceiling.saved": "최대 권한을 저장했습니다.",
  "github.ceiling.conflict":
    "다른 사람이 먼저 최대 권한을 바꿨습니다. 지금 저장된 값을 다시 불러왔으니 확인하고 다시 저장하세요.",
  "github.ceiling.lowerTitle": "최대 권한을 낮출까요?",
  "github.ceiling.lowerBody":
    "{features} 권한을 끕니다. 앞 릴리스로 도는 세션도 다음 GitHub 요청부터 거절됩니다.",
  "github.ceiling.lowerItem":
    "{feature}(활성 릴리스에서 켠 에이전트 {count}개)",
  "github.ceiling.lowerConfirm": "낮추고 저장",
  "github.approvalPending": "설치 승인 대기",
  "github.sameAsReviewer":
    "리뷰용 App으로 등록된 App입니다. 작성용 App은 다른 App이어야 합니다.",
  "github.reviewer.title": "리뷰용 App (선택)",
  "github.reviewer.hint":
    "PR 승인 리뷰를 하려면 PR을 만드는 App과 다른 App이 필요합니다. GitHub는 PR을 연 App의 승인을 받지 않습니다.",
  "github.reviewer.app": "리뷰용 App",
  "github.reviewer.unsetLine":
    "등록하면 에이전트 GitHub 탭에서 리뷰 승인을 켤 수 있습니다.",
  "github.reviewer.permissionsTitle": "권장 권한",
  "github.reviewer.permissions":
    "Contents 읽기, Pull requests 읽기·쓰기, Metadata 읽기. 리뷰할 저장소에 설치하세요.",
  "github.reviewer.riskTitle": "같은 에이전트의 작성과 승인",
  "github.reviewer.risk":
    "같은 에이전트가 작성용 App으로 연 PR을 리뷰용 App으로 승인할 수 있고, 플랫폼은 이를 막지 않습니다. 필수 리뷰가 1명인 저장소에서는 이 승인으로 머지 조건이 채워집니다. GitHub에서 필수 리뷰어를 2명 이상으로 두거나, CODEOWNERS로 사람 리뷰를 요구하거나, 리뷰용 App을 ruleset 우회 목록에 넣지 마세요.",
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
};

export const githubEn: Record<keyof typeof githubKo, string> = {
  "github.nav": "GitHub connection",
  "github.description":
    "The GitHub App agents use to clone GitHub repositories, push approved results and open pull requests. Only owners and admins can change it.",
  "github.app": "GitHub App",
  "github.appHint":
    "Register one App for the workspace. Find the App ID in the App's settings on GitHub, and choose the .pem file from its Private keys.",
  "github.unset": "Not registered",
  "github.unsetLine":
    "Register the App ID and private key, then install the App on repositories.",
  "github.connected": "Connected",
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
  "github.appId": "App ID",
  "github.appIdHint":
    "The number at the top of the GitHub App's settings page.",
  "github.appIdMissing": "Enter the App ID as a number.",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "The key is checked with GitHub, then stored encrypted and never shown again. Delete the downloaded file once it is saved.",
  "github.keyMissing": "Choose the .pem file.",
  "github.save": "Check and save",
  "github.saved": "Saved the GitHub App.",
  "github.invalidKey":
    "This file is not an RSA private key. Choose the .pem file from the GitHub App's Private keys.",
  "github.rejected":
    "GitHub did not accept this App ID and key. Check the App ID and that the key belongs to that App.",
  "github.saveUnreachable":
    "GitHub could not be reached, so nothing was saved. Try again shortly.",
  "github.installations": "Installations",
  "github.installationsHint":
    "The GitHub accounts and organizations the App is installed on. Add or remove repositories in the installation's settings on GitHub.",
  "github.installationsEmpty": "Not installed anywhere yet.",
  "github.selectionAll": "All repositories",
  "github.selectionSelected": "Selected repositories",
  "github.openOnGitHub": "View on GitHub",
  "github.repositories": "Repositories",
  "github.repositoriesHint":
    "Catalog repositories that use this App (auth: kind github_app). A session cannot clone a repository the App is not installed on.",
  "github.repositoriesEmpty":
    "No catalog repository uses this App. An operator adds one in config/repositories.yaml.",
  "github.installed": "Installed",
  "github.notInstalled": "Not installed",
  "github.unknown": "Unknown",
  "github.delete": "Delete the GitHub App",
  "github.deleteHint":
    "Until an App is registered again, repositories that use it cannot be cloned, pushed to or get pull requests. The App and its installations stay on GitHub.",
  "github.deleteTitle": "Delete the GitHub App?",
  "github.deleted": "Deleted the GitHub App.",
  "github.newTab": "(opens in a new tab)",
  "github.permissions.title": "App permissions",
  "github.permissions.hint":
    "The permissions the author App asks GitHub for, as last read. The platform issues each token with only the permissions its work needs.",
  "github.permissions.unread":
    "The permissions have not been read from GitHub yet. They are read when an owner or admin opens this page.",
  "github.permissions.notGuided":
    "Not in the guidance · the platform never uses it",
  "github.permissions.guidedDefault": "Guidance {level} · default",
  "github.permissions.guidedOptional": "Guidance {level} · optional",
  "github.permissions.app": "App {level}",
  "github.permissions.appNone": "Not on the App",
  "github.permissions.appWide": "App {level} · wider than guidance",
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
    "An agent's GitHub tab turns on only what is allowed here. As with execution-profile ceilings, only owners and admins change it. Lowering it refuses agents that already use it from their next GitHub request.",
  "github.ceiling.base": "Write pull requests",
  "github.ceiling.baseBadge": "Default",
  "github.ceiling.baseHint":
    "Clone, push, open and comment on pull requests. Every agent that uses GitHub has it.",
  "github.ceiling.always": "Always on",
  "github.ceiling.feature.review": "Approve reviews",
  "github.ceiling.feature.reviewHint":
    "Leave approving reviews on pull requests with the reviewer App.",
  "github.ceiling.feature.actions": "Run Actions",
  "github.ceiling.feature.actionsHint":
    "Run or rerun the workflows on an agent's allow list.",
  "github.ceiling.feature.checks": "Write checks",
  "github.ceiling.feature.checksHint": "Create check runs and post results.",
  "github.ceiling.feature.issues": "Write issues",
  "github.ceiling.feature.issuesHint": "Open issues and comment on them.",
  "github.ceiling.feature.workflows": "Change workflow files",
  "github.ceiling.feature.workflowsHint":
    "Push commits that change files under .github/workflows.",
  "github.ceiling.agentsUsing":
    "{count} agents turn it on in their active release",
  "github.ceiling.appLacks":
    "Not on the App · GitHub refuses the token even if allowed here.",
  "github.ceiling.noReviewer":
    "No reviewer App · reviews are refused even if allowed here.",
  "github.ceiling.allowed": "Allowed",
  "github.ceiling.denied": "Not allowed",
  "github.ceiling.receiptNote": "A change is kept in the audit log (receipt).",
  "github.ceiling.revert": "Revert",
  "github.ceiling.saved": "Saved what agents may turn on.",
  "github.ceiling.conflict":
    "Someone changed this first. The saved values were loaded again; check them and save again.",
  "github.ceiling.lowerTitle": "Lower what agents may turn on?",
  "github.ceiling.lowerBody":
    "Turns off: {features}. Sessions still on an earlier release are refused from their next GitHub request too.",
  "github.ceiling.lowerItem":
    "{feature} ({count} agents in their active release)",
  "github.ceiling.lowerConfirm": "Lower and save",
  "github.approvalPending": "Approval pending",
  "github.sameAsReviewer":
    "This App is registered as the reviewer App. The author App must be a different App.",
  "github.reviewer.title": "Reviewer App (optional)",
  "github.reviewer.hint":
    "Approving pull requests takes an App other than the one that opens them. GitHub does not take an approval from the App that opened the pull request.",
  "github.reviewer.app": "Reviewer App",
  "github.reviewer.unsetLine":
    "Once registered, review approval can be turned on in an agent's GitHub tab.",
  "github.reviewer.permissionsTitle": "Recommended permissions",
  "github.reviewer.permissions":
    "Contents read, Pull requests read & write, Metadata read. Install it on the repositories it reviews.",
  "github.reviewer.riskTitle": "One agent opening and approving",
  "github.reviewer.risk":
    "An agent can approve, with the reviewer App, a pull request it opened with the author App; the platform does not stop it. Where one review is required, that approval meets the rule. On GitHub, require two or more reviewers, require a person's review through CODEOWNERS, or keep the reviewer App off ruleset bypass lists.",
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
};

export const githubJa: Record<keyof typeof githubKo, string> = {
  "github.nav": "GitHub 連携設定",
  "github.description":
    "エージェントが GitHub リポジトリを clone し、承認された結果を push し、PR を開くときに使う GitHub App です。オーナーと管理者だけが変更できます。",
  "github.app": "GitHub App",
  "github.appHint":
    "ワークスペースに App を一つ登録します。GitHub の App 設定で App ID を確認し、Private keys から取得した .pem ファイルを選んでください。",
  "github.unset": "未登録",
  "github.unsetLine":
    "App ID と private key を登録すると、リポジトリにインストールできます。",
  "github.connected": "接続済み",
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
  "github.appId": "App ID",
  "github.appIdHint": "GitHub App の設定ページ上部にある数字です。",
  "github.appIdMissing": "App ID を数字で入力してください。",
  "github.key": "Private key (.pem)",
  "github.keyHint":
    "鍵は GitHub で確認してから暗号化して保存し、保存後は二度と表示しません。保存したら、ダウンロードしたファイルは削除してください。",
  "github.keyMissing": ".pem ファイルを選んでください。",
  "github.save": "確認して保存",
  "github.saved": "GitHub App を保存しました。",
  "github.invalidKey":
    "このファイルは RSA private key ではありません。GitHub App の Private keys から取得した .pem ファイルを選んでください。",
  "github.rejected":
    "GitHub がこの App ID と鍵を受け付けませんでした。App ID と、その App の鍵かどうかを確認してください。",
  "github.saveUnreachable":
    "GitHub に接続できなかったため、保存しませんでした。しばらくしてから再試行してください。",
  "github.installations": "インストール",
  "github.installationsHint":
    "App がインストールされている GitHub アカウントと組織です。リポジトリの追加や削除は GitHub のインストール設定で行います。",
  "github.installationsEmpty": "まだどこにもインストールされていません。",
  "github.selectionAll": "すべてのリポジトリ",
  "github.selectionSelected": "選択したリポジトリのみ",
  "github.openOnGitHub": "GitHub で見る",
  "github.repositories": "リポジトリ",
  "github.repositoriesHint":
    "カタログでこの App を使うリポジトリ(auth: kind github_app)です。インストールされていないリポジトリは、セッション開始時に clone できません。",
  "github.repositoriesEmpty":
    "この App を使うリポジトリがカタログにありません。運用者が config/repositories.yaml に追加します。",
  "github.installed": "インストール済み",
  "github.notInstalled": "未インストール",
  "github.unknown": "不明",
  "github.delete": "GitHub App を削除",
  "github.deleteHint":
    "再登録するまで、この App を使うリポジトリは clone・push・PR ができません。GitHub 上の App とインストールはそのまま残ります。",
  "github.deleteTitle": "GitHub App を削除しますか?",
  "github.deleted": "GitHub App を削除しました。",
  "github.newTab": "(新しいタブで開きます)",
  "github.permissions.title": "App の権限",
  "github.permissions.hint":
    "作成用 App が GitHub に求めている権限を最後に読んだ値です。プラットフォームは作業ごとに必要な権限だけでトークンを発行します。",
  "github.permissions.unread":
    "まだ GitHub から権限を読んでいません。オーナーか管理者がこの画面を開くと読みます。",
  "github.permissions.notGuided": "案内にない · プラットフォームは使わない",
  "github.permissions.guidedDefault": "案内 {level} · 基本",
  "github.permissions.guidedOptional": "案内 {level} · 選択",
  "github.permissions.app": "App {level}",
  "github.permissions.appNone": "App にない",
  "github.permissions.appWide": "App {level} · 案内より広い",
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
    "エージェントの GitHub タブは、ここで許可した権限の中でだけ有効にできます。実行プロファイルの上限と同じく、オーナーと管理者だけが変更できます。下げると、すでに有効にしたエージェントも次の GitHub リクエストから拒否されます。",
  "github.ceiling.base": "PR の作成・修正",
  "github.ceiling.baseBadge": "基本",
  "github.ceiling.baseHint":
    "clone、push、PR の作成・コメント。GitHub を使うすべてのエージェントが持ちます。",
  "github.ceiling.always": "常に有効",
  "github.ceiling.feature.review": "レビュー承認",
  "github.ceiling.feature.reviewHint":
    "レビュー用 App で PR に承認レビューを残します。",
  "github.ceiling.feature.actions": "Actions の実行",
  "github.ceiling.feature.actionsHint":
    "エージェントの許可リストにあるワークフローを実行・再実行します。",
  "github.ceiling.feature.checks": "チェック結果の書き込み",
  "github.ceiling.feature.checksHint": "check run を作り、結果を送ります。",
  "github.ceiling.feature.issues": "Issue の書き込み",
  "github.ceiling.feature.issuesHint": "Issue を作成し、コメントします。",
  "github.ceiling.feature.workflows": "ワークフローファイルの変更",
  "github.ceiling.feature.workflowsHint":
    ".github/workflows 以下のファイルを変えた commit も push します。",
  "github.ceiling.agentsUsing":
    "有効なリリースで有効にしたエージェント {count} 件",
  "github.ceiling.appLacks":
    "App に権限がない · 許可しても GitHub がトークン発行を拒否します。",
  "github.ceiling.noReviewer":
    "レビュー用 App がない · 許可してもレビューは拒否されます。",
  "github.ceiling.allowed": "許可",
  "github.ceiling.denied": "許可しない",
  "github.ceiling.receiptNote": "変更は監査記録(receipt)に残ります。",
  "github.ceiling.revert": "元に戻す",
  "github.ceiling.saved": "最大の権限を保存しました。",
  "github.ceiling.conflict":
    "ほかの人が先に最大の権限を変更しました。保存されている値を読み直したので、確認してからもう一度保存してください。",
  "github.ceiling.lowerTitle": "最大の権限を下げますか?",
  "github.ceiling.lowerBody":
    "{features} の権限を無効にします。以前のリリースで動いているセッションも、次の GitHub リクエストから拒否されます。",
  "github.ceiling.lowerItem":
    "{feature}(有効なリリースで有効にしたエージェント {count} 件)",
  "github.ceiling.lowerConfirm": "下げて保存",
  "github.approvalPending": "インストール承認待ち",
  "github.sameAsReviewer":
    "レビュー用 App として登録されている App です。作成用 App は別の App にしてください。",
  "github.reviewer.title": "レビュー用 App(任意)",
  "github.reviewer.hint":
    "PR を承認レビューするには、PR を作る App とは別の App が必要です。GitHub は PR を開いた App の承認を受け付けません。",
  "github.reviewer.app": "レビュー用 App",
  "github.reviewer.unsetLine":
    "登録すると、エージェントの GitHub タブでレビュー承認を有効にできます。",
  "github.reviewer.permissionsTitle": "推奨する権限",
  "github.reviewer.permissions":
    "Contents 読み取り、Pull requests 読み取り・書き込み、Metadata 読み取り。レビューするリポジトリにインストールしてください。",
  "github.reviewer.riskTitle": "同じエージェントによる作成と承認",
  "github.reviewer.risk":
    "同じエージェントが作成用 App で開いた PR を、レビュー用 App で承認できます。プラットフォームはこれを止めません。必須レビューが 1 人のリポジトリでは、この承認でマージ条件が満たされます。GitHub で必須レビュアーを 2 人以上にする、CODEOWNERS で人のレビューを求める、またはレビュー用 App を ruleset のバイパス一覧に入れないでください。",
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
};
