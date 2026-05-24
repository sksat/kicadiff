# kicadiff

KiCad プロジェクト用の visual diff ツール。`.kicad_pcb` /
`.kicad_sch` / `.kicad_sym` / `.kicad_mod` のあるバージョン間の変更を
ブラウザで視覚的に確認したり、PR に貼れる markdown レポートとして
出力したりできる。

[English README](./README.md)

![kicadiff demo](assets/kicadiff-demo.gif)

## 提供する機能

- **HTML ビューア** — Side-by-Side / Overlay / Swipe の3表示モード、
  PCB のレイヤー切替、階層回路図のページナビ、ホイールズーム + 右
  クリックドラッグでパン、視覚的に変更があったタブ・ページに琥珀色の
  マーカー。
- **Markdown レポート** (`--md`) — side-by-side の画像テーブルと、
  Reference designator 単位の構造差分 (追加 / 削除 / 変更)。PR の
  description や commit message に貼るのに適している。
- **テキスト構造差分** (`--text-only`) — 画像レンダリングなし、stdout
  に出力するので高速。

## 必要なもの

- [`kicad-cli`](https://www.kicad.org/) 9.x 以降 (レンダリングエンジン)
- [Bun](https://bun.sh) — shebang から TypeScript の CLI を直接実行する。
  standalone binary をコンパイルするのも Bun なので、Node を別途用意
  する必要はない。standalone binary 派は不要。

レンダリングパイプライン (SVG → PNG、3 色のピクセル差分ハイライト)
はかつて `rsvg-convert` / ImageMagick を必要としたが、今は in-process
(`@resvg/resvg-js` でラスタ化、`pngjs` 上の小さな分類器で diff overlay)
に置き換え済み。

## インストール

環境に合わせて 3 通り:

```sh
# 1. Bun の package runner で 1 ショット実行 (インストール不要)
bunx kicadiff [args...]

# 2. グローバルインストール (`kicadiff` が PATH に入る)
pnpm add -g kicadiff
# `bun add -g kicadiff` / `npm install -g kicadiff` でも可

# 3. standalone binary。1 ファイル、Bun runtime 不要。
#    ~/.local/bin に `kicadiff` を配置 (KICADIFF_INSTALL_DIR で上書き可)。
curl -fsSL https://raw.githubusercontent.com/sksat/kicadiff/main/install.sh | sh
```

`kicad-cli` (と `rsvg-convert` / `magick`) は同梱しないので、KiCad 9+ を
先に入れた上で kicadiff の好きな配布形態を選んでください。

## 使い方

`git diff` と同じ位置引数の形を踏襲しつつ、ファイル型を限定したい
ときのために subcommand がある。

```sh
# プロジェクト全体の diff (cwd 内、PCB と schematic 両方、デフォルトは
# index vs working tree — `git diff` と同じ)
kicadiff

# プロジェクトディレクトリ / .kicad_pro / 単一の KiCad ファイルを渡す
kicadiff path/to/project/
kicadiff project.kicad_pro
kicadiff project.kicad_pcb

# staged な変更のみ (= `git diff --cached` / `git diff --staged`)
kicadiff --cached project/
kicadiff --staged project/             # alias

# 任意の ref を比較
kicadiff HEAD path/to/project/         # working tree vs HEAD (staged + unstaged 全部)
kicadiff main path/to/project/         # working tree vs main
kicadiff v1.0 v2.0 board.kicad_pcb     # v1.0 vs v2.0
kicadiff main..feat foo.kicad_pcb      # range syntax
kicadiff main -- foo.kicad_pcb         # 明示的な `--` separator
kicadiff :0 project/                   # 明示的に index 指定 (alias: index / staged)

# Subcommand でファイル型を限定 (sibling の自動検出を無効化)
kicadiff pcb foo.kicad_pcb
kicadiff sch foo.kicad_sch       # alias: schematic
kicadiff sym lib.kicad_sym       # alias: symbol
kicadiff fp foo.kicad_mod        # alias: footprint
kicadiff fp lib.pretty           # .pretty/ ディレクトリ全体

# 出力形式
kicadiff project/                       # デフォルト: HTML ビューア + 画像
kicadiff project/ --md                  # markdown レポート + 画像、HTML なし
kicadiff project/ --md --output report.md
kicadiff project/ --md --output -       # markdown を stdout に、ログは stderr に
kicadiff project/ --text                # 構造テキスト差分も出力
kicadiff project/ --text-only           # テキストのみ、レンダリングなし (高速)
kicadiff project/ --images-only         # PNG だけ、HTML / markdown なし

# カスタム markdown テンプレート (Mustache サブセット: {{var}},
# {{#section}}…{{/section}}, {{^inverted}}…{{/inverted}})。プロジェクト
# テンプレートからは from_label / to_label / file_count / has_changes /
# files / file_sections が見える。file テンプレートからは path / type /
# before_image / after_image / has_both / after_only / before_only /
# added_count / removed_count / changed_count / unchanged_count /
# nets_added / nets_removed / nets_changed (pcb のみ) /
# has_structural_diff (実際の component または net 変更あり) /
# has_visual_diff (PNG が異なる) / has_changes (上記いずれか) /
# structural_diff (整形済本文) が見える。どちらも省略可で
# デフォルトテンプレートは内蔵。
kicadiff project/ --md --md-template my-report.md.tpl
kicadiff project/ --md --md-file-template my-file.md.tpl

# HTML を VSCode (Live Preview) やブラウザで自動オープン
kicadiff project/ --open vscode
kicadiff project/ --open firefox
kicadiff project/ --open=/usr/bin/open  # 任意のコマンド

# Watch mode: 入力 KiCad ファイルが変わるたびに再レンダリング。
# Hot reload は viewer 側に委譲する — VSCode Live Preview / live-server
# 等であれば kicadiff が画像を上書きした瞬間に自動でページが更新される。
# 素の file:// で開いている場合は kicadiff が小さな画像ポーリング script
# を HTML に inject するので、F5 無しで描画だけが差し替わる。
kicadiff project/ --watch
kicadiff project/ --watch --open vscode

# その他
kicadiff project/ -v                    # PNG パスまで出すサマリ
kicadiff project/ -q                    # サマリ抑止
kicadiff project/ --no-cache            # キャッシュをバイパス
kicadiff project/ --exit-code           # 変更があれば exit 1 (`git diff --exit-code` 互換)

# Claude Code PostToolUse hook 統合。stdin から hook の JSON を読んで、
# 編集対象が .kicad_pcb / .kicad_sch のときだけレンダリングする。
# デフォルトは `--open vscode` (`--open <target>` で上書き可)。
kicadiff hook
```

## 出力先

デフォルトでは git ルート直下の `.claude/preview/` に出す (見つけやすい
位置)。`--output-dir <dir>` で画像ディレクトリを上書き、`--output <path>`
で HTML / markdown の出力パスを変える (中の画像パスは出力ファイルの
ディレクトリに対する相対パスに自動で書き換えられるので、ファイルを
コピーしても壊れない)。

HTML ビューアはマニフェストと画像参照を全部 inline にした 1 ファイル
なので、メールに添付したり、static asset として hosting したり、
ローカルなら VSCode の Live Preview 拡張で開いたりできる。

## レンダリングキャッシュ

各 side のレンダリング結果を content-addressed で
`$XDG_CACHE_HOME/kicadiff` (または `~/.cache/kicadiff`) に
キャッシュする。同じ内容に対する再実行はコールドの ~5 秒に対して
~1 秒で返る。`--no-cache` で無効化、`KICADIFF_CACHE_DIR` で位置を
上書きできる。

## GitHub Actions

KiCad ファイルが変わる PR で visual diff を自動生成する composite
action を提供しています。KiCad のインストールから kicadiff 実行、
そしてオプトインで artifact upload / job summary (画像インライン
埋め込み) / sticky な PR comment / PR description のセクション更新
までこなします。

```yaml
# .github/workflows/kicad-diff.yml
name: KiCad visual diff
on:
  pull_request:
    paths: ["**/*.kicad_pcb", "**/*.kicad_sch"]
permissions:
  contents: read
  pull-requests: write   # pr-comment / pr-description を使う場合のみ
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - uses: sksat/kicadiff@v0.1.0
        with:
          path: hardware/main-board   # 既定は cwd
          upload-artifact: 'true'
          pr-comment:      'true'
          pr-description:  'true'
```

job summary には combined の before/after PNG を base64 data URI で
インライン埋め込みするので外部ホスティング不要。1 MiB を超えそうな
ときは超過分の画像だけドロップして `::warning::` を出し、artifact
へのリンクで補完。PR comment / description はテキスト中心 (画像は
artifact 経由) にしてあります。

`install-kicadiff: bunx` (既定) で公開済の最新を on-demand に取得、
`install-kicadiff: <semver>` でバージョンを固定。既に PATH に
kicadiff がある (例: 自前 image) 場合は `install-kicadiff: skip`。

## さらに詳しく

- `DESIGN.md` — アーキテクチャ、レンダリングパイプライン、キャッシュ
  キーの構成、マニフェスト schema、ビューア表示モードのセマンティクス
- `examples/blink/` — テスト fixture 兼サンプルプロジェクト (最小構成)。
  `.kicad_pcb` / `.kicad_sch` を編集するたびに kicadiff を走らせて
  プレビューを更新する Claude Code の PostToolUse hook
  (`.claude/settings.json` から `kicadiff hook` を呼ぶだけ) を同梱している
- `examples/mcu-board/` — もう少し実用度のある小型ボード例。
  8 ピン MCU を中心に「周りに普通付くやつ」(5 V → 3.3 V の
  AMS1117 LDO、decoupling caps、pull-up 付き reset スイッチ、
  status LED、6 ピン programming/breakout ヘッダ) が並んでいる。
  階層回路図 (root が電源 + MCU、`peripherals.kicad_sch` 側が
  reset / LED / header) なので、ビューアのページ tab を切り替える
  挙動も確認できる。
