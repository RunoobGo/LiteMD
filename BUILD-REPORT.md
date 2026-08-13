# LiteMD — Windows 11 (x64) 安装包构建报告

**构建时间**：2026-08-13
**目标平台**：Windows 11 x64 (amd64)
**框架版本**：Wails v2.14.0 + Go 1.25.0（工具链自动拉取）+ WebView2 Runtime
**产物位置**：`/workspace/LiteMD-Windows/`

---

## 一、交付物

| 文件 | 类型 | 大小 | 说明 |
|------|------|------|------|
| `LiteMD.exe` | PE32+ GUI x86-64 | 11.87 MB | 可直接运行的便携可执行程序 |
| `LiteMD-Setup-1.0.0-installer.exe` | Nullsoft Installer (NSIS) 自解压归档 | 6.54 MB | 标准安装包，含卸载程序 |
| `CHECKSUMS.txt` | SHA256 校验和 | — | 产物完整性核验 |
| `build-windows.sh` | 一键构建脚本 | — | 可复现的 Windows 构建流程 |

> `file` 校验：`LiteMD.exe` → *PE32+ executable (GUI) x86-64, for MS Windows, 9 sections*；
> 安装包 → *PE32 executable (GUI) Intel 80386, Nullsoft Installer self-extracting archive, 7 sections*。
> 安装包字符串校验确认内嵌 `LiteMD` / `LiteMD Installer` 品牌与 `2026 LiteMD` 版权。

---

## 二、构建环境

| 组件 | 版本/路径 |
|------|-----------|
| 宿主系统 | Ubuntu 22.04 linux/amd64（交叉编译） |
| Go | 1.21.4（经 `GOTOOLCHAIN=auto` 自动拉取 1.25.0 工具链） |
| Wails CLI | v2.14.0（`/usr/local/go-packages/bin/wails`） |
| C 交叉编译器 | `x86_64-w64-mingw32-gcc` (GCC 13-win32)，CGO 必需 |
| NSIS | `makensis` v3.09 |

> **说明**：本项目 `go.mod` 声明 `go 1.25.0`，高于系统 Go 1.21.4，构建时由 `GOTOOLCHAIN=auto` 自动下载对应工具链（已缓存，二次构建仅 6s）。

---

## 三、构建流程与踩坑记录

### 步骤 1：交叉编译 exe（Task #16）
```bash
GOTOOLCHAIN=auto wails build -platform windows/amd64 -webview2 download
```
- 首次构建触发 WebView2 引导器下载与 CGO 编译，产出 `build/bin/LiteMD.exe`。
- 默认 `webview2` 策略为 `download`，会在安装包内嵌入 WebView2 引导器作为兜底——**Windows 11 已预装 WebView2 Runtime，绝大多数情况下不会触发下载**。

### 步骤 2：生成 NSIS 安装包（Task #17）
```bash
GOTOOLCHAIN=auto wails build -platform windows/amd64 -webview2 download -nsis
```
该步骤会重写 `wails_tools.nsh`（注入真实 `INFO_PRODUCTNAME/INFO_PRODUCTVERSION` 等）、抽取 WebView2 引导器到 `installer/tmp/`，并调用 `makensis`。

---

### ⚠️ 坑 1：`-webview2 runtime` 非法取值
- **现象**：`ERROR invalid option for flag 'webview2': runtime`
- **原因**：Wails v2.14 的 `-webview2` 仅接受 `download | embed | browser | error`，无 `runtime`。
- **修复**：改用 `-webview2 download`（默认策略，适合 Win11）。

### ⚠️ 坑 2：符号链接导致 NSIS 输出路径错位
- **现象**：`makensis` 在最后报 `Output: "../../bin/LiteMD-Setup-1.0.0-installer.exe"` → `Can't open output file`。
- **根因**：项目使用非标准目录 `build_windows/`，此前为让 Wails 识别而创建软链 `build/windows -> ../build_windows`。`project.nsi` 中 `OutFile "..\..\bin\..."` 是**相对当前工作目录**解析的；软链使 `makensis` 的物理 CWD 变为 `build_windows/installer/`，`..\..\bin` 被解析成不存在的 `<项目根>/bin`，而非预期的 `build/bin`。
- **修复**：移除软链，将 `build_windows` **复制为真实目录** `build/windows`，再从 `build/windows/installer/` 以正确 CWD 手动调用：
  ```bash
  cd build/windows/installer
  makensis -DARG_WAILS_AMD64_BINARY=<abs>/build/bin/LiteMD.exe project.nsi
  ```
  安装包成功生成于 `build/bin/LiteMD-Setup-1.0.0-installer.exe`。

> **后续提示**：现在 `build/windows` 已是真实目录，日后直接 `wails build -platform windows/amd64 -nsis` 即可一次性产出 exe + 安装包，无需再手动修路径。

---

## 三·五、产物完整性校验（SHA256）

```
71781a6a8c1b79c00c27642c29ded569fd5bcf903ab7832953f82a1799594715  LiteMD.exe
7b32898f5e0d9f331e554916df706a088374c5a2158034e7a6a0042933ffb1a8  LiteMD-Setup-1.0.0-installer.exe
```

已随包附带 `CHECKSUMS.txt`，下载后可 `sha256sum -c CHECKSUMS.txt` 核验。

## 四、验证结果（Task #18）

| 检查项 | 结果 |
|--------|------|
| `LiteMD.exe` 文件类型 | ✅ PE32+ GUI x86-64 MS Windows |
| `LiteMD-Setup-1.0.0-installer.exe` 文件类型 | ✅ NSIS 自解压安装包 |
| 安装包内嵌品牌 | ✅ 含 `LiteMD` / `LiteMD Installer` / `2026 LiteMD` |
| 安装包内嵌 WebView2 引导器 | ✅ `tmp/MicrosoftEdgeWebview2Setup.exe` (1.79 MB) |
| exe 大小 / 安装包大小 | ✅ 11.87 MB / 6.54 MB |
| 产物交付位置 | ✅ `/workspace/LiteMD-Windows/` |

---

## 五、安装包行为说明（面向最终用户）

- 安装目录：`C:\Program Files\LiteMD\LiteMD\`（machine 级，需管理员权限）
- 自动创建「开始菜单」与「桌面」快捷方式
- 安装时若检测到系统未安装 WebView2 Runtime，会静默拉起内嵌引导器安装
- 提供标准「卸载程序」(`uninstall.exe`)，清理安装目录与快捷方式

---

## 六、复现命令（一键）

```bash
export PATH="$PATH:$(go env GOPATH)/bin"
cd <项目根>/LiteMD-main
GOTOOLCHAIN=auto wails build -platform windows/amd64 -webview2 download -nsis
# 产物：build/bin/LiteMD.exe 与 build/bin/LiteMD-Setup-1.0.0-installer.exe
```

或使用随附脚本（已内置软链→真实目录的防护，避免坑 2 复现）：

```bash
DELIVER=/workspace/LiteMD-Windows ./build-windows.sh
```
