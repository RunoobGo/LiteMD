#!/usr/bin/env bash
#
# LiteMD — Windows (amd64) 一键构建脚本
# 交叉编译生成 LiteMD.exe，并打包 NSIS 安装包。
# 适用：Linux/macOS 宿主 + 已安装 mingw-w64 / nsis / wails CLI。
#
# 用法：
#   ./build-windows.sh            # 默认构建 amd64 + 安装包
#   OUTDIR=/path/to/deliver ./build-windows.sh
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# ---- 环境前置 ----
export PATH="$PATH:$(go env GOPATH)/bin"
export GOTOOLCHAIN=auto          # go.mod 要求 1.25，自动拉取工具链

WEBVIEW2="${WEBVIEW2:-download}" # download | embed | browser | error
OUTDIR="${OUTDIR:-build/bin}"

# ---- 关键修复：确保 build/windows 为真实目录（非指向 build_windows 的软链）----
# Wails 的 project.nsi 用相对路径 "..\..\bin" 解析输出，软链会导致物理 CWD 错位。
if [ -L "build/windows" ]; then
  echo "[fix] 检测到 build/windows 为软链，替换为真实目录"
  rm "build/windows"
  cp -r build_windows build/windows
elif [ ! -d "build/windows/installer" ]; then
  echo "[fix] build/windows/installer 缺失，从 build_windows 复制"
  mkdir -p build/windows
  cp -r build_windows/. build/windows/
fi

# ---- 交叉编译 + NSIS 安装包 ----
echo "==> wails build -platform windows/amd64 -webview2 $WEBVIEW2 -nsis"
wails build -platform windows/amd64 -webview2 "$WEBVIEW2" -nsis

# ---- 交付 ----
mkdir -p "$OUTDIR"
if [ -n "${DELIVER:-}" ]; then
  mkdir -p "$DELIVER"
  cp build/bin/LiteMD.exe "$DELIVER/"
  cp build/bin/LiteMD-Setup-*-installer.exe "$DELIVER/" 2>/dev/null || true
  ( cd "$DELIVER" && sha256sum LiteMD.exe LiteMD-Setup-*-installer.exe > CHECKSUMS.txt 2>/dev/null || true )
  echo "==> 已交付至 $DELIVER"
fi

echo "==> 产物："
ls -la build/bin/LiteMD.exe build/bin/LiteMD-Setup-*-installer.exe 2>/dev/null
