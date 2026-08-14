Unicode true

####
## Please note: Template replacements don't work in this file. They are provided with default defines like
## mentioned underneath.
## If the keyword is not defined, "wails_tools.nsh" will populate them with the values from ProjectInfo. 
## If they are defined here, "wails_tools.nsh" will not touch them. This allows to use this project.nsi manually 
## from outside of Wails for debugging and development of the installer.
## 
## For development first make a wails nsis build to populate the "wails_tools.nsh":
## > wails build --target windows/amd64 --nsis
## Then you can call makensis on this file with specifying the path to your binary:
## For a AMD64 only installer:
## > makensis -DARG_WAILS_AMD64_BINARY=..\..\bin\app.exe
## For a ARM64 only installer:
## > makensis -DARG_WAILS_ARM64_BINARY=..\..\bin\app.exe
## For a installer with both architectures:
## > makensis -DARG_WAILS_AMD64_BINARY=..\..\bin\app-amd64.exe -DARG_WAILS_ARM64_BINARY=..\..\bin\app-arm64.exe
####
## The following information is taken from the ProjectInfo file, but they can be overwritten here. 
####
## !define INFO_PROJECTNAME    "MyProject" # Default "{{.Name}}"
## !define INFO_COMPANYNAME    "MyCompany" # Default "{{.Info.CompanyName}}"
## !define INFO_PRODUCTNAME    "MyProduct" # Default "{{.Info.ProductName}}"
## !define INFO_PRODUCTVERSION "1.0.0"     # Default "{{.Info.ProductVersion}}"
## !define INFO_COPYRIGHT      "Copyright" # Default "{{.Info.Copyright}}"
###
## !define PRODUCT_EXECUTABLE  "Application.exe"      # Default "${INFO_PROJECTNAME}.exe"
## !define UNINST_KEY_NAME     "UninstKeyInRegistry"  # Default "${INFO_COMPANYNAME}${INFO_PRODUCTNAME}"
####
## !define REQUEST_EXECUTION_LEVEL "admin"            # Default "admin"  see also https://nsis.sourceforge.io/Docs/Chapter4.html
####
## Include the wails tools
####
!include "wails_tools.nsh"

# The version information for this two must consist of 4 parts
VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

!include "MUI.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
# !define MUI_WELCOMEFINISHPAGE_BITMAP "resources\leftimage.bmp" #Include this to add a bitmap on the left side of the Welcome Page. Must be a size of 164x314
!define MUI_FINISHPAGE_NOAUTOCLOSE # Wait on the INSTFILES page so the user can see the details of the installation steps
!define MUI_ABORTWARNING # This will warn the user if they exit from the installer.

!insertmacro MUI_PAGE_WELCOME # Welcome to the installer page.
# !insertmacro MUI_PAGE_LICENSE "resources\eula.txt" # Adds a EULA page to the installer
!insertmacro MUI_PAGE_DIRECTORY # In which folder install page.
!insertmacro MUI_PAGE_INSTFILES # Installing page.
!insertmacro MUI_PAGE_FINISH # Finished page.

!insertmacro MUI_UNPAGE_INSTFILES # Uinstall page

!insertmacro MUI_LANGUAGE "English" # Set the Language of the installer

## 以下两个信息用于签名安装器和卸载器。二进制路径由 %1 提供
#!uninstfinalize 'signtool --file "%1"'
#!finalize 'signtool --file "%1"'

# =============================================================================
# 文件关联宏:.md 系扩展 → LiteMD.Document ProgId
# 写法说明:
#   - ProgId(软件类\LiteMD.Document)声明图标与 "open" 命令 '"app.exe" "%1"',
#     后者正是"使用本应用打开"向应用传递文件路径的机制;
#   - 各扩展默认值条件接管(仅当原值为空),同时始终登记 OpenWithProgids,
#     保证不覆盖其他编辑器的既有关联,用户可随时切换默认应用。
# =============================================================================
!macro ASSOC_LITEMD_EXT EXT
    # 默认值仅在当前为空(无其他应用占用该扩展)时接管,避免静默覆盖
    # Typora/VSCode 等用户既有关联;OpenWithProgids 始终登记,
    # 保证 LiteMD 出现在系统"打开方式"菜单,用户可自行设为默认。
    ReadRegStr $0 SHCTX "Software\Classes\.${EXT}" ""
    ${If} $0 == ""
        WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "LiteMD.Document"
    ${EndIf}
    WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "LiteMD.Document" ""
!macroend

!macro UNASSOC_LITEMD_EXT EXT
    # 仅当默认值仍指向 LiteMD 时清空,不覆盖用户后来改选的其他关联
    ReadRegStr $0 SHCTX "Software\Classes\.${EXT}" ""
    ${If} $0 == "LiteMD.Document"
        DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
    ${EndIf}
    DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "LiteMD.Document"
!macroend

Name "${INFO_PRODUCTNAME}"
# P3 修复：统一产物命名为 LiteMD-Setup-v{version}.exe，与 README 一致
OutFile "..\..\bin\${INFO_PRODUCTNAME}-Setup-${INFO_PRODUCTVERSION}-installer.exe"
InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}"
ShowInstDetails show

Function .onInit
   !insertmacro wails.checkArchitecture
FunctionEnd

Section
    !insertmacro wails.setShellContext

    !insertmacro wails.webview2runtime

    SetOutPath $INSTDIR
    
    !insertmacro wails.files

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    # --- 文件关联:.md 系扩展 → LiteMD(安装后双击即用本应用打开) ---
    WriteRegStr SHCTX "Software\Classes\LiteMD.Document" "" "LiteMD Markdown Document"
    WriteRegStr SHCTX "Software\Classes\LiteMD.Document" "FriendlyTypeName" "LiteMD Markdown Document"
    WriteRegStr SHCTX "Software\Classes\LiteMD.Document\DefaultIcon" "" "$INSTDIR\${PRODUCT_EXECUTABLE},0"
    WriteRegStr SHCTX "Software\Classes\LiteMD.Document\shell" "" "open"
    WriteRegStr SHCTX "Software\Classes\LiteMD.Document\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXECUTABLE}" "%1"'
    !insertmacro ASSOC_LITEMD_EXT md
    !insertmacro ASSOC_LITEMD_EXT markdown
    !insertmacro ASSOC_LITEMD_EXT mdown
    !insertmacro ASSOC_LITEMD_EXT mkd

    !insertmacro wails.writeUninstaller
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}" # Remove the WebView2 DataPath

    # --- 清理文件关联(仅回收本应用写入的注册表项) ---
    DeleteRegKey SHCTX "Software\Classes\LiteMD.Document"
    !insertmacro UNASSOC_LITEMD_EXT md
    !insertmacro UNASSOC_LITEMD_EXT markdown
    !insertmacro UNASSOC_LITEMD_EXT mdown
    !insertmacro UNASSOC_LITEMD_EXT mkd

    RMDir /r $INSTDIR

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.deleteUninstaller
SectionEnd
