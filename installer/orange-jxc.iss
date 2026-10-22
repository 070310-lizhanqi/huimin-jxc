; ============================================================
; 橙子进销存 —— Windows 安装包脚本（Inno Setup 6）
;
; 产物：橙子进销存-Setup-<版本>.exe
; 安装位置：%LOCALAPPDATA%\OrangeJXC（普通用户权限，无需管理员）
; 数据位置：%APPDATA%\orange-jxc（卸载/升级均保留；便携模式 data/ 由用户自管）
;
; 打包前先运行 pnpm run dist:prep（见 package.json）：
;   产出 installer/payload/ 完整运行目录（应用文件 + 自带 node.exe）
; ============================================================

#define MyAppName "橙子进销存"
#define MyAppNameEn "OrangeJXC"
#define MyAppVersion ReadIni(SourcePath + "\installer\version.ini", "app", "version", "0.0.0")
#define MyAppExeName "橙子进销存.cmd"

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
OutputDir=installer\out
OutputBaseFilename=橙子进销存-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 中文界面
ShowLanguageDialog=no
UninstallDisplayName={#MyAppName}
; 卸载时不删除数据目录（%APPDATA%\orange-jxc 不在 {app} 内，天然保留）

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
; 应用全部文件（dist、web、tools、launcher、node.exe …）
; 排除 portable.flag：安装版数据必须落 %APPDATA%\orange-jxc；若把该标记装进安装目录，
;   launcher 会把数据改放 {app}\data，而 {app} 在卸载时会被清理 → 用户数据随卸载丢失
Source: "installer\payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: "portable.flag"

[Icons]
; 开始菜单 + 桌面快捷方式 → 启动器（cmd 壳：双击即开服务+浏览器）
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载{#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: checkedonce

[Run]
; 安装完成可选立即启动
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前停止服务进程（按 pid 文件；数据保留）
Filename: "{app}\node\node.exe"; Parameters: """{app}\tools\uninstall-stop.cjs"""; Flags: runhidden waituntilterminated; RunOnceId: "StopServer"

[UninstallDelete]
; 仅清理安装目录内可能生成的运行期产物；%APPDATA%\orange-jxc 数据目录保留
Type: filesandordirs; Name: "{app}\.tools"
Type: files; Name: "{app}\data\*.pid"
