# Garuda 向けセットアップ

この文書は `asura-ai-dev/clawsweeper` から private repository
`asura-ai-dev/garuda` をレビュー・保守するための人間側セットアップ手順です。
秘密値の作成・登録、GitHub App の作成・install、state repository の作成、Cloudflare
の deploy はこのリポジトリのコード変更には含まれません。

## 1. GitHub App を作成する

GitHub の **Settings → Developer settings → GitHub Apps → New GitHub App** で専用 App
を作成します。Webhook を受ける構成にする場合は Webhook URL と
`CLAWSWEEPER_WEBHOOK_SECRET` を設定し、少なくとも Issue、Pull request、Issue comment、
Pull request review、Pull request review comment のイベントを購読します。

コード中の `actions/create-github-app-token` 要求を集約すると、Repository permissions は
次のとおりです。最初は read-only lane に必要な権限だけを付与し、apply/repair を有効化する
直前に write 権限を追加しても構いません。

| Permission      | Review | Apply / repair / commit-review |
| --------------- | ------ | ------------------------------ |
| Metadata        | Read   | Read                           |
| Actions         | Read   | Read and write                 |
| Checks          | Read   | Read and write                 |
| Contents        | Read   | Read and write                 |
| Issues          | Read   | Read and write                 |
| Pull requests   | Read   | Read and write                 |
| Commit statuses | Read   | Read                           |
| Workflows       | -      | Read and write                 |

App は **Only on this account** 相当にし、最初は `asura-ai-dev/garuda` と
`asura-ai-dev/clawsweeper` のみに install します。専用 state repository を作る場合は、
作成後に `asura-ai-dev/clawsweeper-state` も installation 対象へ追加してください。
秘密鍵 (`.pem`) はダウンロード後に安全な保管場所へ移し、リポジトリへ追加しません。

## 2. Secrets を設定する

以下は制御リポジトリ `asura-ai-dev/clawsweeper` に設定します。コマンドは対話入力または
ローカルファイルから値を読み込ませ、shell history に秘密値を直接書かない形にします。

```bash
gh secret set CLAWSWEEPER_APP_PRIVATE_KEY --repo asura-ai-dev/clawsweeper < /secure/path/garuda-clawsweeper.pem
gh secret set OPENAI_API_KEY --repo asura-ai-dev/clawsweeper
gh secret set CLAWSWEEPER_MODEL --repo asura-ai-dev/clawsweeper
gh secret set CLAWSWEEPER_WEBHOOK_SECRET --repo asura-ai-dev/clawsweeper
gh secret set CLAWSWEEPER_STATUS_INGEST_TOKEN --repo asura-ai-dev/clawsweeper
```

- `CLAWSWEEPER_APP_PRIVATE_KEY`: 上で作成した GitHub App の秘密鍵。
- `OPENAI_API_KEY`: Codex 実行用 API key。
- `CLAWSWEEPER_MODEL`: 利用する model alias。実値は契約・運用側で決めます。
- `CLAWSWEEPER_WEBHOOK_SECRET`: queue/webhook payload の署名検証用。受信側と同じ値を設定します。
- `CLAWSWEEPER_STATUS_INGEST_TOKEN`: 独自 status ingest を使う場合の token。Cloudflare dashboard
  を省略する初期 review-only 運用では status publish は無効のままで構いません。

Garuda では CrabFleet steering と OpenClaw Discord/hook 通知をコード側で skip するため、
次の OpenClaw 専用 secrets/variables は設定しません。

- `CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN` と `CLAWSWEEPER_CRABFLEET_*`
- `CLAWSWEEPER_OPENCLAW_HOOK_URL`、`CLAWSWEEPER_OPENCLAW_HOOK_TOKEN`
- `CLAWSWEEPER_OPENCLAW_AGENT_ID`、`CLAWSWEEPER_DISCORD_TARGET`
- `OPENCLAW_CLOUDFLARE_*`

## 3. Repository variables を設定する

必須の切替値は次のとおりです。

```bash
gh variable set CLAWSWEEPER_APP_CLIENT_ID --repo asura-ai-dev/clawsweeper --body '<github-app-client-id>'
gh variable set CLAWSWEEPER_TARGET_REPO --repo asura-ai-dev/clawsweeper --body 'asura-ai-dev/garuda'
gh variable set CLAWSWEEPER_TARGET_BRANCH --repo asura-ai-dev/clawsweeper --body 'main'
gh variable set CLAWSWEEPER_ALLOWED_OWNER --repo asura-ai-dev/clawsweeper --body 'asura-ai-dev'
gh variable set CLAWSWEEPER_STATE_REPOSITORY --repo asura-ai-dev/clawsweeper --body 'asura-ai-dev/clawsweeper-state'
```

コード上の後方互換 default は次のとおりです。

| Variable                                  | Default                       | Garuda での値                    |
| ----------------------------------------- | ----------------------------- | -------------------------------- |
| `CLAWSWEEPER_APP_CLIENT_ID`               | OpenClaw App の既存 client ID | 新 App の client ID              |
| `CLAWSWEEPER_TARGET_REPO`                 | `openclaw/openclaw`           | `asura-ai-dev/garuda`            |
| `CLAWSWEEPER_TARGET_BRANCH`               | `main`                        | `main`                           |
| `CLAWSWEEPER_ALLOWED_OWNER`               | `openclaw`                    | `asura-ai-dev`                   |
| `CLAWSWEEPER_STATE_REPOSITORY`            | `openclaw/clawsweeper-state`  | `asura-ai-dev/clawsweeper-state` |
| `CLAWSWEEPER_STEERABLE_CODEX`             | `0`                           | `0`                              |
| `CLAWSWEEPER_ENABLE_CLOUDFLARE_DASHBOARD` | OpenClaw owner だけ有効       | `0` または未設定                 |

初回は mutation gate をすべて閉じます。

```bash
gh variable set CLAWSWEEPER_ALLOW_EXECUTE --repo asura-ai-dev/clawsweeper --body '0'
gh variable set CLAWSWEEPER_ALLOW_FIX_PR --repo asura-ai-dev/clawsweeper --body '0'
gh variable set CLAWSWEEPER_ALLOW_MERGE --repo asura-ai-dev/clawsweeper --body '0'
gh variable set CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES --repo asura-ai-dev/clawsweeper --body '0'
gh variable set CLAWSWEEPER_COMMIT_FINDINGS_ENABLED --repo asura-ai-dev/clawsweeper --body 'false'
gh variable set CLAWSWEEPER_STEERABLE_CODEX --repo asura-ai-dev/clawsweeper --body '0'
gh variable set CLAWSWEEPER_ENABLE_CLOUDFLARE_DASHBOARD --repo asura-ai-dev/clawsweeper --body '0'
```

外部 exact-review queue を利用する場合だけ、所有する endpoint を
`CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL` に設定します。OpenClaw の endpoint を Garuda の
private data 用に流用しないでください。

## 4. State repository を用意する

private な専用 repository を推奨します。`setup-state` は durable state の `state` branch を、
履歴保守 workflow は `main` branch を使うため、両方を作成します。

```bash
gh repo create asura-ai-dev/clawsweeper-state --private --add-readme
state_main_sha="$(gh api repos/asura-ai-dev/clawsweeper-state/commits/main --jq .sha)"
gh api --method POST repos/asura-ai-dev/clawsweeper-state/git/refs \
  -f ref='refs/heads/state' \
  -f sha="$state_main_sha"
```

その後、GitHub App をこの state repository に install し、branch protection を使う場合は
App による state publisher の push を許可します。`CLAWSWEEPER_STATE_REPOSITORY` を設定する
までは従来どおり `openclaw/clawsweeper-state` が参照されるため、Garuda の workflow を起動する
前に必ず設定を確認してください。

## 5. Cloudflare dashboard の扱いを決める

Garuda で dashboard を省略する場合は `CLAWSWEEPER_ENABLE_CLOUDFLARE_DASHBOARD` を未設定または
`0` に保ち、`OPENCLAW_CLOUDFLARE_*` secrets を設定しません。非 OpenClaw fork では
`dashboard.yml` の deploy job と state dashboard refresh が既定で skip されます。

独自 dashboard が必要になった場合だけ、worker 名、account、URL、ingest token、queue URL を
Garuda 用に設計し直し、`CLAWSWEEPER_ENABLE_CLOUDFLARE_DASHBOARD=1` を設定します。Webhook
runtime には dispatch 先として `CLAWSWEEPER_REVIEW_REPO=asura-ai-dev/clawsweeper` も設定します。
OpenClaw の account ID、domain、token、Discord hook をそのまま利用しないでください。

## 6. 段階的に lane を有効化する

1. **Review only**: mutation variables をすべて `0` のまま、`sweep.yml` を
   `target_repo=asura-ai-dev/garuda`、`target_branch=main`、`apply_existing=false` で手動実行します。
   state report、GitHub App read token、Codex review、private data の保存先を確認します。
2. **Apply**: review proposal と durable snapshot drift guard が期待どおりであることを確認後、
   最小の item number を指定して apply を試します。保護 label、maintainer author、更新時刻 drift
   が block されることを先に確認します。
3. **Autofix**: `CLAWSWEEPER_ALLOW_EXECUTE=1`、続いて
   `CLAWSWEEPER_ALLOW_FIX_PR=1` を段階的に設定し、1 件だけ plan → execute を検証します。
4. **Automerge**: branch protection、required checks、review policy、head drift/requeue を確認してから
   `CLAWSWEEPER_ALLOW_MERGE` を許可値へ変更します。初回から merge を有効化しません。
5. **Commit review / issue implementation**: 最後に
   `CLAWSWEEPER_COMMIT_FINDINGS_ENABLED` や `CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES` を個別に有効化します。

各段階で GitHub Actions の対象 repository、App installation token の owner、state checkout URL、
生成 comment の対象を確認し、意図せず `openclaw/*` に接続していないことを監査してください。
