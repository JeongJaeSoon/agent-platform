import { flowJa, formsJa, sessionsJa } from "@werft-ai/react";
import { agentsJa } from "./agents.ts";
import { apiKeysJa } from "./api-keys.ts";
import { authJa } from "./auth.ts";
import { commonJa } from "./common.ts";
import { errorsJa } from "./errors.ts";
import { homeJa } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedJa } from "./linked.ts";
import { membersJa } from "./members.ts";
import { modelsJa } from "./models.ts";
import { outputsJa } from "./outputs.ts";
import { preferencesJa } from "./preferences.ts";
import { sessionListJa } from "./session-list.ts";
import { shellJa } from "./shell.ts";
import { teamsJa } from "./teams.ts";
import { usageJa } from "./usage.ts";
import { workspaceJa } from "./workspace.ts";

export const slackJa = {
  "slack.error.config":
    "ワークスペースの Slack アプリ作成設定が必要です。管理者に設定を依頼してください。",
  "slack.error.creating":
    "アプリの作成結果を確認中です。管理者に Slack 上のアプリを確認してもらい、更新してください。",
  "slack.error.notInstalled":
    "チャンネルの接続前に Slack アプリをインストールしてください。",
  "slack.error.denied":
    "Slack のインストールが拒否されました。Slack タブから再インストールできます。",
  "slack.error.expired":
    "インストールリンクは期限切れか使用済みです。Slack タブから再インストールしてください。",
  "slack.error.rejected":
    "Slack アプリまたはワークスペースが一致しません。Slack タブからやり直してください。",
  "slack.error.cursor":
    "チャンネル一覧が更新されました。更新して最初から検索してください。",
  "agent.tabs.slack": "Slack",
  "agents.flow.channels": "チャンネル接続",
  "slack.app": "Slack アプリ",
  "slack.verifyNeeded":
    "アプリはインストール済みですが、イベント登録の確認が必要です。管理者に確認してください。",
  "slack.joinHintAuto":
    "公開チャンネルは応答をオンにするとボットが自動で参加します。非公開チャンネルには /invite でボットを招待してください。",
  "slack.appId": "アプリ ID",
  "slack.state.none": "作成前",
  "slack.state.pending": "インストール待ち",
  "slack.state.connected": "接続済み",
  "slack.state.reinstall": "再インストールが必要",
  "slack.eventsPending.title": "Slack で Request URL を Verify してください",
  "slack.eventsPending.body":
    "Slack がこのアプリの Request URL を確認するまで、招待・メンション・DM のイベントは届きません。アプリ設定の Event Subscriptions で Verify(または Retry)を押してください。確認が届くとこの案内は消えます。",
  "slack.eventsPending.open": "Event Subscriptions を開く",
  "slack.repositoryRequired.title": "Slack からはセッションを開始できません",
  "slack.repositoryRequired.body":
    "このエージェントのプロファイル（{profile}）はセッションごとにリポジトリの指定が必要です。Slack のメンションと DM ではリポジトリを選べないため拒否され、スレッドに案内だけが残ります。接続はできます。リポジトリが不要なプロファイルにリリースを切り替えるか、Web コンソールからセッションを開始してください。",
  "slack.state.error": "エラー",
  "slack.createInstall": "Slack アプリを作成してインストール",
  "slack.install": "Slack アプリをインストール",
  "slack.reinstall": "再インストール",
  "slack.working": "準備中…",
  "slack.refresh": "更新",
  "slack.delete": "アプリを削除",
  "slack.deleteTitle": "Slack アプリを削除",
  "slack.deleteWarning":
    "Slack からアプリを削除し、保存した認証情報も削除します。元に戻せません。もう一度接続すると新しいアプリが作られます。",
  "slack.deleted": "Slack アプリを削除しました。",
  "slack.revoke": "接続解除",
  "slack.revokeTitle": "Slack の接続を解除",
  "slack.revokeWarning":
    "このエージェントの Slack ID とチャンネル接続を解除します。以後のイベントは受信しません。Slack アプリは残り、再インストールできます。",
  "slack.revoked": "Slack の接続を解除しました。",
  "slack.activateFirst":
    "Slack アプリの作成前にエージェントを有効にしてください。",
  "slack.channels": "チャンネル",
  "slack.sectionNav": "Slack セクション",
  "slack.manage": "管理",
  "slack.saved": "チャンネルの応答を保存しました。",
  "slack.homeSaved": "ホームチャンネルを設定しました。",
  "slack.channelConnected": "チャンネルを接続しました。",
  "slack.dmSaved": "DM の設定を保存しました。",
  "slack.defaultSaved":
    "新しいチャンネルの既定の応答を「{mode}」に変更しました。接続済みのチャンネルはそのままです。",
  "slack.ambient": "常に応答",
  "slack.notConfigured": "未設定",
  "slack.home": "ホームチャンネル",
  "slack.setHome": "ホームに設定",
  "slack.channelHome": "{channel} をホームに設定",
  "slack.channelConnect": "{channel} に接続",
  "slack.connectedChannels": "接続済みチャンネル",
  "slack.noConnectedChannels": "接続済みチャンネルはありません",
  "slack.addChannelHint":
    "チャンネルを追加から、このエージェントが反応する場所を選んでください。",
  "slack.addChannel": "チャンネルを追加",
  "slack.basic": "基本",
  "slack.advanced": "詳細",
  "slack.connection": "接続",
  "slack.status": "状態",
  "slack.homeChannel": "ホームチャンネル",
  "slack.homeUnset": "未選択",
  "slack.channelId": "チャンネル ID: {id}",
  "slack.channelsLoading": "チャンネルを読み込み中",
  "slack.danger": "危険な操作",
  "slack.botId": "ボット ID",
  "slack.defaultHint":
    "オンにすると新しく追加したチャンネルでメンションに応答し、オフにすると応答しません。接続済みのチャンネルはそのままです。",
  "slack.dm": "ダイレクトメッセージ",
  "slack.dmSetting": "DM を受け取る",
  "slack.dmHint":
    "Slack アプリのメッセージタブで1対1の会話を受け取ります。Slack アカウントを連携したメンバーだけが使えます。",
  "slack.public": "公開",
  "slack.private": "非公開",
  "slack.off": "オフ",
  "slack.on": "オン",
  "slack.mention": "メンション時",
  "slack.reaction": "{channel} のメンションに応答",
  "slack.defaultReaction": "新しいチャンネルの既定の応答",
  "slack.search": "チャンネルを検索",
  "slack.invite": "参加待ち",
  "slack.privateInvite": "/invite が必要",
  "slack.add": "接続",
  "slack.noChannels":
    "チャンネルがありません。非公開チャンネルには /invite で先に招待してください。",
  "slack.partial":
    "一部のチャンネルが表示されないか、古い結果の可能性があります。",
  "slack.more": "もっと見る",
  "slack.reinstallTitle": "Slack アプリを再インストール",
  "slack.reinstallHint":
    "権限やイベント設定が変わったときに再インストールします。Slack の同意画面に移動します。",
  "slack.installHint":
    "Slack の同意画面に移動して、このワークスペースにアプリをインストールします。",
  "slack.installed": "Slack にアプリをインストールしました。",
  "slack.copyInvite": "/invite コマンドをコピー",
  "slack.inviteCommand": "/invite コマンド",
  "slack.copied": "コピーしました",
  "slack.copy": "コピー",
  "slack.copyAppId": "アプリ ID をコピー",
  "slack.copyAppIdFailed":
    "クリップボードにコピーできませんでした。アプリ ID を選択して手動でコピーしてください。",
  "slack.openInSlack": "Slack で開く",
  "slack.newTab": "(新しいタブで開きます)",
  "slack.copyFailed":
    "クリップボードにコピーできませんでした。選択されたコマンドを手動でコピーしてください。",
} as const;

export const ja: Record<MessageKey, string> = {
  ...slackJa,
  ...commonJa,
  ...shellJa,
  ...authJa,
  ...homeJa,
  ...membersJa,
  ...teamsJa,
  ...agentsJa,
  ...modelsJa,
  ...sessionsJa,
  ...sessionListJa,
  ...flowJa,
  ...linkedJa,
  ...outputsJa,
  ...apiKeysJa,
  ...workspaceJa,
  ...usageJa,
  ...preferencesJa,
  ...errorsJa,
  ...formsJa,
};
