// Host / injector entry point for the PageSignal native agent.
//
// Modes:
//   PageSignalAgentHost.exe                 - runs the agent in this process (foreground).
//   PageSignalAgentHost.exe run             - same as above.
//   PageSignalAgentHost.exe inject <pid> [<dll-path>]
//                                           - injects the supplied DLL into the target
//                                             process via CreateRemoteThread+LoadLibraryW.
//                                             Defaults to the bootstrap shim next to this EXE.
//
// The architecture-specific native bootstrap hosts .NET Framework CLR v4 and calls
// PageSignal.NativeAgent.Agent.StartBackgroundFromBootstrap(). Keep the host,
// managed agent, and both bootstrap DLLs together in the portable dist folder.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PageSignal.NativeAgent.Host
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            try
            {
                // Best-effort: enable SeDebugPrivilege so we can OpenProcess on elevated
                // / cross-session targets when running under an elevated/admin token.
                TryEnableDebugPrivilege();

                if (args == null || args.Length == 0 || string.Equals(args[0], "run", StringComparison.OrdinalIgnoreCase))
                {
                    return RunInProcess();
                }
                if (string.Equals(args[0], "inject", StringComparison.OrdinalIgnoreCase))
                {
                    if (args.Length < 2)
                    {
                        Console.Error.WriteLine("Usage: PageSignalAgentHost.exe inject <pid|name|name.exe> [<dll-path>] [--all] [--wait[=seconds]]");
                        return 2;
                    }
                    string target = args[1];
                    string dll = null;
                    bool injectAll = false;
                    int waitSeconds = 0;
                    for (int i = 2; i < args.Length; i++)
                    {
                        string a = args[i];
                        if (string.Equals(a, "--all", StringComparison.OrdinalIgnoreCase)) { injectAll = true; continue; }
                        if (a.StartsWith("--wait", StringComparison.OrdinalIgnoreCase))
                        {
                            int eq = a.IndexOf('=');
                            int s = 60;
                            if (eq > 0) int.TryParse(a.Substring(eq + 1), out s);
                            waitSeconds = s > 0 ? s : 60;
                            continue;
                        }
                        if (dll == null) { dll = Path.GetFullPath(a); continue; }
                        Console.Error.WriteLine("Unexpected argument: " + a);
                        return 2;
                    }
                    int[] pids = ResolveTargets(target, injectAll, waitSeconds);
                    if (pids.Length == 0)
                    {
                        Console.Error.WriteLine("No matching process for target: " + target);
                        return 4;
                    }

                    int failures = 0;
                    foreach (int pid in pids)
                    {
                        int rc = Inject(pid, dll);
                        if (rc != 0) failures++;
                    }
                    return failures == 0 ? 0 : 11;
                }
                if (string.Equals(args[0], "ui", StringComparison.OrdinalIgnoreCase))
                {
                    return LaunchInjectorUi();
                }
                if (string.Equals(args[0], "list", StringComparison.OrdinalIgnoreCase))
                {
                    string filter = args.Length > 1 ? args[1] : null;
                    foreach (var proc in EnumProcesses(filter))
                        Console.WriteLine(proc.Id.ToString().PadLeft(6) + "  " + SafeArch(proc) + "  " + proc.ProcessName);
                    return 0;
                }
                if (string.Equals(args[0], "help", StringComparison.OrdinalIgnoreCase) || args[0] == "-h" || args[0] == "--help")
                {
                    PrintHelp();
                    return 0;
                }
                Console.Error.WriteLine("Unknown command: " + args[0]);
                PrintHelp();
                return 2;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Fatal: " + ex);
                return 1;
            }
        }

        private static void PrintHelp()
        {
            Console.WriteLine("PageSignal native agent host");
            Console.WriteLine("  run                                          Run the agent in this process (default).");
            Console.WriteLine("  ui                                           Open the graphical process injector.");
            Console.WriteLine("  list [<name-substring>]                      List running processes (filtered).");
            Console.WriteLine("  inject <pid|name|name.exe> [<dll-path>]");
            Console.WriteLine("           [--all] [--wait[=seconds]]          Inject DLL into target process(es).");
            Console.WriteLine();
            Console.WriteLine("Examples:");
            Console.WriteLine("  PageSignalAgentHost.exe inject notepad.exe");
            Console.WriteLine("  PageSignalAgentHost.exe inject 12345 .\\dist\\PageSignalBootstrap.x64.dll");
            Console.WriteLine("  PageSignalAgentHost.exe inject chrome --all");
            Console.WriteLine("  PageSignalAgentHost.exe inject MyGame.exe --wait=30");
        }

        private static int LaunchInjectorUi()
        {
            string here = Path.GetDirectoryName(typeof(Program).Assembly.Location);
            string uiPath = Path.Combine(here, "PageSignalInjector.exe");
            if (!File.Exists(uiPath))
            {
                Console.Error.WriteLine("PageSignalInjector.exe was not found next to the host executable.");
                return 3;
            }
            Process.Start(new ProcessStartInfo(uiPath) { UseShellExecute = true, WorkingDirectory = here });
            return 0;
        }

        // ----------------- in-process mode -----------------
        private static int RunInProcess()
        {
            Console.WriteLine("[PageSignal] starting native agent in-process...");
            var stop = new ManualResetEventSlim(false);
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; Agent.Stop(); stop.Set(); };
            Agent.StartBackground();
            stop.Wait();
            return 0;
        }

        // ----------------- remote injection -----------------
        private const uint PROCESS_CREATE_THREAD = 0x0002;
        private const uint PROCESS_VM_OPERATION = 0x0008;
        private const uint PROCESS_VM_READ = 0x0010;
        private const uint PROCESS_VM_WRITE = 0x0020;
        private const uint PROCESS_QUERY_INFORMATION = 0x0400;
        private const uint PROCESS_INJECTION_ACCESS = PROCESS_CREATE_THREAD
            | PROCESS_VM_OPERATION
            | PROCESS_VM_READ
            | PROCESS_VM_WRITE
            | PROCESS_QUERY_INFORMATION;
        private const uint MEM_COMMIT = 0x1000;
        private const uint MEM_RESERVE = 0x2000;
        private const uint MEM_RELEASE = 0x8000;
        private const uint PAGE_READWRITE = 0x04;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, uint dwSize, uint flAllocationType, uint flProtect);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, uint dwSize, uint dwFreeType);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, uint nSize, out UIntPtr lpNumberOfBytesWritten);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateRemoteThread(IntPtr hProcess, IntPtr lpThreadAttributes, uint dwStackSize, IntPtr lpStartAddress, IntPtr lpParameter, uint dwCreationFlags, IntPtr lpThreadId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
        private static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("kernel32.dll")]
        private static extern bool GetExitCodeThread(IntPtr hThread, out uint lpExitCode);

        private static int Inject(int pid, string dllPath)
        {
            IntPtr hProc = OpenProcess(PROCESS_INJECTION_ACCESS, false, pid);
            if (hProc == IntPtr.Zero)
            {
                Console.Error.WriteLine("OpenProcess failed (pid " + pid + "): " + Marshal.GetLastWin32Error()
                    + " — try running as Administrator.");
                return 5;
            }
            try
            {
                // Architecture sanity check: x86 host can't inject into x64 target and vice-versa.
                bool targetIsWow64 = IsTargetWow64(hProc);
                bool hostIsX64 = IntPtr.Size == 8;
                // On a 64-bit OS, a non-Wow64 process is x64; on a 32-bit OS every process is x86.
                bool targetIsX64 = Environment.Is64BitOperatingSystem && !targetIsWow64;
                if (string.IsNullOrEmpty(dllPath))
                    dllPath = DefaultBootstrapPath(targetIsX64);
                Console.WriteLine("[PageSignal] injecting " + dllPath + " -> pid " + pid);
                if (!File.Exists(dllPath))
                {
                    Console.Error.WriteLine("DLL not found: " + dllPath);
                    return 4;
                }
                if (targetIsX64 != hostIsX64)
                {
                    // Try to relay to the sibling-bitness host EXE shipped next to this one.
                    int relayed;
                    if (TryRelayToSiblingHost(pid, dllPath, targetIsX64, out relayed))
                        return relayed;

                    Console.Error.WriteLine(
                        "Architecture mismatch: host is " + (hostIsX64 ? "x64" : "x86")
                        + " but target pid " + pid + " is " + (targetIsX64 ? "x64" : "x86")
                        + ". Run the matching host EXE (PageSignalAgentHost.exe for x64, "
                        + "PageSignalAgentHost.x86.exe for x86) or rebuild with the matching /platform.");
                    return 12;
                }

                IntPtr loadLibrary = GetProcAddress(GetModuleHandle("kernel32.dll"), "LoadLibraryW");
                if (loadLibrary == IntPtr.Zero)
                {
                    Console.Error.WriteLine("Could not resolve LoadLibraryW.");
                    return 6;
                }

                byte[] pathBytes = Encoding.Unicode.GetBytes(dllPath + "\0");
                IntPtr remoteMem = VirtualAllocEx(hProc, IntPtr.Zero, (uint)pathBytes.Length,
                    MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
                if (remoteMem == IntPtr.Zero)
                {
                    Console.Error.WriteLine("VirtualAllocEx failed: " + Marshal.GetLastWin32Error());
                    return 7;
                }
                try
                {
                    UIntPtr written;
                    if (!WriteProcessMemory(hProc, remoteMem, pathBytes, (uint)pathBytes.Length, out written))
                    {
                        Console.Error.WriteLine("WriteProcessMemory failed: " + Marshal.GetLastWin32Error());
                        return 8;
                    }

                    IntPtr hThread = CreateRemoteThread(hProc, IntPtr.Zero, 0, loadLibrary, remoteMem, 0, IntPtr.Zero);
                    if (hThread == IntPtr.Zero)
                    {
                        Console.Error.WriteLine("CreateRemoteThread failed: " + Marshal.GetLastWin32Error());
                        return 9;
                    }
                    try
                    {
                        WaitForSingleObject(hThread, 0xFFFFFFFF);
                        uint exit;
                        GetExitCodeThread(hThread, out exit);
                        if (exit == 0)
                        {
                            Console.Error.WriteLine("Remote LoadLibraryW returned NULL — DLL load failed inside target.");
                            return 10;
                        }
                        Console.WriteLine("[PageSignal] DLL loaded into pid " + pid + " (HMODULE=0x" + exit.ToString("X") + ").");
                        return 0;
                    }
                    finally { CloseHandle(hThread); }
                }
                finally
                {
                    VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
                }
            }
            finally { CloseHandle(hProc); }
        }

        private static string DefaultBootstrapPath(bool targetIsX64)
        {
            string here = Path.GetDirectoryName(typeof(Program).Assembly.Location);
            return Path.Combine(
                here,
                targetIsX64 ? "PageSignalBootstrap.x64.dll" : "PageSignalBootstrap.x86.dll");
        }

        // ----------------- target resolution -----------------

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsWow64Process(IntPtr hProcess, out bool wow64Process);

        private static int[] ResolveTargets(string target, bool injectAll, int waitSeconds)
        {
            int pid;
            if (int.TryParse(target, out pid)) return new[] { pid };

            string name = target;
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                name = name.Substring(0, name.Length - 4);

            DateTime deadline = DateTime.UtcNow.AddSeconds(waitSeconds);
            while (true)
            {
                var procs = Process.GetProcessesByName(name);
                if (procs.Length > 0)
                {
                    if (injectAll)
                    {
                        var all = new int[procs.Length];
                        for (int i = 0; i < procs.Length; i++) all[i] = procs[i].Id;
                        return all;
                    }
                    // pick the most recently started process (best heuristic for "the one I just launched")
                    int bestPid = procs[0].Id;
                    DateTime bestStart = DateTime.MinValue;
                    foreach (var p in procs)
                    {
                        try { if (p.StartTime > bestStart) { bestStart = p.StartTime; bestPid = p.Id; } }
                        catch { /* access denied — skip */ }
                    }
                    return new[] { bestPid };
                }
                if (waitSeconds <= 0 || DateTime.UtcNow >= deadline) return new int[0];
                Console.WriteLine("[PageSignal] waiting for '" + name + "' to start...");
                Thread.Sleep(500);
            }
        }

        private static IEnumerable<Process> EnumProcesses(string filter)
        {
            foreach (var p in Process.GetProcesses())
            {
                if (string.IsNullOrEmpty(filter) ||
                    p.ProcessName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    yield return p;
                }
            }
        }

        private static string SafeArch(Process p)
        {
            try
            {
                bool wow;
                if (IsWow64Process(p.Handle, out wow))
                    return wow ? "x86" : (Environment.Is64BitOperatingSystem ? "x64" : "x86");
            }
            catch { }
            return "??? ";
        }

        private static bool IsTargetWow64(IntPtr hProc)
        {
            bool wow;
            return IsWow64Process(hProc, out wow) && wow;
        }

        // ----------------- arch-mismatch fallback -----------------

        // Re-runs this same command using the sibling-bitness host EXE (PageSignalAgentHost.exe
        // <-> PageSignalAgentHost.x86.exe). Returns true and the child's exit code if the
        // sibling was found and executed; false if no sibling EXE is shipped next to us.
        private static bool TryRelayToSiblingHost(int pid, string dllPath, bool targetIsX64, out int exitCode)
        {
            exitCode = 0;
            try
            {
                string here = Path.GetDirectoryName(typeof(Program).Assembly.Location);
                string sibling = Path.Combine(here, targetIsX64 ? "PageSignalAgentHost.exe" : "PageSignalAgentHost.x86.exe");
                if (!File.Exists(sibling)) return false;

                Console.WriteLine("[PageSignal] target is " + (targetIsX64 ? "x64" : "x86")
                    + "; relaying to sibling host: " + Path.GetFileName(sibling));

                var psi = new ProcessStartInfo(sibling)
                {
                    UseShellExecute = false,
                    CreateNoWindow = false,
                };
                psi.ArgumentList_AddSafe("inject");
                psi.ArgumentList_AddSafe(pid.ToString());
                psi.ArgumentList_AddSafe(dllPath);

                using (var child = Process.Start(psi))
                {
                    if (child == null) return false;
                    child.WaitForExit();
                    exitCode = child.ExitCode;
                    return true;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[PageSignal] sibling-host relay failed: " + ex.Message);
                return false;
            }
        }

        // ----------------- SeDebugPrivilege -----------------

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID { public uint LowPart; public int HighPart; }

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privileges; }

        private const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
        private const uint TOKEN_QUERY = 0x0008;
        private const uint SE_PRIVILEGE_ENABLED = 0x00000002;

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges,
            ref TOKEN_PRIVILEGES NewState, uint BufferLength, IntPtr PreviousState, IntPtr ReturnLength);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        private static void TryEnableDebugPrivilege()
        {
            try
            {
                IntPtr token;
                if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token))
                    return;
                try
                {
                    LUID luid;
                    if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out luid)) return;
                    var tp = new TOKEN_PRIVILEGES
                    {
                        PrivilegeCount = 1,
                        Privileges = new LUID_AND_ATTRIBUTES { Luid = luid, Attributes = SE_PRIVILEGE_ENABLED }
                    };
                    AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
                }
                finally { CloseHandle(token); }
            }
            catch { /* best effort */ }
        }
    }

    // Tiny shim so the relay code reads naturally on .NET Framework (no ProcessStartInfo.ArgumentList).
    internal static class ProcessStartInfoExtensions
    {
        public static void ArgumentList_AddSafe(this ProcessStartInfo psi, string arg)
        {
            if (string.IsNullOrEmpty(psi.Arguments)) psi.Arguments = QuoteIfNeeded(arg);
            else psi.Arguments += " " + QuoteIfNeeded(arg);
        }

        private static string QuoteIfNeeded(string s)
        {
            if (string.IsNullOrEmpty(s)) return "\"\"";
            if (s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
            return "\"" + s.Replace("\"", "\\\"") + "\"";
        }
    }
}
