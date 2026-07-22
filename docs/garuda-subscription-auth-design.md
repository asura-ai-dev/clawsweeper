# Garuda 向けサブスク認証（ChatGPT OAuth）設計

この文書は `asura-ai-dev/clawsweeper`（`garuda-integration` branch）で Codex 実行を
`OPENAI_API_KEY`（従量課金 API）ではなく ChatGPT サブスクリプションの OAuth セッション
（`CLAWSWEEPER_CODEX_LOGIN_METHOD=chatgpt`）で行えるようにするための詳細設計です。
本文書は設計のみで、コード・workflow の変更はまだ行いません。

対象読者はこの fork の運用者です。文中の行番号は 2026-07 時点の `garuda-integration`
branch のものです。

## 1. メカニズム概要

### 1.1 現状の CI 認証経路

CI での Codex 認証は composite action `.github/actions/setup-codex/action.yml` に
集約されています。`auth-mode` input は現在 `proxy`（既定）と `login` の 2 値です。

- `proxy`: `OPENAI_API_KEY` を localhost の `codex-responses-api-proxy` に渡し、
  `$CODEX_HOME/config.toml` に `model_provider = "clawsweeper-responses-proxy"` を書く。
  Codex CLI 自体は API key を直接持たない。
- `login`: `printenv OPENAI_API_KEY | codex login --with-api-key` で認証する。

`setup-codex` は毎回 run ごとに隔離された `CODEX_HOME`
（`$HOME/.clawsweeper-repair/codex-home/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`）を作り、
`GITHUB_ENV` 経由で後続 step に export します。**この隔離ディレクトリは run ごとに新規作成
されるため、CI 上に `auth.json` は存在しません。**

### 1.2 `forced_login_method="chatgpt"` の流れ

- `src/codex-env.ts` の `codexLoginMethod()` は環境変数
  `CLAWSWEEPER_CODEX_LOGIN_METHOD`（既定 `"api"`）を読み、`"api"` / `"chatgpt"` 以外は
  throw する fail-closed 実装です。`codexLoginConfig()` はこれを
  `forced_login_method="..."` という Codex CLI config 文字列に変換します。
- `src/clawsweeper.ts` の `runCodex()`（10371 行付近）は、`options.forcedLoginMethod`
  指定がなく `preserveCodexAuth` でもない通常経路（CI を含む）で `codexLoginConfig()` を
  `-c forced_login_method=...` として Codex CLI に渡します。`preserveCodexAuth` が真に
  なるのは主に `--local-only` / `--local-range`（`reviewCommand` の `localOnly`、22642 行
  付近）のときだけです。**つまりこの仕組みはローカル限定ではなく、CI でも環境変数を
  設定すれば同じ経路を通ります。**
- `src/codex-app-server-worker.ts` の `parseExecOptions()`（415〜459 行）は
  `-c forced_login_method=...` を解析する薄いラッパーで、`"api"` / `"chatgpt"` の両方を
  受理します。
- `docs/repair/internal-features.md`（620 行付近）と `CHANGELOG.md`（233 行付近）は
  この変数を「local runs 用」と説明していますが、これは「CI runner に有効な OAuth
  セッションが存在しない」という運用上の理由であり、技術的制約ではありません。

### 1.3 chatgpt モードが要求するもの・足りないと何が起きるか

`forced_login_method="chatgpt"` で Codex CLI を実行するには、
`$CODEX_HOME/auth.json`（`CODEX_HOME` 未設定時は `~/.codex/auth.json`）に
`codex login`（ブラウザ OAuth）で得た access/refresh token 一式が必要です。

- `auth.json` が存在しない、または token が失効している場合、Codex CLI は認証エラーで
  失敗します。ClawSweeper 側で API key に自動代替する経路はありません（7 章の方針どおり
  意図的に作りません）。
- `src/codex-env.ts` の `codexEnv()` は `preserveCodexAuth` でない限り
  `OPENAI_API_KEY` / `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` を環境から削除しますが、
  これは環境変数の話であり、**ファイルベースの `auth.json` には影響しません**。
  つまり chatgpt モードは既存の秘密値スクラブ機構と両立します。
- 現在の `proxy` モードは `config.toml` の `model_provider` を localhost proxy に
  向けますが、chatgpt モードでは既定の OpenAI provider を使う必要があるため、
  proxy 用 `config.toml` を書いてはいけません（`model = ...` のみの config を書く既存
  step「Configure internal Codex model」の内容がそのまま使えます）。

したがって CI で必要な追加要素は次の 2 点だけです。

1. secret から `$CODEX_HOME/auth.json` を復元する step（`setup-codex` に追加）
2. Codex を spawn する ClawSweeper プロセスへの
   `CLAWSWEEPER_CODEX_LOGIN_METHOD=chatgpt` の注入

## 2. Secret / variable 設計

### 2.1 新規 secret: `CLAWSWEEPER_CODEX_AUTH_JSON`

- 内容: `codex login` が生成した **`auth.json` ファイル全体**を base64 エンコードした
  もの。
- 全体を保存する理由: `auth.json` のフィールド構成（`tokens.access_token` /
  `tokens.refresh_token` / `tokens.id_token` / `account_id` / `last_refresh` など）は
  Codex CLI の内部仕様であり、version 更新で変わり得ます。token 単体を保存して CI 側で
  ファイルを再構成すると、CLI 内部フォーマットの複製を自前で保守することになり壊れ
  やすいため、ファイル全体をそのまま保存します。
- base64 の位置づけ: **base64 は暗号化ではありません。** JSON の改行・引用符が
  `gh secret set` やシェル経由で壊れるのを防ぐだけの transport encoding です。秘密値の
  保護は GitHub Secrets の「暗号化保存 + write-only（一度登録すると読み出せない）」と
  いう仕組みそのものに依存します。
- masking 上の注意: GitHub Actions は「secret として登録した文字列そのもの」だけを
  ログから mask します。base64 で登録した場合、**decode 後の JSON 本文や個々の token
  文字列は mask されません**。復元 step では decode 結果を絶対に stdout に出さず、
  防御層として decode した各 token 値に `::add-mask::` を適用します（6 章）。

登録コマンド（`SETUP-GARUDA.md` §2 の方式に合わせ、shell history に秘密値を残さない）:

```bash
# 個人の ~/.codex を流用せず、CI 専用の CODEX_HOME でログインする（5.3 参照）
CODEX_HOME=/secure/path/garuda-codex codex login
base64 < /secure/path/garuda-codex/auth.json | gh secret set CLAWSWEEPER_CODEX_AUTH_JSON --repo asura-ai-dev/clawsweeper
```

### 2.2 新規 repository variable: `CLAWSWEEPER_CODEX_LOGIN_METHOD`

コード側の環境変数と同名の repository variable を切替スイッチとして導入します。

```bash
gh variable set CLAWSWEEPER_CODEX_LOGIN_METHOD --repo asura-ai-dev/clawsweeper --body 'chatgpt'
```

- 未設定または `api`: 従来どおり `setup-codex` の `auth-mode: proxy` +
  `forced_login_method="api"`。
- `chatgpt`: `setup-codex` の `auth-mode: chatgpt`（auth.json 復元）+ ClawSweeper 実行
  step への `CLAWSWEEPER_CODEX_LOGIN_METHOD=chatgpt` 注入。

auth モードの切替点を variable 1 つに集約し、「auth.json は復元したのに
`forced_login_method="api"` のまま」というちぐはぐな状態を構成上作れないようにします。
`codexLoginMethod()` は不正値で throw するため、variable の typo は Codex 起動前に
fail-closed で止まります。

### 2.3 既存 secrets との関係

| Secret | chatgpt 運用での扱い |
| ------ | -------------------- |
| `OPENAI_API_KEY` | Codex 実行には不要になる。ただし spam-scanner だけは別（下記）。未設定なら `setup-codex` の proxy/login step は auth-mode 切替で通らないため干渉しない。 |
| `CLAWSWEEPER_MODEL`（`CLAWSWEEPER_INTERNAL_MODEL` として注入） | 引き続き必要。ただし **サブスク認証で利用可能な model 名であることが前提**。proxy/API 前提の model alias がサブスク側に存在しない可能性がある（要確認 A）。 |
| `CLAWSWEEPER_CODEX_AUTH_JSON`（新規） | chatgpt モードの唯一の認証材料。 |
| その他（`CLAWSWEEPER_APP_PRIVATE_KEY` 等） | 変更なし。 |

**spam-scanner の例外**: `src/repair/spam-scanner.ts`（235 行付近）は Codex CLI を
経由せず `OPENAI_API_KEY` で Responses API を直接呼びます。ChatGPT OAuth はこの経路を
カバーできません。`OPENAI_API_KEY` が無い場合は
`[spam-scanner] OPENAI_API_KEY missing; writing deterministic audit only.` の warn を
出して deterministic audit のみに degrade します（fail はしない）。Garuda 運用では
「model 判定付き spam scan を使う場合のみ `OPENAI_API_KEY` を残す」「使わないなら
未設定にして degrade を受け入れる」のどちらかを選びます。既定は後者（API key を CI に
置かない）を推奨します。

### 2.4 `CLAWSWEEPER_CODEX_SERVICE_TIER` の注意（要確認 B）

`service_tier`（既定 `fast`）は従量課金 API 側の概念であり、サブスク認証の Codex が
`-c service_tier="fast"` を受理するかは未確認です。現状コードは空値を許しません:

- review lane: `DEFAULT_SERVICE_TIER = "fast"`（`src/clawsweeper.ts` 1455 行）
- repair lane: `repairCodexServiceTier()` は空文字でも `"fast"` に丸める
  （`src/repair/process-env.ts` 37 行）

サブスク認証で `service_tier` が拒否される場合は、「`CLAWSWEEPER_CODEX_SERVICE_TIER` に
特定値（例: `default`）を設定したら config 注入を skip する」小改修が必要になります
（`runCodex()` は `options.serviceTier` が falsy なら注入しないので、丸め側だけの変更で
済む）。実装前に stage 1（8 章）の手動実行で挙動を確認してから判断します。

## 3. Workflow 変更設計

### 3.1 方針: 新規 action を作らず `setup-codex` を拡張する

`OPENAI_API_KEY` を注入している箇所を grep した結果は次の 10 箇所で、**うち 9 箇所は
`setup-codex` composite action の呼び出しそのもの**でした。したがって新しい composite
action は作らず、`setup-codex` に `auth-mode: chatgpt` を追加するのが最小変更です。

| # | ファイル:行 | step | 変更 |
| - | ----------- | ---- | ---- |
| 1 | `.github/workflows/sweep.yml:775-781` | `setup-codex`（exact review、`login-status: "true"`） | auth-mode 切替 + secret 注入 |
| 2 | `.github/workflows/sweep.yml:2732-2737` | `setup-codex`（`./clawsweeper/...` 経由、`login-status: "true"`） | 同上 |
| 3 | `.github/workflows/sweep.yml:4160-4164` | `setup-codex`（close coverage proof） | 同上 |
| 4 | `.github/workflows/commit-review.yml:425-430` | `setup-codex`（`login-status: "true"`） | 同上 |
| 5 | `.github/workflows/repair-cluster-worker.yml:245-251` | `setup-codex`（session `codex-home` 指定あり） | 同上 |
| 6 | `.github/workflows/repair-cluster-worker.yml:526-533` | `setup-codex`（同上） | 同上 |
| 7 | `.github/workflows/repair-commit-finding-intake.yml:150-156` | `setup-codex` | 同上 |
| 8 | `.github/workflows/assist.yml:208-211` | `setup-codex` | 同上 |
| 9 | `.github/workflows/maintainer-activity-report.yml:107-110` | `setup-codex`（`./clawsweeper/...` 経由） | 同上 |
| 10 | `.github/workflows/spam-scanner.yml:115-119` | `Scan spam comments`（直接 Responses API） | **変更しない**（2.3 の例外） |

### 3.2 `setup-codex` への追加内容

`auth-mode` の許容値に `chatgpt` を追加し、次の step を挿入します。

- 新 step「Authenticate Codex with ChatGPT OAuth」（`if: auth-mode == 'chatgpt'`）:
  1. env で受けた `CLAWSWEEPER_CODEX_AUTH_JSON` が非空であることを検査
     （`test -n` のみ。値は出力しない）
  2. base64 decode して `$CODEX_HOME/auth.json` に書き、`chmod 600`
  3. decode した JSON から `access_token` / `refresh_token` / `id_token` を抽出して
     `::add-mask::` を発行（値自体は echo しない。抽出は `node -e` で行い、mask 行の
     出力のみ）
  4. `codex login status` を実行して認証状態を検証する。chatgpt モードでは
     `login-status` input の値に関わらず必ず実行する（fail-closed の早期検知点。5 章）
- 既存の「Configure internal Codex model」step（`model = ...` のみの `config.toml` を
  書く）は chatgpt モードでもそのまま利用します。proxy 用 `config.toml` 上書き step は
  `auth-mode == 'proxy'` 条件で既に skip されます。
- 「Reject unknown Codex auth mode」の条件に `chatgpt` を追加します。

### 3.3 各 workflow 側の変更

9 箇所の `setup-codex` 呼び出しを次の形に変更します。

```yaml
- uses: ./.github/actions/setup-codex   # または ./clawsweeper/.github/actions/setup-codex
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    CLAWSWEEPER_CODEX_AUTH_JSON: ${{ secrets.CLAWSWEEPER_CODEX_AUTH_JSON }}
    CLAWSWEEPER_INTERNAL_MODEL: ${{ secrets.CLAWSWEEPER_MODEL }}
  with:
    auth-mode: ${{ vars.CLAWSWEEPER_CODEX_LOGIN_METHOD == 'chatgpt' && 'chatgpt' || 'proxy' }}
```

さらに、`codexLoginConfig()` は **ClawSweeper の node プロセスの環境変数**を読むため、
`setup-codex` だけでなく Codex を spawn する実行 step にも
`CLAWSWEEPER_CODEX_LOGIN_METHOD` が届いている必要があります。step ごとの env 追加は
漏れやすいので、対象 workflow（#1〜#9 を含む 6 ファイル）の **top-level `env:`** に
次を追加する方式を提案します。

```yaml
env:
  CLAWSWEEPER_CODEX_LOGIN_METHOD: ${{ vars.CLAWSWEEPER_CODEX_LOGIN_METHOD || 'api' }}
```

注意: `codexEnv()` / `codexSubprocessEnv()` のスクラブ対象に
`CLAWSWEEPER_CODEX_LOGIN_METHOD` は含まれていない（値自体は秘密ではない）ため、
top-level env で問題ありません。

### 3.4 upstream との差分維持

この変更は fork 固有ではなく「variable が未設定なら従来どおり proxy」という後方互換な
形にし、upstream 追従時の conflict を最小化します。`auth-mode` の既定値・既存 step は
変更しません。

## 4. 後始末設計

- **runner の前提**: GitHub-hosted runner は job 終了で VM ごと破棄されるため、
  `auth.json` が後続 job に持ち越されることはありません。self-hosted runner に移行する
  場合はこの前提が崩れるため、その時点で cleanup を必須要件に格上げします。
- **明示的削除**: composite action は post step を持てないため、`setup-codex` 内では
  job 終了時の削除を保証できません。防御層として、`setup-codex` を呼ぶ各 job の末尾に
  `if: always()` の cleanup step（`rm -f "$CODEX_HOME/auth.json"`）を追加します。
  追加箇所は 3.1 の #1〜#9 と同じ 9 job です。
- **cache 経路の確認結果**（現状漏洩しないことを確認済み。実装時のレビュー観点として
  維持する）:
  - `setup-codex` の `actions/cache` path は `~/.npm` / corepack /
    `~/.clawsweeper-repair/codex`（npm prefix）のみで、`CODEX_HOME` を含まない。
  - `repair-cluster-worker.yml` の「Restore Codex session」cache path は
    `$codex_home/sessions` と `clawsweeper-thread-state.json` のみで、`auth.json` を
    含まない。**cache path に `codex_home` 直下を追加しないこと。**
- **debug artifact 経路**: `src/repair/collect-codex-debug.ts` の
  `isAllowedCodexDebugFile()`（138 行）が `auth.json` / `config.toml` / `config.json`
  を明示的に除外済み。収集対象も `sessions` / `log` / repair-runs に限定されている。

## 5. Refresh token 運用設計

### 5.1 フォールバック方針: 自動フォールバックはしない（fail-closed）

token 失効時に `OPENAI_API_KEY` へ自動で切り替える両対応は**採用しません**。根拠:

1. `codexLoginMethod()` 自体が不正値で throw する fail-closed 思想で作られており、
   本設計もそれに合わせる。認証経路は常に 1 本で、失敗は失敗として表面化させる。
2. 自動フォールバックは token 失効を隠蔽し、気づかないうちに従量課金へ切り替わる。
   コスト事故と「どちらの credential で動いたか分からない」監査困難の両方を招く。
3. 二重の認証経路は漏洩時の影響分析・失効作業を倍にする。chatgpt 運用を選ぶなら
   `OPENAI_API_KEY` は CI から外す（spam-scanner を使う場合のみ例外、2.3）。

API へ戻す操作は `CLAWSWEEPER_CODEX_LOGIN_METHOD` variable の書き換えという人間の
明示操作のみとします。variable 1 つで即座に戻せることが、自動フォールバックを持たない
ことの安全弁です。

### 5.2 失効の検知

- 一次検知: `setup-codex` chatgpt モードの必須 `codex login status`（3.2）。失効時は
  Codex review 本体に入る前に workflow が失敗し、GitHub の workflow 失敗通知で気づく。
- スケジュール実行の lane（sweep 等）が突然全滅した場合も同 step の失敗として現れる。
  専用の監視 workflow は追加しない（過剰な新規機構を避ける。運用してみて必要なら検討）。

### 5.3 再ログイン〜secret 更新の手順

- **誰が**: repository admin（secret 書き込み権限保持者）。
- **頻度**: OAuth token の寿命と refresh token rotation の仕様が公開情報で確定できない
  ため、定期周期は現時点で定めない（**要確認 C**）。当面のルールは
  (1) 失効検知したら即時再登録、(2) Codex CLI の version bump 時に再登録、の 2 点。
- **手順**: 2.1 のコマンドを再実行する。個人の `~/.codex` を流用せず CI 専用の
  `CODEX_HOME` でログインするのは、CI 側の refresh により session 状態が変わる可能性と、
  失効時の切り分け（個人利用か CI か）のため。
- **要確認 C の内容**: (a) refresh token が使用時に rotation されるか。rotation される
  場合、ephemeral runner では更新後 token が毎回捨てられるため、並列 job の同時 refresh
  や古い refresh token の再利用で session が無効化される恐れがある。(b) access token の
  寿命と、`codex login status` が期限切れ時に自動 refresh を行うか。stage 1（8 章）で
  実測し、この文書を更新する。
- **アカウント競合**: ChatGPT サブスクのレート制限（5 時間・週間ウィンドウ）は
  アカウント単位で CI と対話利用が共有する。CI が枠を消費して人間の利用が制限される
  逆流も起きるため、専用アカウント（例: Team の bot 用 seat）の利用を検討する
  （規約上の可否は 7 章の確認事項）。

## 6. セキュリティ考察

### 6.1 漏洩経路チェックリスト（実装・レビュー時に確認する）

- [ ] 復元 step で decode 結果を `cat` / `echo` していない。`set -x` を使っていない。
- [ ] 復元 step で `access_token` / `refresh_token` / `id_token` に `::add-mask::` を
      適用している（base64 登録では平文 token が自動 mask されないため。2.1）。
- [ ] `codex login status` の出力に token 本文が含まれないことを実機ログで確認した
      （**要確認 D**。含まれる場合は出力を捨てて終了コードだけ使う）。
- [ ] `actions/upload-artifact` の path に `CODEX_HOME` 配下を含めていない。
- [ ] `actions/cache` の path に `auth.json` を含めていない（4 章の 2 経路を維持）。
- [ ] `collect-codex-debug.ts` の除外リストが `auth.json` を含んだままである。
- [ ] `redactSecrets()`（`src/repair/collect-codex-debug.ts` 104 行、
      `src/clawsweeper.ts` 10224 行付近）は `sk-*` / GitHub token / 特定 env 名しか
      redact せず、**OAuth JWT（`eyJ` で始まる文字列）は対象外**。Codex の
      stdout/stderr ログは artifact 化されるため、認証エラー時に token 断片が
      混入しないか stage 1 で確認し、必要なら JWT パターンの redact 追加を実装候補に
      する（**要確認 E**）。
- [ ] fork からの pull request で secret が渡る trigger（`pull_request_target` 等）を
      対象 workflow が使っていないことを確認した。

### 6.2 GitHub Actions masking の限界

- mask されるのは「secret として登録した文字列との完全一致」だけ。base64 登録なら
  decode 後の平文は別文字列なので mask されない。
- 複数行 secret の mask は行単位で不完全になることがある。`add-mask` も同様に
  1 行 1 値で登録する。
- mask はログ表示層の対策にすぎない。artifact・cache・外部送信には効かないため、
  6.1 の経路遮断が本体である。

### 6.3 API key との漏洩時リスク比較

| 観点 | `OPENAI_API_KEY` | ChatGPT OAuth（`auth.json`） |
| ---- | ---------------- | ---------------------------- |
| 漏洩時に攻撃者が得るもの | 課金 API の利用権 | ChatGPT アカウントとしての session（refresh token により長期継続し得る） |
| 失効操作 | dashboard で当該 key を revoke（即時・局所） | 全 device logout / パスワード変更等、アカウント全体に波及しがち |
| 被害の上限 | usage limit / budget 設定で金額上限を切れる | サブスク枠のためコスト上限はあるが、アカウント内の会話・設定等へのアクセス面が広い |
| 悪用可能期間 | revoke まで | refresh 継続により revoke まで長期化しやすい（既有の共有認識どおり） |

結論: サブスク認証はコスト面で有利だが、**credential としての爆発半径は API key より
大きい**。だからこそ 4 章の後始末・6.1 の経路遮断・5.1 の単一経路 fail-closed を
セットで採用する。

## 7. 利用規約・ポリシーリスク（導入前に確認すべき論点）

個人/Team サブスクの OAuth セッションを無人の自動化ワークロードに使うことの可否は、
本設計では**判断しない**。導入（特に stage 2 以降の mutation lane と automerge）の前に
次を確認すること。

- OpenAI の Terms of Use / サービス固有条項 / Codex のドキュメントが、CI 上の無人
  ワークロード（review / apply / repair / automerge）でのサブスク認証利用をどう扱って
  いるか。
- credential を CI secret として配置し複数の並列 runner から利用することが、
  アカウント共有・自動化に関する条項に抵触しないか。
- 人間の確認を挟まない mutation（特に automerge）にサブスク枠を使うことの扱い。
- CI（datacenter IP、並列アクセス）からの利用が abuse detection やレート制限回避と
  みなされるリスク。
- Team プランの場合、workspace 管理者のポリシー・許可。
- 不明点が残る場合は OpenAI サポートへの照会を検討する。

確認結果と判断はこの文書に追記して記録を残すこと。

## 8. 段階的ロールアウト計画

`SETUP-GARUDA.md` §6 の段階導入（Review only → Apply → Autofix → Automerge →
Commit review / issue implementation）に chatgpt 認証を重ねる。

0. **事前**: 7 章の論点を確認。`CLAWSWEEPER_CODEX_AUTH_JSON` と
   `CLAWSWEEPER_CODEX_LOGIN_METHOD` を登録し、`setup-codex` と workflow の変更を merge。
   要確認 A（model 名）・B（`service_tier`）をこの段階で潰す。
1. **Review only（chatgpt）**: mutation variables 全閉のまま `sweep.yml` を手動実行。
   `codex login status` の成功、review decision の生成、9 章の検証項目を確認する。
   この段階で失効シミュレーションと再登録手順（5.3）を 1 回実施しておく。
2. **Apply**: `SETUP-GARUDA.md` §6-2 と同じ。認証面の追加確認は不要（経路は同一）。
3. **Autofix**: §6-3 と同じ。repair worker lane（`repair-cluster-worker.yml` 等）で
   chatgpt 経路が通ること、`service_tier` 問題（要確認 B）が repair 側でも解決済みで
   あることを確認。
4. **Automerge**: §6-4 と同じ。**7 章の確認が完了していることを開放の前提条件に加える。**
5. **Commit review / issue implementation**: §6-5 と同じ。

各段階で従来どおり `openclaw/*` へ接続していないことの監査に加え、「どの credential で
Codex が動いたか」（workflow の `auth-mode` 解決結果）をログで確認する。

## 9. 検証計画

### 9.1 auth.json 復元の確認

- `setup-codex`（auth-mode=chatgpt）実行後の `codex login status` が成功すること。
- 実行ログの `-c forced_login_method="chatgpt"` 相当の経路確認: review runtime ログ
  （`review_service_tier` 等が出る箇所）または Codex stderr artifact で認証方式を確認
  する。具体的なログ文言は stage 1 の実測でこの文書に追記する。
- 回帰確認: `CLAWSWEEPER_CODEX_LOGIN_METHOD` variable を未設定に戻した状態で従来の
  proxy 経路の sweep が成功すること（後方互換の検証）。
- 単体テストは既存資産で足りる想定: `codexLoginMethod` / `codexLoginConfig` は
  `test/clawsweeper.test.ts`（2787 行付近）と `test/codex-review-runner.test.ts` で
  `chatgpt` 値・不正値の双方が検証済み。`setup-codex` の追加 step はシェルのみのため、
  workflow 上の実機確認を正とする。

### 9.2 token 失効のシミュレーション

1. **不正 base64**: secret に base64 として壊れた値を入れ、復元 step が decode 段階で
   失敗し review 本体へ進まないことを確認する。
2. **形式は正しいが無効な token**: 正規の `auth.json` の `refresh_token` を 1 文字
   変更した版を登録し、`codex login status`（または初回 Codex 実行）で失敗して
   fail-closed になることを確認する。
3. **注意**: 実 token の revoke（全 device logout 等）を使うテストは本物の session を
   破壊し、個人アカウント運用では巻き添えが大きい。無効 token 注入（上記 2）で代替し、
   revoke テストは専用アカウントを用意できた場合のみ行う。
4. 各シミュレーション後、正規 secret を再登録して stage 1 の正常系が復旧することを
   確認する（これが 5.3 の再登録手順の訓練を兼ねる）。

### 9.3 後始末の確認

- cleanup step 実行後に `$CODEX_HOME/auth.json` が存在しないこと（`test !-f` を
  cleanup step 自体に含める）。
- run 後の cache エントリと artifact 一覧に `auth.json` 由来の内容が含まれないことを
  初回のみ手動確認する。

## 付録: 要確認事項一覧

| ID | 内容 | 確認タイミング |
| -- | ---- | -------------- |
| A | `CLAWSWEEPER_MODEL` の model 名がサブスク認証で利用可能か | stage 0 |
| B | サブスク認証で `-c service_tier="fast"` が受理されるか。拒否なら空値を許す小改修 | stage 0 |
| C | refresh token の rotation 有無・access token 寿命・並列 refresh の競合挙動 | stage 1 |
| D | `codex login status` 出力に token 本文が含まれないか | stage 1 |
| E | Codex stdout/stderr artifact への JWT 断片混入の有無と `redactSecrets()` 拡張要否 | stage 1 |
| - | 7 章の利用規約・ポリシー論点 | stage 2 以降の開放前（automerge は必須） |
