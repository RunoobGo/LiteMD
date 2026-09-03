#!/usr/bin/env bash
#
# LiteMD — Windows 11 x64 最精简发行构建
#
# 设计目标：在「体积最小」与「可靠运行」之间取最优解，取舍均有实测依据：
#   1. -webview2 browser  Win11 全版本内置 WebView2 Evergreen Runtime，
#                         直接调用系统组件，不内嵌 / 不下载引导器。
#   2. 自研 NSIS 检测宏    替换 wails.webview2runtime —— 后者会无条件把
#                         1.79MB 的 MicrosoftEdgeWebview2Setup.exe 打进安装包，
#                         在 browser 策略下是死重（实测安装包 6.01MB → 3.43MB）。
#   3. -ldflags "-s -w"    剥离符号表与 DWARF；-trimpath 移除构建机路径。
#   4. LZMA 固实压缩       SetCompressor /SOLID lzma + 32MB 字典。
#   5. 不使用 UPX          实测对安装包仅省 101KB(3%)，却引入杀软误报与
#                         启动解压开销，性价比为负。仅便携版可选启用。
#
# 产物（默认输出到 ./dist）：
#   LiteMD-<ver>-Setup-x64.exe         安装包（推荐，含文件关联 + 卸载）
#   LiteMD-<ver>-Portable-x64.zip      便携版（单 exe，免安装）
#   LiteMD-<ver>-Portable-x64-upx.zip  便携版 UPX 压缩（极致体积）
#   CHECKSUMS.txt                      SHA256 校验和
#
# 用法：
#   ./build-win11-x64.sh              # 构建 + 打包
#   OUT=/path/to/dir ./build-win11-x64.sh
#   WITHOUT_UPX=1 ./build-win11-x64.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

export PATH="$PATH:$(go env GOPATH)/bin:/usr/local/go-packages/bin"
export GOTOOLCHAIN=auto          # go.mod 要求 go1.27.1，缺失时自动拉取工具链
export GOOS=windows
export GOARCH=amd64

OUT="${OUT:-$ROOT/dist}"

# ---- 前置检查 ----
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ 缺少依赖: $1 — $2"; exit 1; }; }
need go        "安装 Go 1.27+（工具链会自动对齐 go.mod）"
need wails     "go install github.com/wailsapp/wails/v2/cmd/wails@v2.14.0"
need makensis  "apt-get install -y nsis"
need zip       "apt-get install -y zip"

# ---- 版本号管理 ----
# 规则：
#   无参         → 自动递增 patch 位（0.2.0 → 0.2.1），同时回写五处事实源
#   VERSION=x.y.z → 用指定版本替换五处事实源（不做自增，仅替换）
#                   若与 wails.json 当前值不同，回写并警告（避免 exe 内部
#                   版本与交付文件名错位——审查 P1-12）
#   SKIP_BUMP=1   → 完全不动 wails.json / app.go 等，仅沿用当前版本打包
#                   （重打包同一版的合理用例——给到上游发行通道外的复测；
#                   与 VERSION= 的"重写"语义不同，必须显式区分）
#
# 事实源（必须全部同步，否则安装包是新版、关于框/启动屏/前端版本仍是旧版）：
#   1. wails.json                — NSIS 的 OutFile、VIProductVersion
#   2. app.go (AppVersion)       — 关于框/设置面板显示
#   3. frontend/index.html       — 启动屏 v 号
#   4. frontend/dev.html         — dev server 启动屏 v 号
#   5. frontend/src/mocks.ts     — 浏览器 mock 的 AppInfo
#   6. README.md 下载文件名       — 审查 P1-12 新增第六处
CUR="$(grep -o '"productVersion"[[:space:]]*:[[:space:]]*"[^"]*"' wails.json | grep -o '[0-9][^"]*' | head -1)"

if [ -n "${SKIP_BUMP:-}" ]; then
  NEXT="$CUR"
  echo "==> SKIP_BUMP：沿用当前版本 $CUR，跳过事实源同步（仅供重打包）"
elif [ -n "${VERSION:-}" ]; then
  NEXT="$VERSION"
  case "$CUR" in "$NEXT") echo "==> VERSION=$NEXT 与 wails.json 一致，跳过回写（同值无意义 sed）";; *)
    echo "==> VERSION=${VERSION} → 回写五处事实源（原 ${CUR}）"
  esac
else
  case "$CUR" in
    *.*.*)
      MAJ="${CUR%%.*}"; REST="${CUR#*.}"; MIN="${REST%%.*}"; PAT="${REST#*.}"
      case "$PAT" in
        ''|*[!0-9]*) echo "✗ 无法解析版本号第三位(patch)：$CUR"; exit 1;;
      esac
      NEXT="${MAJ}.${MIN}.$((PAT + 1))"
      ;;
    *) echo "✗ 版本号格式不是 x.y.z：$CUR"; exit 1;;
  esac
  echo "==> 版本号递增：$CUR → $NEXT"
fi

if [ "${NEXT:-}" != "${CUR}" ] && [ -z "${SKIP_BUMP:-}" ]; then
  sed -i.bak "s/\"productVersion\":[[:space:]]*\"$CUR\"/\"productVersion\": \"$NEXT\"/" wails.json
  sed -i.bak "s/const AppVersion = \"$CUR\"/const AppVersion = \"$NEXT\"/" app.go
  sed -i.bak "s/>v$CUR</>v$NEXT</" frontend/index.html frontend/dev.html
  sed -i.bak "s/\"$CUR-mock\"/\"$NEXT-mock\"/" frontend/src/mocks.ts
  # 审查 P1-12：README.md 的下载文件名也属事实源
  sed -i.bak "s/LiteMD-${CUR}-Setup/LiteMD-${NEXT}-Setup/" README.md
  rm -f wails.json.bak app.go.bak frontend/index.html.bak frontend/dev.html.bak frontend/src/mocks.ts.bak README.md.bak
fi

# VERSION 必须放在 bump 之后读取：否则在 bump 分支会被旧值覆盖
VERSION="${VERSION:-$NEXT}"
[ -z "$VERSION" ] && VERSION="$CUR"

# P1-12：VERSION 显式指定且与 wails.json 不一致时给出明确警告（已改为回写，
# 此处警告仅在用户用了 SKIP_BUMP=1 又同时传 VERSION= 的矛盾组合下出现）
if [ -n "${VERSION+x}" ] && [ -n "${SKIP_BUMP+x}" ] && [ "${VERSION}" != "${CUR}" ]; then
  echo "==> 警告：SKIP_BUMP + VERSION= 是矛盾组合——脚本沿用 ${CUR}，" \
       "但你指定的 VERSION=${VERSION} 未生效。要重写请去掉 SKIP_BUMP。"
  VERSION="$CUR"
fi

echo "==> LiteMD v${VERSION} — Windows 11 x64 精简构建"

# ---- 1. 同步 NSIS 工程（build/windows 是 wails 实际读取的目录）----
mkdir -p build/windows/installer
cp -f nsis-src/installer/project.nsi build/windows/installer/project.nsi
# wails 只在 wails_tools.nsh 缺失时才生成它（为了不覆盖用户自定义宏）。
# 版本升级后若沿用上一版残留的文件，安装包内的 ProductVersion 会滞后于
# wails.json。这里删掉强制重新生成——本项目的自定义逻辑全在 project.nsi 里，
# wails_tools.nsh 用的是官方模板，重新生成等价且更安全。
rm -f build/windows/installer/wails_tools.nsh

# ---- 2. 前端产物 ----
echo "==> 构建前端"
if [ ! -d frontend/node_modules/.bin ] || [ ! -d frontend/dist ]; then
  ( cd frontend && npm ci --no-audit --no-fund )
fi
( cd frontend && npm run build )

# ---- 3. 交叉编译 + NSIS 安装包 ----
echo "==> 交叉编译 windows/amd64（webview2=browser, -ldflags='-s -w'）"
wails build \
  -platform windows/amd64 \
  -webview2 browser \
  -trimpath \
  -ldflags "-s -w" \
  -nsis \
  -clean

EXE="build/bin/LiteMD.exe"
# pipefail 下 ls 无匹配会返回非零并在 set -e 下直接杀死脚本，
# 加 `|| true` 让「✗ 未生成安装包」的友好报错得以生效（审查 🟡-5）
SETUP="$(ls build/bin/LiteMD-Setup-*-installer.exe 2>/dev/null | head -1 || true)"
[ -f "$EXE" ]   || { echo "✗ 未生成 $EXE"; exit 1; }
[ -f "$SETUP" ] || { echo "✗ 未生成安装包"; exit 1; }

# ---- 4. 打包交付 ----
echo "==> 打包至 $OUT"
mkdir -p "$OUT"
cp -f "$SETUP" "$OUT/LiteMD-${VERSION}-Setup-x64.exe"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 产物完整性校验：exe 原始体积约 11MB，压缩包若远小于此说明打包异常
# （曾偶发 zip 只写出 1.8KB 空壳而退出码仍为 0，故显式设下限）。
verify_zip() {
  local f="$1"; local name="$2"; local min=$((1024 * 1024))
  # P0-6：GNU 专用的 stat -c%s 在 macOS（BSD stat）上报 illegal option，
  # 且这是构建的最后一步——前端编译、交叉编译全部白跑。改用 wc -c，
  # macOS/Linux 通用；输出可能带前导空格，tr 掉。
  local size; size=$(wc -c < "$f" 2>/dev/null | tr -d '[:space:]' || echo 0)
  size="${size:-0}"
  if [ "$size" -lt "$min" ]; then
    echo "✗ ${name} 体积异常（${size} 字节 < 1MB），打包失败"
    return 1
  fi
  return 0
}

mkdir -p "$TMP/plain" "$TMP/upx"
cp "$EXE" "$TMP/plain/LiteMD.exe"
( cd "$TMP/plain" && zip -9 -q "$OUT/LiteMD-${VERSION}-Portable-x64.zip" LiteMD.exe )
verify_zip "$OUT/LiteMD-${VERSION}-Portable-x64.zip" "便携版 zip" || exit 1

if [ -z "${WITHOUT_UPX:-}" ] && command -v upx >/dev/null 2>&1; then
  cp "$EXE" "$TMP/upx/LiteMD.exe"
  # UPX 版是可选产物：压缩失败（偶发的 IO 抖动等）不应拖垮整个构建
  if upx --best --lzma -q "$TMP/upx/LiteMD.exe" >/dev/null 2>&1; then
    ( cd "$TMP/upx" && zip -9 -q "$OUT/LiteMD-${VERSION}-Portable-x64-upx.zip" LiteMD.exe )
    verify_zip "$OUT/LiteMD-${VERSION}-Portable-x64-upx.zip" "UPX 便携版 zip" \
      || rm -f "$OUT/LiteMD-${VERSION}-Portable-x64-upx.zip"
  else
    echo "==> 警告：UPX 压缩失败，跳过 UPX 便携版（其余产物不受影响）"
  fi
fi

( cd "$OUT" && sha256sum LiteMD-${VERSION}-*.exe LiteMD-${VERSION}-*.zip > CHECKSUMS.txt 2>/dev/null || true )

echo "==> 完成"
ls -la "$OUT"
