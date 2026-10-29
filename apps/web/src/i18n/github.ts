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
};
