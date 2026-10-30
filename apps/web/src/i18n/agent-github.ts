// The agent detail's GitHub tab (design github-agent.md §7). Kept apart from
// github.ts, which the workspace connection screen owns.
export const agentGitHubKo = {
  "agent.tabs.github": "GitHub",
  "agentGitHub.sectionNav": "GitHub 구역",
  "agentGitHub.manage": "관리",
  "agentGitHub.section.use": "사용",
  "agentGitHub.section.repositories": "저장소",
  "agentGitHub.section.permissions": "권한",
  "agentGitHub.section.allowlist": "Actions 허용 목록",
  "agentGitHub.section.push": "push 승인",
  "agentGitHub.section.activity": "최근 기록",
  "agentGitHub.status": "상태",
  "agentGitHub.state.on": "사용 중",
  "agentGitHub.state.off": "꺼짐",
  "agentGitHub.status.repositories": "저장소 {count}개",
  "agentGitHub.status.repositoriesLegacy": "저장소 프로필 전체",
  "agentGitHub.status.pushApproval": "push 전 승인",
  "agentGitHub.status.release": "릴리스",
  "agentGitHub.on": "켜짐",
  "agentGitHub.off": "꺼짐",
  "agentGitHub.badge.now": "즉시 반영",
  "agentGitHub.badge.release": "릴리스에 반영",
  "agentGitHub.badge.default": "기본",
  "agentGitHub.badge.unsaved": "저장 전",
  "agentGitHub.enabled": "GitHub 사용",
  "agentGitHub.enabledHint":
    "끄면 이 에이전트에 새 GitHub 토큰을 내주지 않습니다. 진행 중인 세션도 다음 GitHub 요청부터 거절됩니다. 릴리스를 거치지 않고 바로 반영됩니다.",
  "agentGitHub.disableTitle": "GitHub 사용을 끌까요?",
  "agentGitHub.disableBody":
    "진행 중인 세션도 다음 GitHub 요청부터 거절됩니다. clone, push, PR, 워크플로 실행이 모두 멈춥니다.",
  "agentGitHub.disableConfirm": "끄기",
  "agentGitHub.enabledOn": "GitHub 사용을 켰습니다.",
  "agentGitHub.enabledOff": "GitHub 사용을 껐습니다.",
  "agentGitHub.offNote":
    "GitHub 사용이 꺼져 있어 아래 설정은 읽기만 할 수 있습니다.",
  "agentGitHub.pending.title": "릴리스에 넣지 않은 변경 {count}건",
  "agentGitHub.pending.body":
    "저장하면 지금 카드 버전 v{version}과 실행 프로필 {profile}로 새 릴리스를 만들고 활성화합니다. 그 뒤에 시작하는 세션부터 적용되고, 진행 중인 세션은 이전 릴리스 설정을 씁니다.",
  "agentGitHub.pending.save": "새 릴리스로 저장",
  "agentGitHub.pending.saving": "저장하는 중…",
  "agentGitHub.pending.revert": "되돌리기",
  "agentGitHub.saved": "새 릴리스 {release}를 만들고 활성화했습니다.",
  "agentGitHub.savedExisting":
    "같은 설정의 릴리스 {release}가 이미 있어 그 릴리스를 활성화했습니다.",
  "agentGitHub.savedNotActivated":
    "릴리스 {release}를 만들었지만 활성화하지 못했습니다: {reason}",
  "agentGitHub.conflict":
    "다른 사람이 그 사이 에이전트를 활성화했습니다. 릴리스 탭에서 확인한 뒤 활성화하세요.",
  "agentGitHub.legacy":
    "이 릴리스에는 아직 GitHub 설정이 없어 실행 프로필이 허용하는 모든 저장소를 씁니다. 아래 값은 처음 저장할 때의 기본값입니다.",
  "agentGitHub.unsavable.title": "GitHub 설정을 저장할 수 없습니다",
  "agentGitHub.unsavable.no_active_release":
    "활성 릴리스가 없습니다. 릴리스 탭에서 릴리스를 만들고 활성화하면 GitHub 설정을 정할 수 있습니다.",
  "agentGitHub.unsavable.repository_none":
    "활성 릴리스에 저장소가 없습니다. 저장소가 있는 실행 프로필로 릴리스를 만들면 GitHub 설정을 정할 수 있습니다.",
  "agentGitHub.unsavable.app_required":
    "활성 릴리스의 저장소가 PAT로 연결되어 권한을 좁힐 수 없습니다. 운영자가 그 저장소를 GitHub App으로 옮기면 설정할 수 있습니다.",
  "agentGitHub.repositoriesHint":
    "GitHub App을 쓰는 카탈로그 저장소 가운데 고릅니다. 토큰은 고른 저장소 하나로만 좁혀 발급합니다.",
  "agentGitHub.repositoriesNone":
    "카탈로그에 GitHub 저장소가 없습니다. 운영자가 카탈로그에 추가합니다.",
  "agentGitHub.repositoryUse": "사용",
  "agentGitHub.repositoryUnused": "안 씀",
  "agentGitHub.repositoryRelease": "활성 릴리스의 저장소라 뺄 수 없습니다.",
  "agentGitHub.repositoryReason.repository_not_allowed":
    "실행 프로필이 이 저장소를 허용하지 않습니다.",
  "agentGitHub.repositoryReason.app_required":
    "PAT로 연결된 저장소라 권한을 좁힐 수 없습니다. GitHub App으로 옮겨야 고를 수 있습니다.",
  "agentGitHub.repositoriesFoot":
    "목록에 없는 저장소는 GitHub에서 App 설치에 더한 뒤 운영자가 카탈로그에 추가합니다.",
  "agentGitHub.permissionsHint":
    "기본은 PR 작성·수정까지입니다. 브랜치 보호·필수 리뷰·CODEOWNERS처럼 GitHub가 막는 것은 저장소 설정을 따릅니다. merge 권한은 없습니다.",
  "agentGitHub.base": "PR 작성·수정",
  "agentGitHub.baseHint":
    "agent/<세션> 브랜치로 push하고, PR을 열고 고치고, 코멘트를 남깁니다. 필요한 권한: contents·pull requests 쓰기",
  "agentGitHub.baseState": "항상 켜짐",
  "agentGitHub.feature.review": "리뷰 승인",
  "agentGitHub.feature.reviewHint":
    "리뷰용 App으로 PR에 승인 리뷰를 남깁니다. 필수 리뷰·CODEOWNERS는 저장소의 GitHub 설정을 따릅니다. 필요한 권한: 리뷰용 App의 pull requests 쓰기",
  "agentGitHub.feature.actions": "Actions 실행",
  "agentGitHub.feature.actionsHint":
    "허용 목록의 워크플로만 실행(workflow_dispatch)하거나 다시 실행합니다. 필요한 권한: actions 쓰기",
  "agentGitHub.feature.checks": "검사 결과 쓰기",
  "agentGitHub.feature.checksHint":
    "check run을 만들고 결과를 올립니다. 필요한 권한: checks 쓰기",
  "agentGitHub.feature.issues": "이슈 쓰기",
  "agentGitHub.feature.issuesHint":
    "이슈를 열고 코멘트를 남깁니다. 필요한 권한: issues 쓰기",
  "agentGitHub.feature.workflows": "워크플로 파일 수정",
  "agentGitHub.feature.workflowsHint":
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다. 필요한 권한: workflows 쓰기",
  "agentGitHub.featureReason.app_permission_missing":
    "App에 이 권한이 없습니다. GitHub App 설정에서 더한 뒤 설치를 다시 승인하세요.",
  "agentGitHub.featureReason.over_workspace_ceiling":
    "워크스페이스 상한 밖입니다. 소유자·관리자가 GitHub 연결 설정에서 켭니다.",
  "agentGitHub.featureReason.no_reviewer_app":
    "워크스페이스에 리뷰용 App이 없습니다. PR을 만드는 App은 자기 PR을 승인할 수 없습니다.",
  "agentGitHub.featureReason.github_host_unsupported":
    "고른 저장소가 모두 GitHub Enterprise에 있어 기본 작업만 할 수 있습니다.",
  "agentGitHub.settingsLink": "GitHub 연결 설정",
  "agentGitHub.workflowsActions":
    "워크플로 파일 수정과 Actions 실행을 같이 켜면, 에이전트가 허용 목록의 워크플로 파일을 자기 브랜치에서 고칠 수 있습니다. 사람이 그 브랜치를 머지하면 고친 파일이 실행 대상이 됩니다.",
  "agentGitHub.ceilingNote":
    "워크스페이스 상한은 소유자·관리자가 GitHub 연결 설정에서 정합니다.",
  "agentGitHub.allowlistHint":
    "Actions 실행이 켜져 있을 때 이 목록의 워크플로만 실행하거나 다시 실행합니다. 목록 밖의 workflow_dispatch와 다시 실행은 거절합니다.",
  "agentGitHub.allowlistEmpty": "목록에 없는 워크플로는 실행하지 않습니다.",
  "agentGitHub.allowlistOff":
    "Actions 실행을 켜면 실행할 워크플로를 고를 수 있습니다.",
  "agentGitHub.refDefault": "기본 브랜치만",
  "agentGitHub.refPattern": "ref 패턴 {ref}",
  "agentGitHub.remove": "빼기",
  "agentGitHub.removeLabel": "{workflow} 빼기",
  "agentGitHub.workflow": "워크플로 파일",
  "agentGitHub.workflowHint": ".github/workflows 아래의 파일 이름",
  "agentGitHub.ref": "ref 패턴(선택)",
  "agentGitHub.refHint": "비우면 기본 브랜치만. * 는 / 를 넘지 않습니다.",
  "agentGitHub.add": "워크플로 추가",
  "agentGitHub.workflowInvalid":
    "release.yml처럼 .yml이나 .yaml로 끝나는 파일 이름만 넣으세요. 경로는 받지 않습니다.",
  "agentGitHub.refAgent":
    "agent/ 브랜치는 에이전트가 내용을 정하므로 실행 대상이 될 수 없습니다.",
  "agentGitHub.refInvalid": "ref 패턴은 255자 이하로 넣으세요.",
  "agentGitHub.duplicate": "이미 목록에 있는 항목입니다.",
  "agentGitHub.full": "허용 목록은 32개까지입니다.",
  "agentGitHub.allowlistNote":
    "push나 pull_request로 자동 실행되는 워크플로는 막지 않습니다. 저장소의 Actions 설정을 따릅니다. 허용 목록에 넣는 워크플로는 입력값으로 실행할 코드나 checkout ref를 고르지 않아야 합니다.",
  "agentGitHub.pushApproval": "push 전 사람 승인",
  "agentGitHub.pushApprovalHint":
    "켜면 에이전트가 만든 commit을 sessions:approve 권한이 있는 사람이 승인해야 push합니다. 기존 에이전트는 켜진 채로 옮겨졌습니다.",
  "agentGitHub.pushApprovalOff":
    "승인 없이 agent/<세션> 브랜치로 push하고 PR을 엽니다.",
  "agentGitHub.activityHint":
    "토큰 발급과 거절, 설정 변경, 워크플로 실행은 감사 기록(receipt)에 남습니다. 볼 수 있는 세션의 기록만 보입니다.",
  "agentGitHub.activityEmpty": "아직 GitHub 기록이 없습니다.",
  "agentGitHub.activity.set_agent_github.on": "GitHub 사용 켬",
  "agentGitHub.activity.set_agent_github.off": "GitHub 사용 끔",
  "agentGitHub.activity.create_agent_release": "GitHub 설정을 바꾼 릴리스",
  "agentGitHub.activity.activate_agent": "GitHub 설정을 바꾼 활성화",
  "agentGitHub.activity.mint_github_token": "토큰 발급",
  "agentGitHub.activity.mint_github_token.failed": "토큰 거절",
  "agentGitHub.activity.dispatch_workflow": "워크플로 실행",
  "agentGitHub.activity.dispatch_workflow.failed": "워크플로 실행 거절",
  "agentGitHub.activity.rerun_workflow": "워크플로 다시 실행",
  "agentGitHub.activity.rerun_workflow.failed": "다시 실행 거절",
  "agentGitHub.activity.review_pull_request": "리뷰",
  "agentGitHub.activity.review_pull_request.failed": "리뷰 거절",
  "agentGitHub.activity.session": "세션",
  "agentGitHub.activity.release": "릴리스 {release}",
  "agentGitHub.purpose.clone": "clone",
  "agentGitHub.purpose.push": "push",
  "agentGitHub.purpose.pull_request": "PR",
  "agentGitHub.purpose.actions_read": "실행 조회",
  "agentGitHub.purpose.dispatch": "워크플로 실행",
  "agentGitHub.purpose.rerun": "다시 실행",
  "agentGitHub.purpose.review": "리뷰",
  "agentGitHub.purpose.outcome_refresh": "PR 상태 확인",
  "agentGitHub.refusal.github_disabled": "GitHub 사용 꺼짐",
  "agentGitHub.refusal.repository_not_allowed": "저장소 범위 밖",
  "agentGitHub.refusal.feature_off": "릴리스에서 꺼진 권한",
  "agentGitHub.refusal.over_workspace_ceiling": "워크스페이스 상한 밖",
  "agentGitHub.refusal.app_permission_missing": "App 권한 없음",
  "agentGitHub.refusal.no_reviewer_app": "리뷰용 App 없음",
  "agentGitHub.refusal.app_required": "GitHub App 필요",
  "agentGitHub.refusal.workflow_not_allowed": "허용 목록 밖",
  "agentGitHub.refusal.agent_ref_refused": "agent/ 브랜치 실행 거절",
  "agentGitHub.refusal.run_ref_unprovable": "플랫폼이 실행하지 않은 run",
  "agentGitHub.refusal.actions_off": "Actions 실행 꺼짐",
  "agentGitHub.refusal.github_settings_unsupported": "이 서버가 모르는 설정",
  "agentGitHub.refusal.github_host_unsupported": "GitHub Enterprise",
  "agentGitHub.refusal.repository_none": "저장소 없음",
  "agentGitHub.saveRefused": "저장하지 못했습니다: {reason}",
  "agentGitHub.refused": "거절",
};

export const agentGitHubEn: Record<keyof typeof agentGitHubKo, string> = {
  "agent.tabs.github": "GitHub",
  "agentGitHub.sectionNav": "GitHub sections",
  "agentGitHub.manage": "Manage",
  "agentGitHub.section.use": "Use",
  "agentGitHub.section.repositories": "Repositories",
  "agentGitHub.section.permissions": "Permissions",
  "agentGitHub.section.allowlist": "Actions allow list",
  "agentGitHub.section.push": "Push approval",
  "agentGitHub.section.activity": "Recent activity",
  "agentGitHub.status": "Status",
  "agentGitHub.state.on": "In use",
  "agentGitHub.state.off": "Off",
  "agentGitHub.status.repositories": "{count} repositories",
  "agentGitHub.status.repositoriesLegacy": "Repositories: the whole profile",
  "agentGitHub.status.pushApproval": "Approval before push",
  "agentGitHub.status.release": "Release",
  "agentGitHub.on": "On",
  "agentGitHub.off": "Off",
  "agentGitHub.badge.now": "Applies now",
  "agentGitHub.badge.release": "Saved in a release",
  "agentGitHub.badge.default": "Default",
  "agentGitHub.badge.unsaved": "Unsaved",
  "agentGitHub.enabled": "Use GitHub",
  "agentGitHub.enabledHint":
    "When off, this agent gets no new GitHub token. Running sessions are refused from their next GitHub request. Applies at once, without a release.",
  "agentGitHub.disableTitle": "Turn GitHub off?",
  "agentGitHub.disableBody":
    "Running sessions are refused from their next GitHub request. Clone, push, pull requests and workflow runs all stop.",
  "agentGitHub.disableConfirm": "Turn off",
  "agentGitHub.enabledOn": "GitHub is on.",
  "agentGitHub.enabledOff": "GitHub is off.",
  "agentGitHub.offNote": "GitHub is off, so the settings below are read only.",
  "agentGitHub.pending.title": "{count} changes not in a release",
  "agentGitHub.pending.body":
    "Saving makes a new release of card version v{version} with runtime profile {profile} and activates it. Sessions started after that use it; running sessions keep the earlier release's settings.",
  "agentGitHub.pending.save": "Save as a new release",
  "agentGitHub.pending.saving": "Saving…",
  "agentGitHub.pending.revert": "Revert",
  "agentGitHub.saved": "Made and activated release {release}.",
  "agentGitHub.savedExisting":
    "Release {release} already had these settings; it is now active.",
  "agentGitHub.savedNotActivated":
    "Made release {release} but could not activate it: {reason}",
  "agentGitHub.conflict":
    "Someone activated the agent meanwhile. Check the Release tab, then activate.",
  "agentGitHub.legacy":
    "This release has no GitHub settings yet, so it uses every repository its runtime profile allows. The values below are what a first save starts from.",
  "agentGitHub.unsavable.title": "GitHub settings cannot be saved",
  "agentGitHub.unsavable.no_active_release":
    "There is no active release. Make and activate one in the Release tab to set GitHub up.",
  "agentGitHub.unsavable.repository_none":
    "The active release has no repository. Release under a runtime profile with one to set GitHub up.",
  "agentGitHub.unsavable.app_required":
    "The active release's repository connects with a PAT, which cannot be narrowed. It can be set up once the operator moves it to a GitHub App.",
  "agentGitHub.repositoriesHint":
    "Pick from the catalog's repositories that use a GitHub App. Each token is narrowed to the one repository.",
  "agentGitHub.repositoriesNone":
    "The catalog has no GitHub repository. The operator adds them.",
  "agentGitHub.repositoryUse": "Used",
  "agentGitHub.repositoryUnused": "Not used",
  "agentGitHub.repositoryRelease": "The active release's repository; it stays.",
  "agentGitHub.repositoryReason.repository_not_allowed":
    "The runtime profile does not allow this repository.",
  "agentGitHub.repositoryReason.app_required":
    "It connects with a PAT, which cannot be narrowed. Move it to a GitHub App to pick it.",
  "agentGitHub.repositoriesFoot":
    "To add a repository, add it to the App's installation on GitHub; the operator then adds it to the catalog.",
  "agentGitHub.permissionsHint":
    "By default an agent writes pull requests and nothing more. What GitHub enforces, such as branch protection, required reviews and CODEOWNERS, follows the repository's settings. There is no merge permission.",
  "agentGitHub.base": "Write pull requests",
  "agentGitHub.baseHint":
    "Pushes to agent/<session> branches, opens and updates pull requests, comments. Needs: contents and pull requests write",
  "agentGitHub.baseState": "Always on",
  "agentGitHub.feature.review": "Approve reviews",
  "agentGitHub.feature.reviewHint":
    "Leaves approving reviews with the reviewer App. Required reviews and CODEOWNERS follow the repository's GitHub settings. Needs: the reviewer App's pull requests write",
  "agentGitHub.feature.actions": "Run Actions",
  "agentGitHub.feature.actionsHint":
    "Runs (workflow_dispatch) or reruns only workflows on the allow list. Needs: actions write",
  "agentGitHub.feature.checks": "Write checks",
  "agentGitHub.feature.checksHint":
    "Creates check runs and reports results. Needs: checks write",
  "agentGitHub.feature.issues": "Write issues",
  "agentGitHub.feature.issuesHint":
    "Opens issues and comments on them. Needs: issues write",
  "agentGitHub.feature.workflows": "Edit workflow files",
  "agentGitHub.feature.workflowsHint":
    "Also pushes commits that change files under .github/workflows. Needs: workflows write",
  "agentGitHub.featureReason.app_permission_missing":
    "The App lacks this permission. Add it in the GitHub App's settings, then approve the installation again.",
  "agentGitHub.featureReason.over_workspace_ceiling":
    "Over the workspace ceiling. Owners and admins turn it on in the GitHub connection settings.",
  "agentGitHub.featureReason.no_reviewer_app":
    "The workspace has no reviewer App. The App that writes pull requests cannot approve its own.",
  "agentGitHub.featureReason.github_host_unsupported":
    "Every chosen repository is on GitHub Enterprise, which takes the default work only.",
  "agentGitHub.settingsLink": "GitHub connection settings",
  "agentGitHub.workflowsActions":
    "With workflow edits and Actions both on, the agent can change an allowed workflow file on its own branch. Once a person merges that branch, the changed file is what runs.",
  "agentGitHub.ceilingNote":
    "Owners and admins set the workspace ceiling in the GitHub connection settings.",
  "agentGitHub.allowlistHint":
    "With Run Actions on, only workflows on this list run or rerun. Any other workflow_dispatch or rerun is refused.",
  "agentGitHub.allowlistEmpty": "No workflow outside the list runs.",
  "agentGitHub.allowlistOff":
    "Turn Run Actions on to pick the workflows it may run.",
  "agentGitHub.refDefault": "Default branch only",
  "agentGitHub.refPattern": "ref pattern {ref}",
  "agentGitHub.remove": "Remove",
  "agentGitHub.removeLabel": "Remove {workflow}",
  "agentGitHub.workflow": "Workflow file",
  "agentGitHub.workflowHint": "A file name under .github/workflows",
  "agentGitHub.ref": "ref pattern (optional)",
  "agentGitHub.refHint": "Empty: the default branch only. * does not cross /.",
  "agentGitHub.add": "Add workflow",
  "agentGitHub.workflowInvalid":
    "Enter a file name ending in .yml or .yaml, such as release.yml. Paths are not taken.",
  "agentGitHub.refAgent":
    "agent/ branches hold what the agent wrote, so they never run.",
  "agentGitHub.refInvalid": "Keep the ref pattern to 255 characters.",
  "agentGitHub.duplicate": "That entry is already on the list.",
  "agentGitHub.full": "The allow list holds up to 32 entries.",
  "agentGitHub.allowlistNote":
    "Workflows that run on push or pull_request are not blocked; the repository's Actions settings decide. A workflow on this list must not let its inputs choose the code it runs or the ref it checks out.",
  "agentGitHub.pushApproval": "Approve before push",
  "agentGitHub.pushApprovalHint":
    "When on, someone with sessions:approve approves the agent's commits before they are pushed. Existing agents moved over with it on.",
  "agentGitHub.pushApprovalOff":
    "Pushes to agent/<session> branches and opens pull requests without approval.",
  "agentGitHub.activityHint":
    "Tokens issued or refused, setting changes and workflow runs are kept as receipts. Only sessions you can see are shown.",
  "agentGitHub.activityEmpty": "No GitHub activity yet.",
  "agentGitHub.activity.set_agent_github.on": "GitHub turned on",
  "agentGitHub.activity.set_agent_github.off": "GitHub turned off",
  "agentGitHub.activity.create_agent_release":
    "Release with changed GitHub settings",
  "agentGitHub.activity.activate_agent":
    "Activation that changed GitHub settings",
  "agentGitHub.activity.mint_github_token": "Token issued",
  "agentGitHub.activity.mint_github_token.failed": "Token refused",
  "agentGitHub.activity.dispatch_workflow": "Workflow run",
  "agentGitHub.activity.dispatch_workflow.failed": "Workflow run refused",
  "agentGitHub.activity.rerun_workflow": "Workflow rerun",
  "agentGitHub.activity.rerun_workflow.failed": "Rerun refused",
  "agentGitHub.activity.review_pull_request": "Review",
  "agentGitHub.activity.review_pull_request.failed": "Review refused",
  "agentGitHub.activity.session": "Session",
  "agentGitHub.activity.release": "Release {release}",
  "agentGitHub.purpose.clone": "clone",
  "agentGitHub.purpose.push": "push",
  "agentGitHub.purpose.pull_request": "pull request",
  "agentGitHub.purpose.actions_read": "run lookup",
  "agentGitHub.purpose.dispatch": "workflow run",
  "agentGitHub.purpose.rerun": "rerun",
  "agentGitHub.purpose.review": "review",
  "agentGitHub.purpose.outcome_refresh": "pull request check",
  "agentGitHub.refusal.github_disabled": "GitHub off",
  "agentGitHub.refusal.repository_not_allowed": "Repository out of scope",
  "agentGitHub.refusal.feature_off": "Permission off in the release",
  "agentGitHub.refusal.over_workspace_ceiling": "Over the workspace ceiling",
  "agentGitHub.refusal.app_permission_missing": "App lacks the permission",
  "agentGitHub.refusal.no_reviewer_app": "No reviewer App",
  "agentGitHub.refusal.app_required": "Needs a GitHub App",
  "agentGitHub.refusal.workflow_not_allowed": "Not on the allow list",
  "agentGitHub.refusal.agent_ref_refused": "agent/ branch refused",
  "agentGitHub.refusal.run_ref_unprovable": "A run the platform did not start",
  "agentGitHub.refusal.actions_off": "Run Actions off",
  "agentGitHub.refusal.github_settings_unsupported":
    "Settings this server does not know",
  "agentGitHub.refusal.github_host_unsupported": "GitHub Enterprise",
  "agentGitHub.refusal.repository_none": "No repository",
  "agentGitHub.saveRefused": "Not saved: {reason}",
  "agentGitHub.refused": "Refused",
};

export const agentGitHubJa: Record<keyof typeof agentGitHubKo, string> = {
  "agent.tabs.github": "GitHub",
  "agentGitHub.sectionNav": "GitHub の項目",
  "agentGitHub.manage": "管理",
  "agentGitHub.section.use": "利用",
  "agentGitHub.section.repositories": "リポジトリ",
  "agentGitHub.section.permissions": "権限",
  "agentGitHub.section.allowlist": "Actions 許可リスト",
  "agentGitHub.section.push": "push の承認",
  "agentGitHub.section.activity": "最近の記録",
  "agentGitHub.status": "状態",
  "agentGitHub.state.on": "利用中",
  "agentGitHub.state.off": "オフ",
  "agentGitHub.status.repositories": "リポジトリ {count} 件",
  "agentGitHub.status.repositoriesLegacy": "リポジトリ: プロファイル全体",
  "agentGitHub.status.pushApproval": "push 前の承認",
  "agentGitHub.status.release": "リリース",
  "agentGitHub.on": "オン",
  "agentGitHub.off": "オフ",
  "agentGitHub.badge.now": "すぐ反映",
  "agentGitHub.badge.release": "リリースに反映",
  "agentGitHub.badge.default": "既定",
  "agentGitHub.badge.unsaved": "未保存",
  "agentGitHub.enabled": "GitHub を使う",
  "agentGitHub.enabledHint":
    "オフにすると、このエージェントに新しい GitHub トークンを出しません。実行中のセッションも次の GitHub リクエストから拒否されます。リリースを経ずにすぐ反映されます。",
  "agentGitHub.disableTitle": "GitHub をオフにしますか?",
  "agentGitHub.disableBody":
    "実行中のセッションも次の GitHub リクエストから拒否されます。clone、push、PR、ワークフロー実行がすべて止まります。",
  "agentGitHub.disableConfirm": "オフにする",
  "agentGitHub.enabledOn": "GitHub をオンにしました。",
  "agentGitHub.enabledOff": "GitHub をオフにしました。",
  "agentGitHub.offNote": "GitHub がオフのため、以下の設定は読むだけです。",
  "agentGitHub.pending.title": "リリースに入れていない変更 {count} 件",
  "agentGitHub.pending.body":
    "保存すると、いまのカードバージョン v{version} と実行プロファイル {profile} で新しいリリースを作り、有効にします。その後に始まるセッションから適用され、実行中のセッションは以前のリリースの設定を使います。",
  "agentGitHub.pending.save": "新しいリリースとして保存",
  "agentGitHub.pending.saving": "保存しています…",
  "agentGitHub.pending.revert": "元に戻す",
  "agentGitHub.saved": "新しいリリース {release} を作り、有効にしました。",
  "agentGitHub.savedExisting":
    "同じ設定のリリース {release} があったため、それを有効にしました。",
  "agentGitHub.savedNotActivated":
    "リリース {release} を作りましたが、有効にできませんでした: {reason}",
  "agentGitHub.conflict":
    "その間に別の人がエージェントを有効にしました。リリースタブで確認してから有効にしてください。",
  "agentGitHub.legacy":
    "このリリースにはまだ GitHub の設定がないため、実行プロファイルが許可するすべてのリポジトリを使います。以下は初めて保存するときの既定値です。",
  "agentGitHub.unsavable.title": "GitHub の設定を保存できません",
  "agentGitHub.unsavable.no_active_release":
    "有効なリリースがありません。リリースタブでリリースを作って有効にすると、GitHub を設定できます。",
  "agentGitHub.unsavable.repository_none":
    "有効なリリースにリポジトリがありません。リポジトリのある実行プロファイルでリリースすると設定できます。",
  "agentGitHub.unsavable.app_required":
    "有効なリリースのリポジトリは PAT で接続されていて、権限を絞れません。運用者が GitHub App に移すと設定できます。",
  "agentGitHub.repositoriesHint":
    "GitHub App を使うカタログのリポジトリから選びます。トークンは選んだリポジトリ 1 つに絞って発行します。",
  "agentGitHub.repositoriesNone":
    "カタログに GitHub のリポジトリがありません。運用者が追加します。",
  "agentGitHub.repositoryUse": "使う",
  "agentGitHub.repositoryUnused": "使わない",
  "agentGitHub.repositoryRelease":
    "有効なリリースのリポジトリのため外せません。",
  "agentGitHub.repositoryReason.repository_not_allowed":
    "実行プロファイルがこのリポジトリを許可していません。",
  "agentGitHub.repositoryReason.app_required":
    "PAT で接続されたリポジトリのため権限を絞れません。GitHub App に移すと選べます。",
  "agentGitHub.repositoriesFoot":
    "一覧にないリポジトリは、GitHub で App のインストールに加えたあと運用者がカタログに追加します。",
  "agentGitHub.permissionsHint":
    "既定は PR の作成・修正までです。ブランチ保護・必須レビュー・CODEOWNERS のように GitHub が止めるものはリポジトリの設定に従います。merge の権限はありません。",
  "agentGitHub.base": "PR の作成・修正",
  "agentGitHub.baseHint":
    "agent/<セッション> ブランチに push し、PR を開いて直し、コメントを残します。必要な権限: contents・pull requests の書き込み",
  "agentGitHub.baseState": "常にオン",
  "agentGitHub.feature.review": "レビュー承認",
  "agentGitHub.feature.reviewHint":
    "レビュー用 App で PR に承認レビューを残します。必須レビュー・CODEOWNERS はリポジトリの GitHub 設定に従います。必要な権限: レビュー用 App の pull requests の書き込み",
  "agentGitHub.feature.actions": "Actions の実行",
  "agentGitHub.feature.actionsHint":
    "許可リストのワークフローだけを実行(workflow_dispatch)または再実行します。必要な権限: actions の書き込み",
  "agentGitHub.feature.checks": "チェック結果の書き込み",
  "agentGitHub.feature.checksHint":
    "check run を作って結果を上げます。必要な権限: checks の書き込み",
  "agentGitHub.feature.issues": "Issue の書き込み",
  "agentGitHub.feature.issuesHint":
    "Issue を開いてコメントを残します。必要な権限: issues の書き込み",
  "agentGitHub.feature.workflows": "ワークフローファイルの変更",
  "agentGitHub.feature.workflowsHint":
    ".github/workflows 以下のファイルを変えた commit も push します。必要な権限: workflows の書き込み",
  "agentGitHub.featureReason.app_permission_missing":
    "App にこの権限がありません。GitHub App の設定で加えてから、インストールを承認し直してください。",
  "agentGitHub.featureReason.over_workspace_ceiling":
    "ワークスペースの上限の外です。オーナー・管理者が GitHub 連携の設定でオンにします。",
  "agentGitHub.featureReason.no_reviewer_app":
    "ワークスペースにレビュー用 App がありません。PR を作る App は自分の PR を承認できません。",
  "agentGitHub.featureReason.github_host_unsupported":
    "選んだリポジトリがすべて GitHub Enterprise にあるため、基本の作業だけができます。",
  "agentGitHub.settingsLink": "GitHub 連携の設定",
  "agentGitHub.workflowsActions":
    "ワークフローファイルの変更と Actions の実行を両方オンにすると、エージェントが許可リストのワークフローファイルを自分のブランチで変えられます。人がそのブランチをマージすると、変えたファイルが実行対象になります。",
  "agentGitHub.ceilingNote":
    "ワークスペースの上限はオーナー・管理者が GitHub 連携の設定で決めます。",
  "agentGitHub.allowlistHint":
    "Actions の実行がオンのとき、このリストのワークフローだけを実行・再実行します。リスト外の workflow_dispatch と再実行は拒否します。",
  "agentGitHub.allowlistEmpty": "リストにないワークフローは実行しません。",
  "agentGitHub.allowlistOff":
    "Actions の実行をオンにすると、実行するワークフローを選べます。",
  "agentGitHub.refDefault": "既定のブランチのみ",
  "agentGitHub.refPattern": "ref パターン {ref}",
  "agentGitHub.remove": "外す",
  "agentGitHub.removeLabel": "{workflow} を外す",
  "agentGitHub.workflow": "ワークフローファイル",
  "agentGitHub.workflowHint": ".github/workflows 以下のファイル名",
  "agentGitHub.ref": "ref パターン(任意)",
  "agentGitHub.refHint": "空なら既定のブランチのみ。* は / をまたぎません。",
  "agentGitHub.add": "ワークフローを追加",
  "agentGitHub.workflowInvalid":
    "release.yml のように .yml か .yaml で終わるファイル名だけを入れてください。パスは受け付けません。",
  "agentGitHub.refAgent":
    "agent/ ブランチはエージェントが中身を決めるため、実行対象にできません。",
  "agentGitHub.refInvalid": "ref パターンは 255 文字以下にしてください。",
  "agentGitHub.duplicate": "すでにリストにある項目です。",
  "agentGitHub.full": "許可リストは 32 件までです。",
  "agentGitHub.allowlistNote":
    "push や pull_request で自動実行されるワークフローは止めません。リポジトリの Actions 設定に従います。許可リストに入れるワークフローは、入力値で実行するコードや checkout する ref を選ばないものにしてください。",
  "agentGitHub.pushApproval": "push 前の人の承認",
  "agentGitHub.pushApprovalHint":
    "オンにすると、エージェントが作った commit を sessions:approve 権限のある人が承認してから push します。既存のエージェントはオンのまま移行しました。",
  "agentGitHub.pushApprovalOff":
    "承認なしで agent/<セッション> ブランチに push し、PR を開きます。",
  "agentGitHub.activityHint":
    "トークンの発行と拒否、設定の変更、ワークフローの実行は監査記録(receipt)に残ります。見られるセッションの記録だけを表示します。",
  "agentGitHub.activityEmpty": "まだ GitHub の記録がありません。",
  "agentGitHub.activity.set_agent_github.on": "GitHub をオン",
  "agentGitHub.activity.set_agent_github.off": "GitHub をオフ",
  "agentGitHub.activity.create_agent_release": "GitHub 設定を変えたリリース",
  "agentGitHub.activity.activate_agent": "GitHub 設定を変えた有効化",
  "agentGitHub.activity.mint_github_token": "トークン発行",
  "agentGitHub.activity.mint_github_token.failed": "トークン拒否",
  "agentGitHub.activity.dispatch_workflow": "ワークフロー実行",
  "agentGitHub.activity.dispatch_workflow.failed": "ワークフロー実行の拒否",
  "agentGitHub.activity.rerun_workflow": "ワークフロー再実行",
  "agentGitHub.activity.rerun_workflow.failed": "再実行の拒否",
  "agentGitHub.activity.review_pull_request": "レビュー",
  "agentGitHub.activity.review_pull_request.failed": "レビューの拒否",
  "agentGitHub.activity.session": "セッション",
  "agentGitHub.activity.release": "リリース {release}",
  "agentGitHub.purpose.clone": "clone",
  "agentGitHub.purpose.push": "push",
  "agentGitHub.purpose.pull_request": "PR",
  "agentGitHub.purpose.actions_read": "実行の照会",
  "agentGitHub.purpose.dispatch": "ワークフロー実行",
  "agentGitHub.purpose.rerun": "再実行",
  "agentGitHub.purpose.review": "レビュー",
  "agentGitHub.purpose.outcome_refresh": "PR の状態確認",
  "agentGitHub.refusal.github_disabled": "GitHub オフ",
  "agentGitHub.refusal.repository_not_allowed": "リポジトリの範囲外",
  "agentGitHub.refusal.feature_off": "リリースでオフの権限",
  "agentGitHub.refusal.over_workspace_ceiling": "ワークスペースの上限外",
  "agentGitHub.refusal.app_permission_missing": "App の権限なし",
  "agentGitHub.refusal.no_reviewer_app": "レビュー用 App なし",
  "agentGitHub.refusal.app_required": "GitHub App が必要",
  "agentGitHub.refusal.workflow_not_allowed": "許可リスト外",
  "agentGitHub.refusal.agent_ref_refused": "agent/ ブランチの実行拒否",
  "agentGitHub.refusal.run_ref_unprovable":
    "プラットフォームが始めていない run",
  "agentGitHub.refusal.actions_off": "Actions の実行オフ",
  "agentGitHub.refusal.github_settings_unsupported":
    "このサーバーが知らない設定",
  "agentGitHub.refusal.github_host_unsupported": "GitHub Enterprise",
  "agentGitHub.refusal.repository_none": "リポジトリなし",
  "agentGitHub.saveRefused": "保存できませんでした: {reason}",
  "agentGitHub.refused": "拒否",
};
