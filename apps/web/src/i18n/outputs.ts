export const outputsKo = {
  "session.outputs.title": "결과물",
  "session.outputs.download": "{name} 내려받기",
  "session.outputs.tooLarge": "너무 커서 보관하지 않음",
  "session.outputs.empty": "아직 결과물이 없습니다.",
  "session.outputs.emptyHint":
    "결과물은 작업 공간 out/ 폴더에 남긴 파일입니다. 저장소 파일 변경은 진행 탭의 도구 호출에서 볼 수 있습니다.",
};

export const outputsJa: Record<keyof typeof outputsKo, string> = {
  "session.outputs.title": "成果物",
  "session.outputs.download": "{name} をダウンロード",
  "session.outputs.tooLarge": "大きすぎるため保存されていません",
  "session.outputs.empty": "まだ成果物はありません。",
  "session.outputs.emptyHint":
    "成果物は作業スペースの out/ フォルダに残したファイルです。リポジトリのファイル変更は経過タブのツール呼び出しで確認できます。",
};

export const outputsEn: Record<keyof typeof outputsKo, string> = {
  "session.outputs.title": "Outputs",
  "session.outputs.download": "Download {name}",
  "session.outputs.tooLarge": "Too large to keep",
  "session.outputs.empty": "No outputs yet.",
  "session.outputs.emptyHint":
    "Outputs are the files left in the workspace's out/ folder. Changes to repository files show in the tool calls on the Timeline tab.",
};
