/** The run profiles screen (/profiles); every catalog spreads these in. */
export const profilesKo = {
  "nav.profiles": "실행 프로필",
  "profiles.title": "실행 프로필",
  "profiles.description":
    "에이전트가 쓸 모델과 도구를 정합니다. 운영자 프로필을 바탕으로 이 워크스페이스용 프로필을 만들 수 있습니다. 모델과 도구는 줄이기만 할 수 있습니다.",
  "profiles.create": "프로필 만들기",
  "profiles.workspace.title": "워크스페이스 프로필",
  "profiles.workspace.description":
    "수정하면 새 버전으로 저장됩니다. 이전 버전을 쓰던 에이전트는 그대로 동작합니다.",
  "profiles.operator.title": "운영자 프로필",
  "profiles.operator.description":
    "설치 설정에서 정의하고 콘솔에서는 읽기만 합니다. 바꾸려면 설치 설정 파일을 고친 뒤 다시 배포하세요.",
  "profiles.locked": "바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요",
  "profiles.count": "{count}개",
  "profiles.column.profile": "프로필",
  "profiles.column.model": "모델",
  "profiles.column.environment": "실행 환경",
  "profiles.column.name": "이름",
  "profiles.column.base": "바탕 프로필",
  "profiles.column.state": "상태",
  "profiles.column.actions": "동작",
  "profiles.runtime": "Claude Agent SDK {version}",
  "profiles.repository.required": "저장소 필요",
  "profiles.repository.optional": "저장소 선택",
  "profiles.repository.none": "저장소 쓰지 않음",
  "profiles.billing.metered": "비용 집계",
  "profiles.billing.none": "비용 집계 안 함",
  "profiles.noTools": "도구 없음",
  "profiles.empty": "이 설치에 실행 프로필이 없습니다.",
  "profiles.versionTag": "v{version}",
  "profiles.olderVersions": "이전 버전 {count}개",
  "profiles.state.usable": "사용 중",
  "profiles.state.base_changed": "바탕 프로필 바뀜",
  "profiles.state.base_missing": "바탕 프로필 없음",
  "profiles.state.retired": "사용 중지됨",
  "profiles.newVersion": "수정",
  "profiles.remake": "다시 만들기",
  "profiles.retire": "사용 중지",
  "profiles.emptyWorkspace.title": "아직 워크스페이스 프로필이 없습니다",
  "profiles.emptyWorkspace.text":
    "에이전트는 운영자 프로필을 그대로 씁니다. 운영자 프로필을 바탕으로 모델이나 도구를 줄인 프로필을 만들 수 있습니다.",
  "profiles.baseChanged.title": "{name}의 바탕 프로필이 바뀌었습니다",
  "profiles.baseChanged.text":
    "운영자가 {base}를 바꿨습니다. {id}로는 새 release를 만들 수 없고, 이 버전을 쓰는 release도 새 세션을 시작하지 못합니다. 다시 만들어 새 버전으로 옮기세요.",
  "profiles.baseMissing.title": "{name}의 바탕 프로필이 없어졌습니다",
  "profiles.baseMissing.text":
    "운영자가 {base}를 지웠습니다. {id}로는 새 release를 만들 수 없고, 이 버전을 쓰는 release도 새 세션을 시작하지 못합니다. 다른 운영자 프로필로 새로 만드세요.",
  "profiles.editor.createTitle": "프로필 만들기",
  "profiles.editor.versionTitle": "{name} 수정",
  "profiles.editor.remakeTitle": "{name} 다시 만들기",
  "profiles.editor.description":
    "위는 바탕이 되는 운영자 프로필입니다. 아래에서는 모델·도구를 줄이거나 권한 모드를 더 엄격하게만 바꿀 수 있습니다.",
  "profiles.editor.base": "바탕 프로필",
  "profiles.editor.baseHeading": "운영자 프로필 {id}",
  "profiles.editor.managedInSettings": "설치 설정에서 관리",
  "profiles.editor.engineModel": "엔진 · 모델",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "권한 모드",
  "profiles.editor.tools": "도구",
  "profiles.editor.narrowTitle": "이 워크스페이스에서 쓸 값",
  "profiles.editor.autoRulesNote":
    "auto 규칙(환경·허용·soft deny·hard deny, 모든 셸 명령 분류)은 여기서 고치지 않습니다. 따로 정하는 화면은 다음 단계에 생깁니다.",
  "profiles.editor.name": "이름",
  "profiles.editor.nameHint":
    "영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
  "profiles.editor.preview": "저장할 버전의 id: {id}",
  "profiles.editor.models": "모델",
  "profiles.editor.modelsHint":
    "세션이 고를 수 있는 모델입니다. 바탕 프로필에 있는 모델만 고릅니다.",
  "profiles.editor.defaultModel": "기본 모델",
  "profiles.editor.toolsHint": "바탕 프로필에 있는 도구만 켤 수 있습니다.",
  "profiles.editor.modeHint":
    "바탕 프로필과 같거나 사람이 더 많이 확인하는 모드만 고를 수 있습니다.",
  "profiles.editor.scriptCeiling": "스크립트 상한",
  "profiles.editor.scriptNone": "실행 안 함",
  "profiles.editor.scriptLater": "2a 단계부터",
  "profiles.editor.scriptHint":
    "에이전트가 확장 스크립트를 부를 수 있는 한도입니다. 낮추기만 할 수 있습니다.",
  "profiles.editor.saveNote":
    "새 버전으로 저장합니다. 이전 버전을 쓰는 release는 새 버전으로 옮겨야 바뀝니다.",
  "profiles.editor.save": "새 버전으로 저장",
  "profiles.editor.saving": "저장하는 중…",
  "profiles.editor.nameInvalid":
    "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
  "profiles.editor.modelsEmpty": "모델을 하나 이상 고르세요.",
  "profiles.editor.tooLarge":
    "한 프로필에는 모델 32개, 도구 64개까지 담습니다. 줄인 뒤 다시 저장하세요.",
  "profiles.editor.tooLong":
    "프로필에는 200자 이하의 이름만 담습니다. 이름이 긴 모델이나 도구를 빼고 저장하세요.",
  "profiles.error.unknownBase":
    "운영자가 그 바탕 프로필을 지웠습니다. 목록을 다시 불러오세요.",
  "profiles.error.widens":
    "바탕 프로필이 허용하지 않는 값입니다. 목록을 다시 불러와 바탕 프로필을 확인하세요.",
  "profiles.error.versionTaken":
    "같은 이름의 새 버전이 방금 저장됐습니다. 다시 저장하면 그다음 버전이 됩니다.",
  "profiles.saved": "{id} 버전을 저장했습니다.",
  "profiles.retireTitle": "{id} 버전을 사용 중지할까요?",
  "profiles.retireText":
    "이미 이 버전을 쓰는 release와 세션은 계속 동작합니다. 새 release와 세션은 이 버전을 고를 수 없습니다. 사용 중지는 되돌릴 수 없습니다.",
  "profiles.retiring": "사용 중지하는 중…",
  "profiles.retired": "{id} 버전을 사용 중지했습니다.",
};

export const profilesEn: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "Run profiles",
  "profiles.title": "Run profiles",
  "profiles.description":
    "The models and tools an agent uses. You can make a profile for this workspace from an operator profile. Models and tools can only be reduced.",
  "profiles.create": "Make a profile",
  "profiles.workspace.title": "Workspace profiles",
  "profiles.workspace.description":
    "Editing saves a new version. Agents on an earlier version keep working as they are.",
  "profiles.operator.title": "Operator profiles",
  "profiles.operator.description":
    "Defined in the installation settings; the console only reads them. To change one, edit the installation settings file and deploy again.",
  "profiles.locked": "To change these, ask a workspace owner or admin",
  "profiles.count": "{count}",
  "profiles.column.profile": "Profile",
  "profiles.column.model": "Model",
  "profiles.column.environment": "Runs with",
  "profiles.column.name": "Name",
  "profiles.column.base": "Based on",
  "profiles.column.state": "State",
  "profiles.column.actions": "Actions",
  "profiles.runtime": "Claude Agent SDK {version}",
  "profiles.repository.required": "Repository required",
  "profiles.repository.optional": "Repository optional",
  "profiles.repository.none": "No repository",
  "profiles.billing.metered": "Cost tracked",
  "profiles.billing.none": "No cost tracked",
  "profiles.noTools": "No tools",
  "profiles.empty": "This installation has no run profiles.",
  "profiles.versionTag": "v{version}",
  "profiles.olderVersions": "{count} earlier versions",
  "profiles.state.usable": "In use",
  "profiles.state.base_changed": "Base profile changed",
  "profiles.state.base_missing": "Base profile removed",
  "profiles.state.retired": "Turned off",
  "profiles.newVersion": "Edit",
  "profiles.remake": "Make again",
  "profiles.retire": "Turn off",
  "profiles.emptyWorkspace.title": "No workspace profiles yet",
  "profiles.emptyWorkspace.text":
    "Agents use the operator's profiles as they are. You can make a profile from one with fewer models or tools.",
  "profiles.baseChanged.title": "The base profile of {name} changed",
  "profiles.baseChanged.text":
    "The operator changed {base}. No new release can use {id}, and releases that use it cannot start new sessions. Make it again and move to the new version.",
  "profiles.baseMissing.title": "The base profile of {name} was removed",
  "profiles.baseMissing.text":
    "The operator removed {base}. No new release can use {id}, and releases that use it cannot start new sessions. Make a new one from another operator profile.",
  "profiles.editor.createTitle": "Make a profile",
  "profiles.editor.versionTitle": "Edit {name}",
  "profiles.editor.remakeTitle": "Make {name} again",
  "profiles.editor.description":
    "Above is the operator profile it is based on. Below you can only remove models and tools or make the permission mode stricter.",
  "profiles.editor.base": "Base profile",
  "profiles.editor.baseHeading": "Operator profile {id}",
  "profiles.editor.managedInSettings": "Managed in installation settings",
  "profiles.editor.engineModel": "Engine · model",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "Permission mode",
  "profiles.editor.tools": "Tools",
  "profiles.editor.narrowTitle": "Values for this workspace",
  "profiles.editor.autoRulesNote":
    "Auto rules (environment, allow, soft deny, hard deny, classifying every shell command) are not edited here. A screen for them comes in a later stage.",
  "profiles.editor.name": "Name",
  "profiles.editor.nameHint":
    "Starts with a lowercase letter or digit; lowercase letters, digits and - up to 40 characters.",
  "profiles.editor.preview": "Id of the version to save: {id}",
  "profiles.editor.models": "Models",
  "profiles.editor.modelsHint":
    "The models a session may pick. Only the base profile's models are offered.",
  "profiles.editor.defaultModel": "Default model",
  "profiles.editor.toolsHint":
    "Only the base profile's tools can be turned on.",
  "profiles.editor.modeHint":
    "Only the base profile's mode or one that has a person check more.",
  "profiles.editor.scriptCeiling": "Script ceiling",
  "profiles.editor.scriptNone": "Not run",
  "profiles.editor.scriptLater": "From stage 2a",
  "profiles.editor.scriptHint":
    "How far an agent may call extension scripts. It can only be lowered.",
  "profiles.editor.saveNote":
    "This saves a new version. Releases on an earlier version change only when moved to the new one.",
  "profiles.editor.save": "Save as new version",
  "profiles.editor.saving": "Saving…",
  "profiles.editor.nameInvalid":
    "A name starts with a lowercase letter or digit and holds lowercase letters, digits and - up to 40 characters.",
  "profiles.editor.modelsEmpty": "Pick at least one model.",
  "profiles.editor.tooLarge":
    "A profile holds up to 32 models and 64 tools. Pick fewer and save again.",
  "profiles.editor.tooLong":
    "A profile holds names of up to 200 characters. Leave out the model or tool with the long name and save again.",
  "profiles.error.unknownBase":
    "The operator removed that base profile. Reload the list.",
  "profiles.error.widens":
    "The base profile does not allow a value you picked. Reload the list and check the base profile.",
  "profiles.error.versionTaken":
    "A new version of this name was just saved. Save again to make the one after it.",
  "profiles.saved": "Saved version {id}.",
  "profiles.retireTitle": "Turn off version {id}?",
  "profiles.retireText":
    "Releases and sessions that already use it keep running. New releases and sessions cannot pick it. Turning it off cannot be undone.",
  "profiles.retiring": "Turning off…",
  "profiles.retired": "Turned off version {id}.",
};

export const profilesJa: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "実行プロファイル",
  "profiles.title": "実行プロファイル",
  "profiles.description":
    "エージェントが使うモデルとツールを決めます。運営者のプロファイルをもとに、このワークスペース用のプロファイルを作れます。モデルとツールは減らすことだけができます。",
  "profiles.create": "プロファイルを作成",
  "profiles.workspace.title": "ワークスペースのプロファイル",
  "profiles.workspace.description":
    "編集すると新しいバージョンとして保存されます。前のバージョンを使っていたエージェントはそのまま動きます。",
  "profiles.operator.title": "運営者のプロファイル",
  "profiles.operator.description":
    "インストール設定で定義し、コンソールでは読むだけです。変更するにはインストール設定ファイルを直して再デプロイしてください。",
  "profiles.locked":
    "変更するにはワークスペースのオーナーか管理者に依頼してください",
  "profiles.count": "{count} 件",
  "profiles.column.profile": "プロファイル",
  "profiles.column.model": "モデル",
  "profiles.column.environment": "実行環境",
  "profiles.column.name": "名前",
  "profiles.column.base": "もとのプロファイル",
  "profiles.column.state": "状態",
  "profiles.column.actions": "操作",
  "profiles.runtime": "Claude Agent SDK {version}",
  "profiles.repository.required": "リポジトリ必須",
  "profiles.repository.optional": "リポジトリ任意",
  "profiles.repository.none": "リポジトリを使わない",
  "profiles.billing.metered": "コスト集計",
  "profiles.billing.none": "コスト集計なし",
  "profiles.noTools": "ツールなし",
  "profiles.empty": "このインストールには実行プロファイルがありません。",
  "profiles.versionTag": "v{version}",
  "profiles.olderVersions": "前のバージョン {count} 件",
  "profiles.state.usable": "使用中",
  "profiles.state.base_changed": "もとが変更",
  "profiles.state.base_missing": "もとがない",
  "profiles.state.retired": "使用停止",
  "profiles.newVersion": "編集",
  "profiles.remake": "作り直す",
  "profiles.retire": "使用停止",
  "profiles.emptyWorkspace.title":
    "ワークスペースのプロファイルはまだありません",
  "profiles.emptyWorkspace.text":
    "エージェントは運営者のプロファイルをそのまま使います。運営者のプロファイルをもとに、モデルやツールを減らしたプロファイルを作れます。",
  "profiles.baseChanged.title": "{name} のもとのプロファイルが変わりました",
  "profiles.baseChanged.text":
    "運営者が {base} を変更しました。{id} では新しい release を作れず、このバージョンを使う release も新しいセッションを開始できません。作り直して新しいバージョンに移してください。",
  "profiles.baseMissing.title": "{name} のもとのプロファイルがなくなりました",
  "profiles.baseMissing.text":
    "運営者が {base} を削除しました。{id} では新しい release を作れず、このバージョンを使う release も新しいセッションを開始できません。別の運営者のプロファイルから新しく作ってください。",
  "profiles.editor.createTitle": "プロファイルを作成",
  "profiles.editor.versionTitle": "{name} を編集",
  "profiles.editor.remakeTitle": "{name} を作り直す",
  "profiles.editor.description":
    "上はもとになる運営者のプロファイルです。下ではモデル・ツールを減らすか、権限モードをより厳しくすることだけができます。",
  "profiles.editor.base": "もとのプロファイル",
  "profiles.editor.baseHeading": "運営者のプロファイル {id}",
  "profiles.editor.managedInSettings": "インストール設定で管理",
  "profiles.editor.engineModel": "エンジン・モデル",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "権限モード",
  "profiles.editor.tools": "ツール",
  "profiles.editor.narrowTitle": "このワークスペースで使う値",
  "profiles.editor.autoRulesNote":
    "auto ルール(環境・許可・soft deny・hard deny、すべてのシェルコマンドの分類)はここでは変更しません。設定する画面は次の段階でできます。",
  "profiles.editor.name": "名前",
  "profiles.editor.nameHint":
    "英小文字か数字で始め、英小文字・数字・- で 40 文字まで。",
  "profiles.editor.preview": "保存するバージョンの id: {id}",
  "profiles.editor.models": "モデル",
  "profiles.editor.modelsHint":
    "セッションが選べるモデルです。もとのプロファイルにあるモデルだけを選べます。",
  "profiles.editor.defaultModel": "既定のモデル",
  "profiles.editor.toolsHint":
    "もとのプロファイルにあるツールだけをオンにできます。",
  "profiles.editor.modeHint":
    "もとのプロファイルと同じか、人がより多く確認するモードだけを選べます。",
  "profiles.editor.scriptCeiling": "スクリプト上限",
  "profiles.editor.scriptNone": "実行しない",
  "profiles.editor.scriptLater": "2a 段階から",
  "profiles.editor.scriptHint":
    "エージェントが拡張スクリプトを呼べる上限です。下げることだけができます。",
  "profiles.editor.saveNote":
    "新しいバージョンとして保存します。前のバージョンを使う release は新しいバージョンに移すまで変わりません。",
  "profiles.editor.save": "新しいバージョンとして保存",
  "profiles.editor.saving": "保存中…",
  "profiles.editor.nameInvalid":
    "名前は英小文字か数字で始め、英小文字・数字・- で 40 文字までです。",
  "profiles.editor.modelsEmpty": "モデルを 1 つ以上選んでください。",
  "profiles.editor.tooLarge":
    "1 つのプロファイルに入るのはモデル 32 個、ツール 64 個までです。減らしてからもう一度保存してください。",
  "profiles.editor.tooLong":
    "プロファイルに入る名前は 200 文字までです。名前の長いモデルやツールを外してから保存してください。",
  "profiles.error.unknownBase":
    "運営者がそのもとのプロファイルを削除しました。一覧を再読み込みしてください。",
  "profiles.error.widens":
    "もとのプロファイルが許可しない値です。一覧を再読み込みしてもとのプロファイルを確認してください。",
  "profiles.error.versionTaken":
    "同じ名前の新しいバージョンがいま保存されました。もう一度保存するとその次のバージョンになります。",
  "profiles.saved": "バージョン {id} を保存しました。",
  "profiles.retireTitle": "バージョン {id} を使用停止しますか?",
  "profiles.retireText":
    "すでにこのバージョンを使っている release とセッションは動き続けます。新しい release とセッションはこのバージョンを選べません。使用停止は元に戻せません。",
  "profiles.retiring": "使用停止しています…",
  "profiles.retired": "バージョン {id} を使用停止しました。",
};
