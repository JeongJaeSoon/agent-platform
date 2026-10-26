/** The run profiles screen (/profiles); every catalog spreads these in. */
export const profilesKo = {
  "nav.profiles": "실행 프로필",
  "profiles.title": "실행 프로필",
  "profiles.description":
    "에이전트가 어떤 엔진에서 도는지 정합니다. 모델, 도구, 저장소 사용 여부가 프로필마다 다릅니다. 누가 무슨 일을 하는지는 에이전트에서 정합니다.",
  "profiles.readOnlyTitle":
    "프로필은 설치 설정에서 정의합니다. 콘솔에서는 읽기만 합니다",
  "profiles.readOnlyText":
    "바꾸려면 설치 설정 파일을 고친 뒤 다시 배포하세요. 진행 중인 세션에는 영향이 없습니다.",
  "profiles.pickTitle": "내가 고를 수 있는 프로필입니다",
  "profiles.pickText":
    "보통은 에이전트가 정한 프로필을 그대로 씁니다. 다른 엔진이 필요할 때만 세션에서 바꿉니다.",
  "profiles.column.profile": "프로필",
  "profiles.column.model": "모델",
  "profiles.column.repository": "저장소",
  "profiles.column.tools": "도구",
  "profiles.column.billing": "비용",
  "profiles.runtime": "Claude Agent SDK {version}",
  "profiles.repository.required": "저장소 필요",
  "profiles.repository.optional": "저장소 선택",
  "profiles.repository.none": "저장소 쓰지 않음",
  "profiles.billing.metered": "비용 집계",
  "profiles.billing.none": "비용 집계 안 함",
  "profiles.noTools": "도구 없음",
  "profiles.empty": "이 설치에 실행 프로필이 없습니다.",
  "profiles.foot": "프로필 {count}개",
};

export const profilesEn: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "Run profiles",
  "profiles.title": "Run profiles",
  "profiles.description":
    "Which engine an agent runs on. Each profile has its own model, tools and use of a repository. What an agent does is set on the agent.",
  "profiles.readOnlyTitle":
    "Profiles are defined in the installation settings. The console only reads them",
  "profiles.readOnlyText":
    "To change one, edit the installation settings file and deploy again. Sessions in progress are not affected.",
  "profiles.pickTitle": "The profiles you can choose",
  "profiles.pickText":
    "Usually a session uses the profile its agent sets. Change it in the session only when you need another engine.",
  "profiles.column.profile": "Profile",
  "profiles.column.model": "Model",
  "profiles.column.repository": "Repository",
  "profiles.column.tools": "Tools",
  "profiles.column.billing": "Cost",
  "profiles.runtime": "Claude Agent SDK {version}",
  "profiles.repository.required": "Repository required",
  "profiles.repository.optional": "Repository optional",
  "profiles.repository.none": "No repository",
  "profiles.billing.metered": "Cost tracked",
  "profiles.billing.none": "No cost tracked",
  "profiles.noTools": "No tools",
  "profiles.empty": "This installation has no run profiles.",
  "profiles.foot": "{count} profiles",
};

export const profilesJa: Record<keyof typeof profilesKo, string> = {
  "nav.profiles": "実行プロファイル",
  "profiles.title": "実行プロファイル",
  "profiles.description":
    "エージェントがどのエンジンで動くかを決めます。モデル、ツール、リポジトリの使用はプロファイルごとに異なります。誰が何をするかはエージェントで決めます。",
  "profiles.readOnlyTitle":
    "プロファイルはインストール設定で定義します。コンソールでは読むだけです",
  "profiles.readOnlyText":
    "変更するにはインストール設定ファイルを直して再デプロイしてください。進行中のセッションには影響しません。",
  "profiles.pickTitle": "選べるプロファイルです",
  "profiles.pickText":
    "普段はエージェントが決めたプロファイルをそのまま使います。別のエンジンが必要なときだけセッションで変えます。",
  "profiles.column.profile": "プロファイル",
  "profiles.column.model": "モデル",
  "profiles.column.repository": "リポジトリ",
  "profiles.column.tools": "ツール",
  "profiles.column.billing": "コスト",
  "profiles.runtime": "Claude Agent SDK {version}",
  "profiles.repository.required": "リポジトリ必須",
  "profiles.repository.optional": "リポジトリ任意",
  "profiles.repository.none": "リポジトリを使わない",
  "profiles.billing.metered": "コスト集計",
  "profiles.billing.none": "コスト集計なし",
  "profiles.noTools": "ツールなし",
  "profiles.empty": "このインストールには実行プロファイルがありません。",
  "profiles.foot": "プロファイル {count} 件",
};
