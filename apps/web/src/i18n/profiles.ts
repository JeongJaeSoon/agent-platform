/** The run profiles screen (/profiles); every catalog spreads these in. */
export const profilesKo = {
  "nav.profiles": "실행 프로필",
  "profiles.title": "실행 프로필",
  "profiles.description":
    "에이전트가 어떤 엔진에서 도는지 정합니다. 설치 운영자가 정한 프로필을 이 워크스페이스에 맞게 좁힌 판도 만들 수 있습니다. 넓힐 수는 없습니다.",
  "profiles.create": "좁힌 프로필 만들기",
  "profiles.workspace.title": "워크스페이스 프로필",
  "profiles.workspace.description":
    "판마다 새 id입니다. 저장한 판은 바뀌지 않습니다.",
  "profiles.operator.title": "운영자 프로필",
  "profiles.operator.description":
    "설치 설정에서 정의하고 콘솔에서는 읽기만 합니다. 바꾸려면 설치 설정 파일을 고친 뒤 다시 배포하세요.",
  "profiles.locked": "바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요",
  "profiles.column.profile": "프로필",
  "profiles.column.model": "모델",
  "profiles.column.environment": "실행 환경",
  "profiles.column.name": "이름",
  "profiles.column.base": "기준",
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
  "profiles.foot": "프로필 {count}개",
  "profiles.state.usable": "쓸 수 있음",
  "profiles.state.base_changed": "기준 바뀜",
  "profiles.state.base_missing": "기준 없음",
  "profiles.state.retired": "은퇴",
  "profiles.newVersion": "새 판 만들기",
  "profiles.remake": "다시 만들기",
  "profiles.retire": "은퇴",
  "profiles.emptyWorkspace.title": "아직 좁힌 프로필이 없습니다",
  "profiles.emptyWorkspace.text":
    "에이전트는 운영자 프로필을 그대로 씁니다. 운영자 프로필을 골라 모델이나 도구를 더 좁힐 수 있습니다.",
  "profiles.baseChanged.title": "{name}의 기준이 바뀌었습니다",
  "profiles.baseChanged.text":
    "운영자가 {base}를 바꿨습니다. {id}로는 새 release를 만들 수 없고, 이 판을 쓰는 release도 새 세션을 시작하지 못합니다. 다시 만들어 새 판으로 옮기세요.",
  "profiles.baseMissing.title": "{name}의 기준이 없어졌습니다",
  "profiles.baseMissing.text":
    "운영자가 {base}를 지웠습니다. {id}로는 새 release를 만들 수 없고, 이 판을 쓰는 release도 새 세션을 시작하지 못합니다. 다른 운영자 프로필로 새로 만드세요.",
  "profiles.editor.createTitle": "좁힌 프로필 만들기",
  "profiles.editor.versionTitle": "{name} 새 판 만들기",
  "profiles.editor.remakeTitle": "{name} 다시 만들기",
  "profiles.editor.description":
    "위는 운영자 프로필이고, 아래에서 모델·도구·권한 모드를 더 좁히기만 합니다.",
  "profiles.editor.base": "기준 프로필",
  "profiles.editor.baseHeading": "운영자 프로필 {id}",
  "profiles.editor.managedInSettings": "설치 설정에서 관리",
  "profiles.editor.engineModel": "엔진 · 모델",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "권한 모드",
  "profiles.editor.tools": "도구",
  "profiles.editor.narrowTitle": "이 워크스페이스에서 좁히기",
  "profiles.editor.autoRulesNote":
    "auto 규칙(환경·허용·soft deny·hard deny, 모든 셸 명령 분류)은 여기서 고치지 않습니다. 따로 정하는 화면은 다음 단계에 생깁니다.",
  "profiles.editor.name": "이름",
  "profiles.editor.nameHint":
    "영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
  "profiles.editor.preview": "저장하면 {id} 판이 생깁니다.",
  "profiles.editor.models": "모델",
  "profiles.editor.modelsHint":
    "세션이 고를 수 있는 모델입니다. 기준에 있는 모델만 고릅니다.",
  "profiles.editor.defaultModel": "기본 모델",
  "profiles.editor.toolsHint": "기준에 있는 도구만 켤 수 있습니다.",
  "profiles.editor.modeHint":
    "기준과 같거나 사람이 더 많이 확인하는 모드만 고를 수 있습니다.",
  "profiles.editor.scriptCeiling": "스크립트 상한",
  "profiles.editor.scriptNone": "실행 안 함",
  "profiles.editor.scriptLater": "2a 단계부터",
  "profiles.editor.scriptHint":
    "에이전트가 확장 스크립트를 부를 수 있는 한도입니다. 낮추기만 할 수 있습니다.",
  "profiles.editor.saveNote":
    "새 판으로 저장합니다. 이 프로필을 쓰는 release는 새 판으로 옮겨야 바뀝니다.",
  "profiles.editor.save": "새 판으로 저장",
  "profiles.editor.saving": "저장하는 중…",
  "profiles.editor.nameInvalid":
    "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
  "profiles.editor.modelsEmpty": "모델을 하나 이상 고르세요.",
  "profiles.error.unknownBase":
    "운영자가 그 기준 프로필을 지웠습니다. 목록을 다시 불러오세요.",
  "profiles.error.widens":
    "기준 프로필이 허용하지 않는 값입니다. 목록을 다시 불러와 기준을 확인하세요.",
  "profiles.error.versionTaken":
    "같은 이름의 판이 방금 저장됐습니다. 다시 저장하면 다음 판이 됩니다.",
  "profiles.saved": "{id} 판을 만들었습니다.",
  "profiles.retireTitle": "{id} 판을 은퇴시킬까요?",
  "profiles.retireText":
    "이미 이 판을 쓰는 release와 세션은 계속 돕니다. 새 release와 세션은 이 판을 고를 수 없습니다. 되돌릴 수 없습니다.",
  "profiles.retiring": "은퇴시키는 중…",
  "profiles.retired": "{id} 판을 은퇴시켰습니다.",
};

export const profilesEn: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "Run profiles",
  "profiles.title": "Run profiles",
  "profiles.description":
    "Which engine an agent runs on. You can also make versions of the installation's profiles narrowed for this workspace. They cannot be widened.",
  "profiles.create": "Make a narrowed profile",
  "profiles.workspace.title": "Workspace profiles",
  "profiles.workspace.description":
    "Each version has its own id. A saved version never changes.",
  "profiles.operator.title": "Operator profiles",
  "profiles.operator.description":
    "Defined in the installation settings; the console only reads them. To change one, edit the installation settings file and deploy again.",
  "profiles.locked": "To change these, ask a workspace owner or admin",
  "profiles.column.profile": "Profile",
  "profiles.column.model": "Model",
  "profiles.column.environment": "Runs with",
  "profiles.column.name": "Name",
  "profiles.column.base": "Base",
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
  "profiles.foot": "{count} profiles",
  "profiles.state.usable": "Usable",
  "profiles.state.base_changed": "Base changed",
  "profiles.state.base_missing": "Base removed",
  "profiles.state.retired": "Retired",
  "profiles.newVersion": "New version",
  "profiles.remake": "Make again",
  "profiles.retire": "Retire",
  "profiles.emptyWorkspace.title": "No narrowed profiles yet",
  "profiles.emptyWorkspace.text":
    "Agents use the operator's profiles as they are. Pick one to narrow its models or tools for this workspace.",
  "profiles.baseChanged.title": "The base of {name} changed",
  "profiles.baseChanged.text":
    "The operator changed {base}. No new release can use {id}, and releases that use it cannot start new sessions. Make it again and move to the new version.",
  "profiles.baseMissing.title": "The base of {name} was removed",
  "profiles.baseMissing.text":
    "The operator removed {base}. No new release can use {id}, and releases that use it cannot start new sessions. Make a new one from another operator profile.",
  "profiles.editor.createTitle": "Make a narrowed profile",
  "profiles.editor.versionTitle": "New version of {name}",
  "profiles.editor.remakeTitle": "Make {name} again",
  "profiles.editor.description":
    "Above is the operator's profile. Below you can only narrow its models, tools and permission mode.",
  "profiles.editor.base": "Base profile",
  "profiles.editor.baseHeading": "Operator profile {id}",
  "profiles.editor.managedInSettings": "Managed in installation settings",
  "profiles.editor.engineModel": "Engine · model",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "Permission mode",
  "profiles.editor.tools": "Tools",
  "profiles.editor.narrowTitle": "Narrow it for this workspace",
  "profiles.editor.autoRulesNote":
    "Auto rules (environment, allow, soft deny, hard deny, classifying every shell command) are not edited here. A screen for them comes in a later stage.",
  "profiles.editor.name": "Name",
  "profiles.editor.nameHint":
    "Starts with a lowercase letter or digit; lowercase letters, digits and - up to 40 characters.",
  "profiles.editor.preview": "Saving makes version {id}.",
  "profiles.editor.models": "Models",
  "profiles.editor.modelsHint":
    "The models a session may pick. Only the base's models are offered.",
  "profiles.editor.defaultModel": "Default model",
  "profiles.editor.toolsHint": "Only the base's tools can be turned on.",
  "profiles.editor.modeHint":
    "Only the base's mode or one that has a person check more.",
  "profiles.editor.scriptCeiling": "Script ceiling",
  "profiles.editor.scriptNone": "Not run",
  "profiles.editor.scriptLater": "From stage 2a",
  "profiles.editor.scriptHint":
    "How far an agent may call extension scripts. It can only be lowered.",
  "profiles.editor.saveNote":
    "This saves a new version. Releases that use this profile change only when moved to the new version.",
  "profiles.editor.save": "Save as new version",
  "profiles.editor.saving": "Saving…",
  "profiles.editor.nameInvalid":
    "A name starts with a lowercase letter or digit and holds lowercase letters, digits and - up to 40 characters.",
  "profiles.editor.modelsEmpty": "Pick at least one model.",
  "profiles.error.unknownBase":
    "The operator removed that base profile. Reload the list.",
  "profiles.error.widens":
    "The base profile does not allow a value you picked. Reload the list and check the base.",
  "profiles.error.versionTaken":
    "A version of this name was just saved. Save again to make the next one.",
  "profiles.saved": "Made version {id}.",
  "profiles.retireTitle": "Retire version {id}?",
  "profiles.retireText":
    "Releases and sessions that already use it keep running. New releases and sessions cannot pick it. This cannot be undone.",
  "profiles.retiring": "Retiring…",
  "profiles.retired": "Retired version {id}.",
};

export const profilesJa: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "実行プロファイル",
  "profiles.title": "実行プロファイル",
  "profiles.description":
    "エージェントがどのエンジンで動くかを決めます。インストールの運営者が決めたプロファイルを、このワークスペース向けに絞った版も作れます。広げることはできません。",
  "profiles.create": "絞ったプロファイルを作成",
  "profiles.workspace.title": "ワークスペースのプロファイル",
  "profiles.workspace.description":
    "版ごとに新しい id です。保存した版は変わりません。",
  "profiles.operator.title": "運営者のプロファイル",
  "profiles.operator.description":
    "インストール設定で定義し、コンソールでは読むだけです。変更するにはインストール設定ファイルを直して再デプロイしてください。",
  "profiles.locked":
    "変更するにはワークスペースのオーナーか管理者に依頼してください",
  "profiles.column.profile": "プロファイル",
  "profiles.column.model": "モデル",
  "profiles.column.environment": "実行環境",
  "profiles.column.name": "名前",
  "profiles.column.base": "基準",
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
  "profiles.foot": "プロファイル {count} 件",
  "profiles.state.usable": "使用可",
  "profiles.state.base_changed": "基準が変更",
  "profiles.state.base_missing": "基準なし",
  "profiles.state.retired": "引退",
  "profiles.newVersion": "新しい版を作成",
  "profiles.remake": "作り直す",
  "profiles.retire": "引退",
  "profiles.emptyWorkspace.title": "絞ったプロファイルはまだありません",
  "profiles.emptyWorkspace.text":
    "エージェントは運営者のプロファイルをそのまま使います。運営者のプロファイルを選んで、モデルやツールをさらに絞れます。",
  "profiles.baseChanged.title": "{name} の基準が変わりました",
  "profiles.baseChanged.text":
    "運営者が {base} を変更しました。{id} では新しい release を作れず、この版を使う release も新しいセッションを開始できません。作り直して新しい版に移してください。",
  "profiles.baseMissing.title": "{name} の基準がなくなりました",
  "profiles.baseMissing.text":
    "運営者が {base} を削除しました。{id} では新しい release を作れず、この版を使う release も新しいセッションを開始できません。別の運営者のプロファイルから新しく作ってください。",
  "profiles.editor.createTitle": "絞ったプロファイルを作成",
  "profiles.editor.versionTitle": "{name} の新しい版を作成",
  "profiles.editor.remakeTitle": "{name} を作り直す",
  "profiles.editor.description":
    "上は運営者のプロファイルで、下ではモデル・ツール・権限モードを絞ることだけができます。",
  "profiles.editor.base": "基準のプロファイル",
  "profiles.editor.baseHeading": "運営者のプロファイル {id}",
  "profiles.editor.managedInSettings": "インストール設定で管理",
  "profiles.editor.engineModel": "エンジン・モデル",
  "profiles.editor.engineModelValue": "Claude Agent SDK {version} · {model}",
  "profiles.editor.permissionMode": "権限モード",
  "profiles.editor.tools": "ツール",
  "profiles.editor.narrowTitle": "このワークスペースで絞る",
  "profiles.editor.autoRulesNote":
    "auto ルール(環境・許可・soft deny・hard deny、すべてのシェルコマンドの分類)はここでは変更しません。設定する画面は次の段階でできます。",
  "profiles.editor.name": "名前",
  "profiles.editor.nameHint":
    "英小文字か数字で始め、英小文字・数字・- で 40 文字まで。",
  "profiles.editor.preview": "保存すると版 {id} ができます。",
  "profiles.editor.models": "モデル",
  "profiles.editor.modelsHint":
    "セッションが選べるモデルです。基準にあるモデルだけを選べます。",
  "profiles.editor.defaultModel": "既定のモデル",
  "profiles.editor.toolsHint": "基準にあるツールだけをオンにできます。",
  "profiles.editor.modeHint":
    "基準と同じか、人がより多く確認するモードだけを選べます。",
  "profiles.editor.scriptCeiling": "スクリプト上限",
  "profiles.editor.scriptNone": "実行しない",
  "profiles.editor.scriptLater": "2a 段階から",
  "profiles.editor.scriptHint":
    "エージェントが拡張スクリプトを呼べる上限です。下げることだけができます。",
  "profiles.editor.saveNote":
    "新しい版として保存します。このプロファイルを使う release は新しい版に移すまで変わりません。",
  "profiles.editor.save": "新しい版として保存",
  "profiles.editor.saving": "保存中…",
  "profiles.editor.nameInvalid":
    "名前は英小文字か数字で始め、英小文字・数字・- で 40 文字までです。",
  "profiles.editor.modelsEmpty": "モデルを 1 つ以上選んでください。",
  "profiles.error.unknownBase":
    "運営者がその基準のプロファイルを削除しました。一覧を再読み込みしてください。",
  "profiles.error.widens":
    "基準のプロファイルが許可しない値です。一覧を再読み込みして基準を確認してください。",
  "profiles.error.versionTaken":
    "同じ名前の版がいま保存されました。もう一度保存すると次の版になります。",
  "profiles.saved": "版 {id} を作成しました。",
  "profiles.retireTitle": "版 {id} を引退させますか?",
  "profiles.retireText":
    "すでにこの版を使っている release とセッションは動き続けます。新しい release とセッションはこの版を選べません。元に戻せません。",
  "profiles.retiring": "引退させています…",
  "profiles.retired": "版 {id} を引退させました。",
};
