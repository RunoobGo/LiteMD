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
export GOTOOLCHAIN=auto          # go.mod 要求 go1.25，缺失时自动拉取工具链
export GOOS=windows
export GOARCH=amd64

VERSION="${VERSION:-$(grep -o '"productVersion"[[:space:]]*:[[:space:]]*"[^"]*"' wails.json | grep -o '[0-9][^"]*' | head -1)}"
VERSION="${VERSION:-0.2.0}"
OUT="${OUT:-$ROOT/dist}"

# ---- 前置检查 ----
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ 缺少依赖: $1 — $2"; exit 1; }; }
need go        "安装 Go 1.21+（工具链会自动升级到 1.25）"
need wails     "go install github.com/wailsapp/wails/v2/cmd/wails@v2.14.0"
need makensis  "apt-get install -y nsis"
need zip       "apt-get install -y zip"

echo "==> LiteMD v${VERSION} — Windows 11 x64 精简构建"

# ---- 1. 同步 NSIS 工程（build/windows 是 wails 实际读取的目录）----
mkdir -p build/windows
cp -f build_windows/installer/project.nsi build/windows/installer/project.nsi

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
SETUP="$(ls build/bin/LiteMD-Setup-*-installer.exe 2>/dev/null | head -1)"
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
  local size; size=$(stat -c%s "$f" 2>/dev/null || echo 0)
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
