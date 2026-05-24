# kicadiff Design Doc

## ゴール

KiCad プロジェクトの「ある状態」と「別の状態」(コミット間 / コミット
vs 作業ツリーなど) の差分を、人間が視覚的に確認できる形で出力する。
`git diff` のテキスト出力では PCB / 回路図の変更がほぼ読めないので、
それを補完する。

副次的な目標として:

- PR description / commit message にそのまま貼れる markdown レポート
- 構造的な (component 単位の) 差分を機械可読な形 (テキスト) でも出す
- Claude Code の PostToolUse hook から呼べるように、CLI として安定
  したインターフェイスを提供する。`kicadiff hook` サブコマンドが
  stdin の hook JSON を直接受け取り、編集対象が KiCad ファイルなら
  レンダリングを実行する (これがあるので利用側は wrapper script を
  書く必要がない)。

## ランタイム依存

エンドユーザーが `kicad-cli` だけ持っていれば動く状態を維持する。
ファイルを実際に解釈・描画するのは kicad-cli の責務であり、これは
外部に出せない (KiCad 本体の機能依存)。

| 依存             | 状態                                              |
|------------------|---------------------------------------------------|
| kicad-cli        | 維持                                              |
| Bun              | `bun build --compile` でバイナリに内包            |
| ~~`rsvg-convert`~~ | `@resvg/resvg-js` (Rust 製、Node binding) で置換  |
| ~~`magick compare`~~ | 自前の tri-color 分類器 (`pngjs` 上) で置換     |

`bun build --compile` で作る standalone binary は kicad-cli さえ手元に
あれば動く 1 ファイル配布。`bunx` / `pnpm add -g` 系も Bun 1 つ
+ kicad-cli で完結する (ランタイムから外部コマンドを呼ばない)。

## アーキテクチャ概観

```
                   ┌─ kicad-cli pcb export svg ─┐
入力ファイル ───┤   ├── @resvg/resvg-js ──→ PNG ─┐
(.kicad_pcb 等)    │   │                            ├──→ Manifest (JSON)
   ↓               │                                │       │
git ref に対応する │           render cache         │       │
content を取り出し │ (~/.cache/kicadiff/<hash>/)    │       ↓
                                                       viewer.html
                                                       (HTML inline)
                                                            │
                                                            ↓
                                                       Markdown report
                                                       Text report
```

SVG 生成は外部ツール (kicad-cli) に丸投げ、SVG → PNG ラスタ化と
ピクセル差分は in-process JS (`@resvg/resvg-js` / 自前の tri-color 分類器)。
kicadiff は orchestration とキャッシュと出力フォーマットの統合を担当する。

## 出力フォーマット

| flag             | HTML | 画像 | Markdown | Text |
|------------------|------|------|----------|------|
| (なし)           | ✓    | ✓    |          |      |
| `--md`           |      | ✓    | ✓        |      |
| `--text`         | ✓    | ✓    |          | ✓    |
| `--text-only`    |      |      |          | ✓    |
| `--images-only`  |      | ✓    |          |      |

### Markdown レポート

`--md` 時は HTML を作らず markdown ファイル (`<safe>_diff.md`) を
書く。中身は file ごとに「heading + side-by-side 画像テーブル + 構造
差分」。画像パスは markdown ファイルの dir に対する相対なので、
ファイルを移動 / コピーしても link が壊れない。

`--output -` または `--output stdout` で stdout に出力。このとき
ステータスログは stderr に流す (リダイレクトでファイルが汚れない
ため)。

#### テンプレート

レポートは 2 層のテンプレートで組み立てる:

1. **file テンプレート** — 各ファイル毎に 1 度レンダリングされ、
   以下を context に持つ:
   - `path` / `type` / `from_ref` / `to_ref` / `from_label` / `to_label`
   - 画像: `before_image` / `after_image` / `has_before` / `has_after` /
     `has_both` / `after_only` / `before_only`
   - 構造差分の数: `added_count` / `removed_count` / `changed_count` /
     `unchanged_count`
   - Net 差分の数 (pcb のみ、それ以外は 0): `nets_added` / `nets_removed` /
     `nets_changed` (pad rewire 数; 追加/削除された footprint の pad は
     suppress 済みで、レンダラの Nets サブセクションに出る数と一致)
   - 真偽: `has_structural_diff` (実際に追加/削除/変更があった場合のみ
     true。component の差分だけでなく net レベルの変更 (net 追加/削除/
     pad rewire) も true にする — pad を GND から VCC へ繋ぎ替える編集
     は component field が動いていなくても電気的には実変更だから。
     PCB/SCH の `+0 -0 ~0 =N` summary 行は `structural_diff` 文字列
     には含まれるが、これだけでは false) / `has_visual_diff` (描画した
     before/after の PNG が byte 単位で異なる) / `has_changes` (上記の
     いずれか / 片側だけ存在も含む)
   - 本文: `structural_diff` (整形済の構造差分本文。pcb/sch 以外は空)
2. **project テンプレート** — 全 file セクションを `\n\n` で連結
   した結果が `{{file_sections}}` として渡される。これに加えて
   `from_ref` / `to_ref` / `from_label` / `to_label` /
   `file_count` / `has_changes` (どれか 1 ファイルでも `has_changes` /
   `files` (配列、Mustache の `{{#files}}…{{/files}}` で iterate 可能;
   要素は file テンプレートと同じ context) も見える。

実装は `src/template.ts` の Mustache サブセット (依存なし、~120 行):
`{{var}}` / `{{#section}}…{{/section}}` (truthy block; array は
iterate) / `{{^section}}…{{/section}}` (inverted block) /
`{{!comment}}` / dot-path lookup / context stack walk-up。標準的な
Mustache の standalone-tag 空白 trim はやらないので、テンプレート内
の改行配置はテンプレート作者の責任 (default テンプレートは
inline-section スタイルでこれを回避している)。

CLI 側からは `--md-template <path>` (project) と
`--md-file-template <path>` (file) で個別に上書きできる。どちらも
省略可で、その場合は `src/index.ts` 内の組み込みデフォルト
(従来の出力と完全互換) が使われる。

### 構造的なテキスト / Markdown 差分

`textdiff.ts` が S-expression を最小限パースし、`(footprint ...)` /
`(symbol ...)` ブロックを抽出して reference designator を identity
として diff する。出力例:

```
foo.kicad_pcb (pcb): +0 -0 ~3 =42
  ~ R1  value: 330 → 470
  ~ C5  value: 100nF → 220nF
  ~ U1  pos: 100.00,50.00 → 105.00,50.00
  Nets: +1 -0 ~1
    + /LED_OUT
    ~ R1.2: GND → /LED_OUT
```

`+` 追加、`-` 削除、`~` 変更、`=` 変更なし。markdown 版はこれを
`### Added` / `### Removed` / `### Changed` のリストとして整形する。

`.kicad_pcb` のみ、トップレベル `(net N "name")` 表と各 pad の
`(net ...)` membership を読み、`Nets` サブセクション (markdown 版は
`### Nets`) として「追加 / 削除されたネット」と「pad の接続先が
変わったケース (`R1.2: GND → /LED_OUT`)」を出力する。Net の identity は
**名前** で持つ — id は保存ごとに振り直されるため安定しない。

(net ...) atom の形は KiCad のバージョンで 2 種ある:

- レガシー (KiCad <= 9): `(net <id> "<name>")` — 名前は index 2、
  さらにトップレベルに `(net N "name")` 表を持つ。
- KiCad 10: `(net "<name>")` — 名前は index 1、トップレベルの
  net 表は消えた。

両方サポートする。トップレベル表が無い場合は、pad の `(net ...)`
membership から名前集合を逆算する (`examples/mcu-board` がこの経路)。

`""` (unconnected) は **名前集合からのみ** 除外する (unrouted pad の
churn で diff が埋まるのを防ぐ)。一方で pad 単位の変更行では
named ↔ unconnected の遷移も「実電気的変更」として残す — GND から
pad を外したり NC pad に +3V3 を繋いだのは PR で見たい情報なので、
`R7.1: (unconnected) → +3V3` のように表示する。

footprint 自体が added / removed のときは、その footprint の
pad 変更行は `Nets` サブセクションから抑制する (footprint レベルの
行で代替済)。トップ行の `+A -R ~C =U` summary は component 専用の
ままにしてあるので、既存の summary を grep / parse している hook 等
は互換のまま動く。

回路図側 (`.kicad_sch`) の net 差分は実装していない。回路図では
電気的接続が wire / label / hierarchical pin / bus membership に
分散するため、純粋なテキスト diff には収まらないトレースが必要。
TODO として残す。

### DRC / ERC 違反差分 (`kicadiff check`)

`--text-only` と並ぶ 3 番目の fast-path mode。レンダリングを完全に
スキップし、`kicad-cli pcb drc` / `kicad-cli sch erc` を before/after
両側で実行して **違反の差分** を出す:

```
foo.kicad_pcb (drc): +2 -1 =5
  + clearance              Pad 1 of R1 / Pad 1 of R2
  + courtyards_overlap     footprint R5 / R6
  - lengths_match          (resolved)
bar.kicad_sch (erc): +0 -0 =3
```

実装は `src/check.ts`。違反の「同一性」は
`signatureOf(v) = sha256(type ‖ sorted item descriptions)` で判定する:

- `type` は KiCad の enum key (`clearance`, `unconnected_items` …) なので
  description の文言ゆれに強い。
- item description は具体的に関与しているパッド / トラックを示すので、
  別の clearance 違反と取り違えない。
- 意図的に除外しているもの: `uuid` (再生成されうる)、`pos` (0.01mm の
  ナッジで新規違反扱いになるのを防ぐ)、`severity` (config 変更で
  warning → error 昇格しただけのケースで `+1 -1` にしない)。

git ref からの実行も対応。`render.ts` の temp lifecycle パターンを
踏襲しつつ、`check` は per-side のキャッシュ整合性を気にしないので、
ファイルとその sibling `.kicad_pro` / `.kicad_prl` を専用の tmpdir
(`mktemp -d`) に展開する方式を採る。DRC は project file 内の design
rule (clearance, track width, …) に依存するので siblings の抽出は
必須。working tree の汚染を避けるための finally unlink ダンスは
tmpdir 一括削除に集約できる。

終了コードは「**新規違反があれば 1**」。pre-existing な違反が残って
いるだけでは fail しない — PR gate の意図は「この変更が違反を持ち
込んだか」であって「全違反ゼロか」ではないため。CI で全違反ゼロを
要求したい場合は `kicad-cli pcb drc --exit-code-violations` を直接
使えばよい。なお `kicad-cli` 不在、git エラー、JSON parse 失敗などの
**運用エラー** も例外として伝播し非ゼロ終了する。現状は新規違反と
運用エラーを区別せず一律「非ゼロ」だが、将来的には新規違反=1 / 運用
エラー=2 のように分けて CI が「変更が壊した」と「gate が壊れた」を
区別できるようにする余地がある。

## CLI 引数の解析

`git diff` 互換のために単純な flag-only パーサーは使わず、自前で
positional argument を分類する:

- 識別: subcommand (`pcb` 等) → scope を限定
- 識別: `--from` / `--to` / `--output` / `--cached` / `--staged` などの flag
- 残りの positional から `isLikelyInput()` で input を逆引き
  (拡張子 / `/` の有無で判定)
- 残りの positional は ref と見做し、`<r1>..<r2>` 記法を expand
- index の別名 (`:0` / `index` / `staged`) は canonical な `:0` に正規化
- ref は `git rev-parse --verify` で先に validate
  (`:0` / `""` / `"working"` はリテラルとして許容)

`--` separator で input と ref を明示分離することも可能 (git と同じ)。

### デフォルトと特殊 ref

| ref 表現 | 意味 |
|---|---|
| `""` / `"working"` | working tree (filesystem 上の現状) |
| `":0"` / `"index"` / `"staged"` | git index (`git show :0:path` と同じ) |
| `"HEAD"` / branch / tag / SHA | 通常の git ref |

bare `kicadiff` は `git diff` 互換: **from=`:0`, to=working tree**。
`--cached` / `--staged` で **from=HEAD, to=`:0`** に切替 (= `git diff --cached`)。

`resolveRefToSha` は `:0` / `""` / `"working"` を **そのまま素通し** し、
通常 ref のみ SHA に pin する。index と working tree は commit に対応
しないため pinning の対象外 (途中で `git add` が走る race window は
working tree と同じ前提で受け入れる)。

## ビューア (`viewer.html`)

意図的に 1 ファイル。HTML / CSS / JS を全部内包する。
`scripts/embed-viewer.mjs` がビルド時に `src/viewer-content.ts` に
inline 文字列として注入し、Bun コンパイル後のバイナリにも入る。

### 表示モード

| Mode         | 説明                                            | before 必要? |
|--------------|------------------------------------------------|--------------|
| Overlay      | before と after を重ね、opacity slider でブレンド | ◯ (デフォルト) |
| Side by Side | 横に並べて表示。スクロール同期                  | (after 単体可) |
| Swipe        | divider の clip-path で before/after を切替    | ◯           |

before がないときは Side by Side が自動選択され、Overlay / Swipe は
controls bar / divider を出さず after 1 枚を表示する。

### Zoom と Pan

- Wheel: cursor 位置を支点に zoom (CAD ツールと同じセマンティクス)
- 右クリックドラッグ: pan (左クリックは layer row / divider などの
  UI 操作のため温存)
- スクロールバー: 通常通り pan として機能

zoom は CSS variable (`--zoom`) として root に設定し、layer-stack /
compare-wrap の width が `calc(var(--zoom,1) * 100%)` で連動する。
これにより content の layout box が拡大し、scrollbar が自然に出る。
`transform: scale()` を使わないのは、scrollWidth が transformed size
を反映しないため pan が壊れるから。

### 差分マーカー

- file タブ: `FileManifest.hasDiff === true` のとき琥珀色
- page タブ: `SchPage.hasDiff === true` のとき琥珀色
- diff overlay: pulse animation で目に留まる、デフォルト ON
  (チェックボックスでオフ可)。3 色で意味分けする:
  - **緑** (add): before に無く after にあるピクセル
  - **赤** (delete): before にあり after に無いピクセル
  - **琥珀** (change/move): 両側に内容があるが色が違うピクセル

  overlay は **side ごとに分割して** 配置する:
  - **delete (赤)** は before 画像の上に重ねる。消えたパーツはまだ
    before の方には描かれているので、そこに highlight を載せる方が
    「何があったのか」が見える (after に重ねると空のキャンバスに
    赤マークが浮くだけになる)。
  - **add (緑)** / **change (琥珀)** は after 画像の上に重ねる。新しい
    状態は after で見えているので、その上に highlight を載せる。

  分類は `src/diff-overlay.ts` の `splitDiff()` で純 JS 実装。
  両側の overlay PNG を返し、render は `diff/<safe>-before.png` /
  `diff/<safe>-after.png` の 2 ファイルを書き出す。`triColorDiff()` も
  下位互換 (単一 PNG に 3 色を混ぜる) として残してあるが、viewer は
  splitDiff の出力を side ごとに attach する。
  PCB の combined PNG (KiCad の board background あり) は corner pixel を
  サンプルして「背景色」を判定し、それに近いピクセルを empty 扱いに
  する。schematic / 個別レイヤーは透過背景なので alpha だけで判定。

## マニフェスト

ビューアに渡す JSON。HTML 内に
`<script>window.MANIFEST = {...}</script>` として inline される。

```ts
ProjectManifest {
  files: FileManifest[];
}

FileManifest {
  file: string;          // repo-relative path
  type: "pcb" | "sch" | "sym" | "fp";
  hasBefore: boolean;
  hasDiff?: boolean;     // before/after combined PNG が byte 単位で違うか
  fromRef?: string;      // 比較元の ref (default: ":0" = index)
  toRef?: string;        // 比較先の ref ("" = working tree, ":0" = index)
  after: SideManifest;
  before?: SideManifest; // hasBefore のときのみ
  diff?: { before: string; after: string };
                         // 差分ハイライト PNG を side ごとに分割。
                         // before: delete (赤) のみ。
                         // after:  add (緑) + change (琥珀)。
}

SideManifest {
  combined: string;            // 主画像 (SVG。viewer 側で無限ズーム可)
  layers?: Record<string, string>;  // pcb のみ (SVG)
  pages?: SchPage[];           // sch / sym / fp (各ページ SVG)
}

SchPage {
  name: string;
  image: string;         // SVG。viewer の <img src> として使う
  hasDiff?: boolean;     // before/after の同名 page で PNG byte が違うか
}
```

`hasDiff` は **テキストの差異ではなく視覚的な差異** を表す。例えば
PCB の silkscreen に出ない property の値だけ変わっても hasDiff=false
になる。これにより「diff ありますよ」マーカーがノイズで光らない。
判定はラスタライズ済 PNG の byte 比較で行う (SVG だと whitespace や
要素順だけが変わって視覚的に同じケースを拾えてしまうため)。

### SVG / PNG の役割分担

manifest が viewer に渡す画像はすべて **SVG**。これは viewer 側で
無限にズームしても破綻しないため。

PNG は次の用途で `${side}/${safe}.png` / `${pagesDir}/<name>.png` /
`${layersDir}/<layer>.png` として並走で生成・保持する:

- `hasDiff` の byte 比較
- `--md` レポート用の side-by-side 画像
- 差分ハイライト overlay (`splitDiff` の出力 — `M.diff.before` /
  `M.diff.after` の 2 枚)

ラスタ化は `@resvg/resvg-js` を介して in-process で行うので、ランタイム
には外部ツール (旧 `rsvg-convert`) を必要としない。

## 4 つのファイル型

KiCad は複数の関連ファイル型を持つ。kicadiff は以下を扱う:

| 型     | 拡張子        | 中身                           | レンダリング単位       |
|--------|---------------|--------------------------------|------------------------|
| `pcb`  | `.kicad_pcb`  | 基板配置 + 埋め込みフットプリント | レイヤー (5 種類) ごと |
| `sch`  | `.kicad_sch`  | 回路図 + 埋め込みシンボル       | 階層シートごと          |
| `sym`  | `.kicad_sym`  | シンボルライブラリ              | シンボルごと            |
| `fp`   | `.kicad_mod`  | 単一フットプリント              | 1 個                    |

KiCad 6+ では `.kicad_pcb` / `.kicad_sch` には参照しているシンボル /
フットプリントの定義が embed されているので、`.kicad_sym` /
`.kicad_mod` のライブラリが手元になくてもレンダリングできる。これが
content-hash キャッシュの妥当性の根拠 (詳細は後述)。

`.pretty/` ディレクトリ入力は中の各 `.kicad_mod` を独立した file タブ
として扱う。

### 4 型を pages として統一

ビューアは以下の概念で統一されている:

- **file**: 1 ファイル = 1 file タブ。複数渡されたとき file タブが並ぶ
- **page**: file 内の選択可能な単位
  - sch: 階層シート (root + 子シート)
  - sym: ライブラリ内の各シンボル
  - fp: 通常 1 個 (内部的には pages = [{name, png}])
  - pcb: pages 概念なし (代わりに layer)
- **layer**: PCB のレイヤー (F.Cu, B.Cu, F.Silkscreen, B.Silkscreen, Edge.Cuts)

manifest 上は file が `after.pages[]` を持つかどうかで page 切替の
有無が決まる。

## レンダリングパイプライン

各 side (before / after) を独立に並列レンダリングする。各 side は:

1. ソース取得
   - 作業ツリー: ファイルをそのまま使う
   - git ref: `git show ${ref}:${path}` の出力を temp file
     (`preview_<rand>.<ext>`) として元ファイルの隣に書く
2. キャッシュ確認 (詳細は次節)
3. ヒットしなければ:
   - kicad-cli で SVG 生成
   - `@resvg/resvg-js` で SVG → PNG (in-process)
4. キャッシュへ保存
5. before/after の両方がそろったら `triColorDiff` で差分ハイライト
   PNG を生成 (in-process、いずれの side が欠けていればスキップ)

before と after が完了したら manifest に組み立て、HTML / markdown に
inline する。

### ref pinning

`branch` / `tag` / `HEAD` / `HEAD~N` のような可変な ref は、render に
入る最初に `git rev-parse <ref>^{commit}` で 40 文字 SHA に解決して
固定する (`resolveRefToSha`)。1 回の render では git を複数回叩く
(本体の `.kicad_pcb` / `.kicad_sch` の読み込み、cache key 用の sibling
`.kicad_pro` / `.kicad_prl` の読み込み、kicad-cli に渡す temp 用に
もう一度 sibling 読み込み……) ため、その間に ref が動くと別 commit の
bytes が混ざって kicad-cli にプロジェクトとして矛盾した入力を渡すこと
になる。先に SHA に pin することで、render 中に branch が force-push
されたり `git fetch` が走ったりしても、すべての git read が同じ
スナップショットを見る。

`renderProject` でも一度 pin するので、並列で走る複数ファイルの
render も同じ commit を見る (`.kicad_pcb` と `.kicad_sch` で別 commit を
見てしまうのを防ぐ)。`render` 内でも再度 pin するが、すでに 40 文字
SHA であれば idempotent。

manifest の `fromRef` / `toRef` には pin 済みの SHA を記録する。
レポートを後から読み直すときに、branch が動いていても「どの commit と
比較したか」が確定できる。ビューアの `refLabel` と markdown の
`refLabelMd` がどちらも 40 文字 SHA を 7 文字に短縮して表示する。

### temp file の lifecycle

git ref から render するとき、kicad-cli は on-disk のファイルパスを
要求する。一方 kicad-cli は input と同じ basename の sibling
`.kicad_prl` を勝手に作る。これを残すと:

1. 作業ツリーが汚染される (preview_*.kicad_prl が増え続ける)
2. キャッシュキーが churn する (`.kicad_prl` をキー材料に含めるため)
3. `.pretty/` 入力の場合、kicad-cli がライブラリスキャン時に
   余分な `.kicad_mod` (= 我々の temp) を見つけて衝突する

そこで:

- temp file の作成は `O_EXCL` でアトミック (race 対策)
- `finally` で temp と sibling `.kicad_prl` を必ず unlink
- `resolveInputs` の `.pretty/` スキャンは `preview_*.kicad_mod` を
  防御的に除外
- フットプリントの場合は元の lib ディレクトリではなく、render
  ごとに作る隔離 lib (`<pagesDir>/lib.pretty/`) で kicad-cli を
  実行する。並列レンダリングで他の render の temp が衝突するのを
  避けるため

## キャッシュ

レンダリングは数秒〜数十秒かかるが、入力が同じなら結果も同じになる
ように設計されている。それを利用して content-addressed なキャッシュ
を持つ。

### キャッシュキーの構成

```
sha256(
  schema_version          # bump で全 invalidate
  + kicad-cli --version   # kicad-cli の挙動が変わったとき切り替わる
  + file_type             # pcb/sch/sym/fp で別 entry
  + abs_file_path         # 同 content でも path が違えば別 entry
  + sibling .kicad_pro / .kicad_prl content (pcb/sch のみ)
  + source_content
)
```

#### なぜ abs_file_path も含めるか

**原則として content が同じなら結果も同じ** だが、KiCad は project-
level の設定 (theme, variant など) を `.kicad_pro` / `.kicad_prl`
から拾う。同じ内容のファイルが別ディレクトリに置かれていて、その
ディレクトリの project 設定が違うと、レンダリング結果も変わりうる。

そこで「保守的に: path が違ったら別 entry」とした。これにより
sibling project files の差異も自動的に分岐に反映される (path の
ハッシュ値が違うので別エントリになる)。同時に sibling の content も
ハッシュキーに足しているので、project 設定だけ変わってもキャッシュは
追従する。

#### preview_*.kicad_prl の扱い

過去の crash run の残骸として `preview_*.kicad_prl` が残っていると、
これがキャッシュキーに混入してキャッシュが churn する。`cacheKeyFor`
は `preview_*.kicad_prl` を sibling fingerprint から除外することで
defensive に処理している。

### キャッシュレイアウト

```
<KICADIFF_CACHE_DIR>/
  <hash[0:2]>/          # 先頭 2 文字でディレクトリを分けて hot dir 回避
    <hash[2:]>/
      combined.png      # primary 画像 (PCB combined / sch root / sym 1st)
      extras/           # type 依存
        <layer>.png     # pcb の場合: F_Cu.png, B_Cu.png, ...
        <page>.png      # sch / sym / fp の場合
```

cache hit 時は `combined.png` を `<sideDir>/<safe>.png` に、`extras/`
の中身を type 別の dir (`layers_<safe>/` / `sch_pages_<safe>/` /
`items_<safe>/`) に展開する。

cache miss 時はレンダリング → 結果をキャッシュへ書き戻す (best-effort、
失敗しても render 自体は成功扱い)。
