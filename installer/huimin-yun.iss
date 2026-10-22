; ============================================================
; 惠民云进销存 —— Windows 安装包脚本（Inno Setup 6）
;
; 产物：惠民云进销存-Setup-<版本>.exe
; 安装位置：默认 %LOCALAPPDATA%\HuiminYun，用户可在安装向导里改到任意目录
; 数据位置：%APPDATA%\huimin-yun（卸载默认保留；卸载时询问是否一并删除）
; 启动方式：桌面/开始菜单快捷方式指向「惠民云进销存.exe」（无控制台窗口 + 自带图标）
;
; 打包前先运行 pnpm run dist:win：
;   产出 installer/payload/ 完整运行目录（应用文件 + 自带 node.exe + 原生启动器）
; 注意：本文件位于 installer/ 下，Inno 的 SourcePath 即 installer/，
;      故相对路径不要重复写 installer\ 前缀（否则会变成 installer\installer\…）
; ============================================================

#define MyAppName "惠民云进销存"
#define MyAppNameEn "HuiminYun"
#define MyAppVersion ReadIni(SourcePath + "\version.ini", "app", "version", "0.0.0")
; 原生无窗口启动器（自带图标，替代原先会弹终端窗口的 .cmd 入口）
#define MyAppExeName "惠民云进销存.exe"

[Setup]
AppId={{8A3E1C62-5B7D-4B8E-9A21-ORANGEJXC001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={localappdata}\{#MyAppNameEn}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 非管理员可安装；privilegesRequired=lowest 允许直接双击安装
PrivilegesRequired=lowest
OutputDir=out
OutputBaseFilename=惠民云进销存-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 中文界面
ShowLanguageDialog=no
UninstallDisplayName={#MyAppName}
; 允许用户自选安装目录（向导第 2 页「安装文件夹」）
DisableDirPage=no
; 允许改变安装目录名
AllowNoIcons=no
; 安装/卸载都需要写权限时才提示提升；默认 lowest 直接装
; 安装包自身与卸载项的图标（应用图标；SourcePath 即 installer/，故用 ..\assets\…）
SetupIconFile=..\assets\icon-app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
; 卸载时勾选「同时删除数据」的附加任务（默认不勾，保留用户数据）
CloseApplications=yes
RestartApplications=no

[Languages]
; 简体中文语言文件随仓库携带：Inno Setup 官方安装包不含中文翻译（compiler:Languages 下没有
; ChineseSimplified.isl），依赖它会导致「Couldn't open include file」编译中止。
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"

[Files]
; 应用全部文件（dist、web、tools、launcher、node.exe、原生启动器 …）
; 排除 portable.flag：安装版数据必须落 %APPDATA%\huimin-yun；若把该标记装进安装目录，
;   launcher 会把数据改放 {app}\data，而 {app} 在卸载时会被清理 → 用户数据随卸载丢失
Source: "payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: "portable.flag"

[Icons]
; 快捷方式统一指向原生 exe：图标来自 exe 自身资源，不再是 cmd 的默认图标；
; 且 exe 是 winexe，双击不会弹出黑色终端窗口。
; 显式写 IconLocation：避免 Windows 图标缓存没刷新时显示成空白/通用图标。
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; IconIndex: 0
Name: "{group}\卸载{#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; IconIndex: 0; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: checkedonce

; 注意：这里**不**用「勾选才删数据」的附加任务。
; 原因：Inno 的附加任务在静默安装（/VERYSILENT）与 MERGETASKS 组合下，
; 默认 Flags: unchecked 仍可能被一并选中并写进注册表
; （实测 Selected Tasks 变成 desktopicon,deletedata），结果是「卸载即删账套数据」——
; 对用户是数据丢失事故。
; 因此改为：卸载一律保留数据目录；需要彻底清除时用独立的
; 「彻底清除工具」（tools/clean-install.cjs）或手动删除 %APPDATA%\huimin-yun。

[Run]
; 安装完成可选立即启动（nowait + 无窗口 exe，用户不会看到黑窗）
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前停止服务与启动器（数据目录一律保留）
Filename: "{app}\node\node.exe"; Parameters: """{app}\tools\uninstall-stop.cjs"""; Flags: runhidden waituntilterminated; RunOnceId: "StopServer"

[UninstallDelete]
; 清理安装目录内的运行期产物
Type: filesandordirs; Name: "{app}\.tools"
Type: files; Name: "{app}\data\*.pid"
; 刻意**不**删除 %APPDATA%\huimin-yun：账套数据保留，重装即恢复。
; 需要彻底清除时用 tools/clean-install.cjs（会二次确认）。
