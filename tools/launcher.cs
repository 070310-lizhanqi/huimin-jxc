// ============================================================
// 橙子进销存 —— 原生无窗口启动器（C# / .NET Framework，Windows 自带 csc 编译）
//
// 为什么需要它：
//   原先的入口是「橙子进销存.cmd」，带来三个问题——
//   1) 双击必弹一个黑色终端窗口（用户最反感）
//   2) 快捷方式图标取不到 .ico，只能显示 cmd 的默认图标（像病毒）
//   3) 任务管理器里是一堆 cmd.exe 子进程
//   本启动器编译为 /target:winexe（无控制台子系统），图标直接嵌在 exe 上：
//   双击后无窗口、无闪烁，只留后台进程。
//
// 它做什么：
//   找到同目录的 node.exe 与 launcher.cjs，以「无窗口 + 脱离会话」方式拉起服务，
//   自身随即退出（服务由 launcher.cjs 常驻守护，它负责「探测就绪 → 打开浏览器」）。
//
// 编译（tools/dist-win.cjs 自动执行，也可手工）：
//   csc.exe -nologo -target:winexe -win32icon:assets\icon-app.ico
//            -out:橙子进销存.exe tools\launcher.cs
// 注意：Git Bash 会把 /xxx 形式参数误当路径转换，用 -xxx 形式。
// ============================================================
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

class Launcher
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }

    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint DETACHED_PROCESS = 0x00000008;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint OPEN_EXISTING = 3;
    const uint NUL_DEVICE = 0x00000004;

    static string AppDir
    {
        get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }
    }

    static int Main(string[] args)
    {
        string dir = AppDir;
        string node = Path.Combine(dir, "node", "node.exe");
        string script = Path.Combine(dir, "launcher.cjs");

        if (!File.Exists(node))
        {
            ShowError("找不到内置运行时：\r\n" + node + "\r\n\r\n安装可能不完整，建议重新安装。");
            return 2;
        }
        if (!File.Exists(script))
        {
            ShowError("找不到启动脚本：\r\n" + script + "\r\n\r\n安装可能不完整，建议重新安装。");
            return 3;
        }

        // 标准句柄全部指向 NUL：进程无控制台，若不重定向，
        // launcher.cjs 里的 console.log 可能因无效句柄抛错。
        IntPtr nulIn = CreateFile("NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        IntPtr nulOut = CreateFile("NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = nulIn;
        si.hStdOutput = nulOut;
        si.hStdError = nulOut;

        PROCESS_INFORMATION pi;
        string cmdLine = "\"" + node + "\" \"" + script + "\"";

        bool ok = CreateProcess(node, cmdLine, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NO_WINDOW | DETACHED_PROCESS, IntPtr.Zero, dir, ref si, out pi);

        if (nulIn != IntPtr.Zero) CloseHandle(nulIn);
        if (nulOut != IntPtr.Zero) CloseHandle(nulOut);

        if (!ok)
        {
            ShowError("启动服务失败（错误码 " + Marshal.GetLastWin32Error() + "）。");
            return 4;
        }

        // 不等待：launcher.cjs 内部负责「探测就绪 → 打开浏览器 → 守护进程」
        return 0;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    static void ShowError(string text)
    {
        // 仅在真正出错时才弹窗（这条路径允许有窗口，其余全程无窗口）
        try { MessageBox(IntPtr.Zero, text, "橙子进销存", 0x10 /* MB_ICONERROR */); }
        catch { }
    }
}
