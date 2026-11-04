# SPDX-License-Identifier: MPL-2.0
param([Parameter(Mandatory=$true)][string]$Bun, [Parameter(Mandatory=$true)][string]$Fixture, [Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'))

# Win32 visibility tests the WS_VISIBLE state, not whether a human is logged in
# or whether the runner's desktop is foreground. No desktop/input automation.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ConsoleProofJob : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcesses;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
        public uint size, usage, pid; public UIntPtr heap;
        public uint module, threads, parent; public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);

    IntPtr job, process;
    public uint Pid { get; private set; }
    public uint ExitCode {
        get {
            uint code;
            if (!GetExitCodeProcess(process, out code)) throw Error("GetExitCodeProcess");
            return code;
        }
    }
    static Exception Error(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    public ConsoleProofJob(string bun, string fixture, string root) {
        job = CreateJobObject(IntPtr.Zero, null); // Unnamed, non-inheritable, unique to this run.
        if (job == IntPtr.Zero) throw Error("CreateJobObject");
        try {
            var limits = new ExtendedLimits();
            limits.basic.flags = 0x2008; // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS_LIMIT.
            limits.basic.activeProcesses = 16;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw Error("SetInformationJobObject");
            var startup = new StartupInfo(); startup.cb = (uint)Marshal.SizeOf(startup);
            ProcessInfo info;
            // All three arguments are absolute file/directory paths (no trailing slash).
            var command = new StringBuilder("\"" + bun + "\" \"" + fixture + "\" \"" + root + "\"");
            // DETACHED_PROCESS | CREATE_SUSPENDED: no inherited or newly allocated console.
            if (!CreateProcess(bun, command, IntPtr.Zero, IntPtr.Zero, false, 0xC, IntPtr.Zero, root, ref startup, out info)) throw Error("CreateProcess");
            process = info.process; Pid = info.pid;
            try {
                // Assign before any JS can run, so every descendant is contained.
                if (!AssignProcessToJobObject(job, process)) throw Error("AssignProcessToJobObject (nested jobs required)");
                if (ResumeThread(info.thread) == uint.MaxValue) throw Error("ResumeThread");
            } catch { TerminateProcess(process, 1); throw; }
            finally { CloseHandle(info.thread); }
        } catch { Dispose(); throw; }
    }
    public bool Wait(uint milliseconds) {
        uint result = WaitForSingleObject(process, milliseconds);
        if (result == uint.MaxValue) throw Error("WaitForSingleObject");
        return result == 0;
    }
    public uint[] Children() {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw Error("CreateToolhelp32Snapshot");
        try {
            var children = new List<uint>();
            var entry = new ProcessEntry(); entry.size = (uint)Marshal.SizeOf(entry);
            if (!Process32First(snapshot, ref entry)) throw Error("Process32First");
            do { if (entry.parent == Pid) children.Add(entry.pid); } while (Process32Next(snapshot, ref entry));
            if (Marshal.GetLastWin32Error() != 18) throw Error("Process32Next");
            return children.ToArray();
        } finally { CloseHandle(snapshot); }
    }
    public sealed class Observation {
        public uint pid; public bool attached, visible; public string window; public int error;
    }
    public Observation Inspect(uint pid) {
        // Hold an exact process handle and reject nonmembers/dead processes before
        // attaching. PID enumeration never authorizes touching an unrelated process.
        IntPtr target = OpenProcess(0x101000, false, pid); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE.
        if (target == IntPtr.Zero) throw Error("OpenProcess");
        try {
            bool member;
            if (!IsProcessInJob(target, job, out member)) throw Error("IsProcessInJob");
            if (!member || WaitForSingleObject(target, 0) != 258) throw new Exception("Probe target is not a live member of the fixture job");
            FreeConsole();
            var observation = new Observation(); observation.pid = pid;
            observation.attached = AttachConsole(pid);
            observation.error = observation.attached ? 0 : Marshal.GetLastWin32Error();
            if (!observation.attached && observation.error != 6) throw new Win32Exception(observation.error, "AttachConsole failed for owned fixture");
            try {
                IntPtr window = observation.attached ? GetConsoleWindow() : IntPtr.Zero;
                observation.window = window.ToInt64().ToString();
                observation.visible = window != IntPtr.Zero && IsWindowVisible(window);
                return observation;
            } finally { if (observation.attached) FreeConsole(); }
        } finally { CloseHandle(target); }
    }
    public void Dispose() {
        if (job != IntPtr.Zero) {
            TerminateJobObject(job, 1);
            CloseHandle(job); job = IntPtr.Zero;
        }
        if (process != IntPtr.Zero) {
            WaitForSingleObject(process, 5000);
            CloseHandle(process); process = IntPtr.Zero;
        }
    }
}
'@

$owner = [ConsoleProofJob]::new($Bun, $Fixture, $Root)
try {
    $readyPath = [IO.Path]::Combine($Root, 'ready.json')
    $failurePath = [IO.Path]::Combine($Root, 'failure.txt')
    $deadline = [DateTime]::UtcNow.AddSeconds(55)
    while (-not [IO.File]::Exists($readyPath)) {
        if ([IO.File]::Exists($failurePath)) { throw [IO.File]::ReadAllText($failurePath) }
        if ($owner.Wait(50)) { throw 'Detached runtime fixture exited before its real native read completed' }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Detached runtime fixture did not become ready within 55 seconds' }
    }
    $ready = [IO.File]::ReadAllText($readyPath) | ConvertFrom-Json
    if ($ready.parentPid -ne $owner.Pid -or $ready.completedRead -ne $true) { throw 'Invalid owned fixture readiness receipt' }
    $children = @($owner.Children())
    if ($children -notcontains [uint32]$ready.controlPid) { throw 'Positive-control process is not a child of the owned detached parent' }
    $workers = @($children | Where-Object { $_ -ne [uint32]$ready.controlPid })
    if ($workers.Count -ne 1) { throw "Expected one native worker beside the control; found $($workers.Count) direct children" }
    $parent = $owner.Inspect($owner.Pid)
    $control = $owner.Inspect([uint32]$ready.controlPid)
    if (-not $control.attached -or -not $control.visible) {
        throw "Console visibility cannot be established on this Windows session: explicit visible control yielded $($control | ConvertTo-Json -Compress). This is an unsupported probe environment, NOT a passing regression."
    }
    $worker = $owner.Inspect([uint32]$workers[0])
    [IO.File]::WriteAllText([IO.Path]::Combine($Root, 'stop'), '')
    if (-not $owner.Wait(20000)) { throw 'Detached runtime fixture did not finish bounded native cleanup' }
    if ([IO.File]::Exists($failurePath)) { throw [IO.File]::ReadAllText($failurePath) }
    if ($owner.ExitCode -ne 0) { throw "Detached runtime fixture exited unsuccessfully: $($owner.ExitCode)" }
    @{ parent = $parent; control = $control; worker = $worker; completedRead = $true } | ConvertTo-Json -Depth 4 -Compress
} finally {
    # Kill-on-close also applies when the outer execFile timeout terminates this
    # PowerShell process. No taskkill/name matching, user workers, or global jobs.
    $owner.Dispose()
}
