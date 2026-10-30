export const outputsKo = {
  "session.outputs.title": "결과물",
  "session.outputs.download": "{name} 내려받기",
  "session.outputs.tooLarge": "너무 커서 보관하지 않음",
  "session.outputs.empty": "아직 결과물이 없습니다.",
  "session.outputs.emptyHint":
    "결과물은 작업 공간의 out/ 폴더에 남긴 파일만 셉니다. 저장소 파일을 고친 내역은 진행 탭의 도구 호출에서 볼 수 있습니다.",
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
  "session.outputs.empty": "まだ成果物はありません。",
  "session.outputs.emptyHint":
    "成果物として数えるのは、作業スペースの out/ フォルダに残したファイルだけです。リポジトリのファイルを変更した内容は、経過タブのツール呼び出しで確認できます。",
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
  "session.outputs.empty": "No outputs yet.",
  "session.outputs.emptyHint":
    "Only files left in the workspace's out/ folder count as outputs. Changes to repository files show up as tool calls on the Timeline tab.",
  "session.attribution.coAuthor": "Commit co-author: {login}",
  "session.attribution.unlinked":
    "The person who started it has not linked a GitHub account, so commits have no co-author.",
  "session.attribution.link": "Linked accounts",
  "session.attribution.appOnly":
    "No person started this session, so commits carry only the App's name.",
};
