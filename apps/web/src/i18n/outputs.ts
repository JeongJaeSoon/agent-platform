export const outputsKo = {
  "session.outputs.title": "결과물",
  "session.outputs.download": "{name} 내려받기",
  "session.outputs.tooLarge": "너무 커서 보관하지 않음",
  "session.outputs.files": "out/ 파일",
  "session.outputs.empty": "아직 결과물이 없습니다.",
  "session.outputs.emptyHint":
    "결과물은 이 세션이 연 GitHub PR과 작업 공간의 out/ 폴더에 남긴 파일을 셉니다. 저장소 파일을 고친 내역은 진행 탭의 도구 호출에서 볼 수 있습니다.",
  "session.outcomes.title": "GitHub PR",
  "session.outcomes.state.open": "열림",
  "session.outcomes.state.merged": "머지됨",
  "session.outcomes.state.closed": "닫힘",
  "session.outcomes.mergedAt": "머지",
  "session.outcomes.closedAt": "닫음",
  "session.outcomes.checkedAt": "상태 확인",
  "session.outcomes.notChecked": "아직 상태를 확인하지 않음",
  "session.outcomes.checkError.not_found":
    "마지막 확인에서 GitHub가 이 PR을 찾지 못했습니다. 상태는 그 전에 확인한 값입니다.",
  "session.outcomes.checkError.forge_failed":
    "마지막 확인에서 GitHub 요청이 실패했습니다. 상태는 그 전에 확인한 값입니다.",
  "session.outcomes.checkError.github_refused":
    "마지막 확인이 GitHub 설정에서 거절됐습니다. 상태는 그 전에 확인한 값입니다.",
  "session.outcomes.usage": "이 세션이 쓴 토큰 {tokens} · 추정 비용 {cost}",
  "session.outcomes.usageUnmetered":
    "이 세션이 쓴 토큰 {tokens} · 토큰별 과금 없음",
  "session.refusals.title": "최근 GitHub 거절",
  "session.attribution.coAuthor": "commit 공동 작성자: {login}",
  "session.attribution.unlinked":
    "시작한 사람의 GitHub 계정이 연결되지 않아 commit에 공동 작성자가 없습니다.",
  "session.attribution.link": "연동 계정",
  "session.attribution.appOnly":
    "시작한 사람이 없는 세션이라 commit은 App 이름으로만 남습니다.",
};

export const outputsJa: Record<keyof typeof outputsKo, string> = {
  "session.outputs.title": "成果物",
  "session.outputs.download": "{name} をダウンロード",
  "session.outputs.tooLarge": "大きすぎるため保存されていません",
  "session.outputs.files": "out/ のファイル",
  "session.outputs.empty": "まだ成果物はありません。",
  "session.outputs.emptyHint":
    "成果物として数えるのは、このセッションが開いた GitHub PR と、作業スペースの out/ フォルダに残したファイルです。リポジトリのファイルを変更した内容は、経過タブのツール呼び出しで確認できます。",
  "session.outcomes.title": "GitHub PR",
  "session.outcomes.state.open": "オープン",
  "session.outcomes.state.merged": "マージ済み",
  "session.outcomes.state.closed": "クローズ",
  "session.outcomes.mergedAt": "マージ",
  "session.outcomes.closedAt": "クローズ",
  "session.outcomes.checkedAt": "状態確認",
  "session.outcomes.notChecked": "まだ状態を確認していません",
  "session.outcomes.checkError.not_found":
    "前回の確認で GitHub がこの PR を見つけられませんでした。状態はその前に確認した値です。",
  "session.outcomes.checkError.forge_failed":
    "前回の確認で GitHub へのリクエストが失敗しました。状態はその前に確認した値です。",
  "session.outcomes.checkError.github_refused":
    "前回の確認は GitHub の設定で拒否されました。状態はその前に確認した値です。",
  "session.outcomes.usage":
    "このセッションのトークン {tokens} · 推定コスト {cost}",
  "session.outcomes.usageUnmetered":
    "このセッションのトークン {tokens} · トークン課金なし",
  "session.refusals.title": "最近の GitHub 拒否",
  "session.attribution.coAuthor": "コミットの共同作成者: {login}",
  "session.attribution.unlinked":
    "開始した人の GitHub アカウントが連携されていないため、コミットに共同作成者はいません。",
  "session.attribution.link": "連携アカウント",
  "session.attribution.appOnly":
    "開始した人がいないセッションのため、コミットは App の名前だけで残ります。",
};

export const outputsEn: Record<keyof typeof outputsKo, string> = {
  "session.outputs.title": "Outputs",
  "session.outputs.download": "Download {name}",
  "session.outputs.tooLarge": "Too large to keep",
  "session.outputs.files": "out/ files",
  "session.outputs.empty": "No outputs yet.",
  "session.outputs.emptyHint":
    "Outputs are the GitHub pull requests this session opened and the files left in the workspace's out/ folder. Changes to repository files show up as tool calls on the Timeline tab.",
  "session.outcomes.title": "GitHub PR",
  "session.outcomes.state.open": "Open",
  "session.outcomes.state.merged": "Merged",
  "session.outcomes.state.closed": "Closed",
  "session.outcomes.mergedAt": "Merged",
  "session.outcomes.closedAt": "Closed",
  "session.outcomes.checkedAt": "Checked",
  "session.outcomes.notChecked": "Not checked yet",
  "session.outcomes.checkError.not_found":
    "At the last check GitHub could not find this pull request. The state shown is from the check before.",
  "session.outcomes.checkError.forge_failed":
    "At the last check the request to GitHub failed. The state shown is from the check before.",
  "session.outcomes.checkError.github_refused":
    "The last check was refused by the GitHub settings. The state shown is from the check before.",
  "session.outcomes.usage": "This session used {tokens} tokens · est. {cost}",
  "session.outcomes.usageUnmetered":
    "This session used {tokens} tokens · not billed per token",
  "session.refusals.title": "Recent GitHub refusals",
  "session.attribution.coAuthor": "Commit co-author: {login}",
  "session.attribution.unlinked":
    "The person who started it has not linked a GitHub account, so commits have no co-author.",
  "session.attribution.link": "Linked accounts",
  "session.attribution.appOnly":
    "No person started this session, so commits carry only the App's name.",
};
