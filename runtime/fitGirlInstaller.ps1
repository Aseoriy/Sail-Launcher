param([string]$ConfigBase64 = '')

$ErrorActionPreference = 'Stop'

$configuredChild = -not [string]::IsNullOrWhiteSpace($ConfigBase64)
if ($configuredChild) {
    try {
        $configJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64))
        $config = $configJson | ConvertFrom-Json
        $installer = [string]$config.installer
        $target = [string]$config.target
        $innoArgs = [string]$config.innoArgs
        $skipExtras = [bool]$config.skipExtras
        $statusFile = [string]$config.statusFile
        $muteFlag = [string]$config.muteFlag
        $innoLog = [string]$config.innoLog
    } catch {
        Write-Host ('LAUNCH_FAIL elevated configuration could not be decoded: ' + $_.Exception.Message)
        exit 3
    }
} else {
    $installer = $env:SAIL_INSTALLER
    $target = $env:SAIL_TARGET
    $innoArgs = $env:SAIL_ARGS
    $skipExtras = $env:SAIL_SKIP_REDIST -eq '1'
    $statusFile = $env:SAIL_STATUS_FILE
    $muteFlag = $env:SAIL_MUTE_FLAG
    $innoLog = $env:SAIL_INNO_LOG
}

function Write-Status([string]$Text) {
    try {
        if (-not [string]::IsNullOrWhiteSpace($statusFile)) {
            Add-Content -LiteralPath $statusFile -Value $Text -Encoding UTF8
        }
    } catch {}
}

if ([string]::IsNullOrWhiteSpace($installer) -or -not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    $missingInstaller = 'LAUNCH_FAIL installer not found: ' + $installer
    Write-Status $missingInstaller
    Write-Host $missingInstaller
    exit 2
}

# Keep the launch checkpoint in the unelevated wrapper. Only after the main process
# persists the job state do we ask for one UAC prompt and rerun this exact script as
# administrator. The elevated copy owns and observes the entire installer process tree.
if (-not $configuredChild -and $env:SAIL_ELEVATED -ne '1') {
    Write-Host 'READY_TO_LAUNCH'
    while (-not (Test-Path -LiteralPath $env:SAIL_LAUNCH_GATE)) {
        Start-Sleep -Milliseconds 50
    }

    $quotedScript = '"' + $PSCommandPath + '"'
    $elevatedConfig = [ordered]@{
        installer = $installer
        target = $target
        innoArgs = $innoArgs
        skipExtras = $skipExtras
        statusFile = $statusFile
        muteFlag = $muteFlag
        innoLog = $innoLog
    }
    $encodedConfig = [Convert]::ToBase64String(
        [System.Text.Encoding]::UTF8.GetBytes(($elevatedConfig | ConvertTo-Json -Compress))
    )
    try {
        $elevated = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $quotedScript, '-ConfigBase64', $encodedConfig) `
            -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    } catch {
        Write-Host ('LAUNCH_FAIL ' + $_.Exception.Message)
        exit 1223
    }

    try {
        if (Test-Path -LiteralPath $statusFile) {
            Get-Content -LiteralPath $statusFile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        }
    } catch {}
    if ($null -eq $elevated) { exit 3 }
    exit ([int]$elevated.ExitCode)
}

try {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport]
interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int df, int sm, out IntPtr p);
    void GetDefaultAudioEndpoint(int df, int role, out IMMDevice d);
    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice d);
    void RegisterEndpointNotificationCallback(IntPtr p);
    void UnregisterEndpointNotificationCallback(IntPtr p);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport]
interface IMMDevice {
    void Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    void OpenPropertyStore(uint a, [MarshalAs(UnmanagedType.Interface)] out object o);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetState(out uint s);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport]
interface IAudioSessionManager2 {
    int NotImpl0();
    int NotImpl1();
    void GetSessionEnumerator(out IAudioSessionEnumerator e);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport]
interface IAudioSessionEnumerator {
    void GetCount(out int c);
    void GetSession(int i, out IAudioSessionControl s);
}

[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport]
interface IAudioSessionControl {
    int N0(); int N1(); int N2(); int N3(); int N4();
    int N5(); int N6(); int N7(); int N8();
}

[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport]
interface IAudioSessionControl2 {
    int C0(); int C1(); int C2(); int C3(); int C4();
    int C5(); int C6(); int C7(); int C8();
    int GetSessionIdentifier(out IntPtr s);
    int GetSessionInstanceIdentifier(out IntPtr s);
    int GetProcessId(out uint pid);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[ComImport]
interface ISimpleAudioVolume {
    void SetMasterVolume(float l, ref Guid g);
    void GetMasterVolume(out float l);
    void SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);
    void GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MDE {}

public class AppMuter {
    static IAudioSessionEnumerator Sessions() {
        var e = (IMMDeviceEnumerator)(new MDE());
        IMMDevice d;
        e.GetDefaultAudioEndpoint(0, 1, out d);
        var iid = typeof(IAudioSessionManager2).GUID;
        object o;
        d.Activate(ref iid, 23, IntPtr.Zero, out o);
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator se;
        mgr.GetSessionEnumerator(out se);
        return se;
    }

    public static int SetMute(uint[] pids, bool state) {
        var set = new HashSet<uint>(pids);
        int n = 0;
        IAudioSessionEnumerator se;
        try { se = Sessions(); } catch { return 0; }
        int c;
        se.GetCount(out c);
        for (int i = 0; i < c; i++) {
            IAudioSessionControl ctl;
            try { se.GetSession(i, out ctl); } catch { continue; }
            try {
                var ctl2 = (IAudioSessionControl2)ctl;
                uint pid;
                ctl2.GetProcessId(out pid);
                if (set.Contains(pid)) {
                    var volume = (ISimpleAudioVolume)ctl;
                    var context = Guid.Empty;
                    volume.SetMute(state, ref context);
                    n++;
                }
            } catch {}
        }
        return n;
    }
}

public class InstallWindow {
    public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    static void AppendText(IntPtr hwnd, StringBuilder output) {
        var text = new StringBuilder(2048);
        if (GetWindowText(hwnd, text, text.Capacity) > 0) output.AppendLine(text.ToString());
    }

    public static string Text(uint processId) {
        var output = new StringBuilder();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId) return true;
            AppendText(hwnd, output);
            EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr childIgnored) {
                AppendText(child, output);
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        return output.ToString();
    }

    public static int Close(uint processId) {
        int count = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == processId) {
                PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
                count++;
            }
            return true;
        }, IntPtr.Zero);
        return count;
    }
}
"@
} catch {
    Write-Status ('POLICY_WARNING native helpers unavailable: ' + $_.Exception.Message)
    if ($skipExtras) { exit 3 }
}

function Get-FolderSize([string]$Path) {
    try {
        return [double]((Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum)
    } catch { return [double]0 }
}

function Get-ProcessStamp($ProcessRow) {
    try { return ([datetime]$ProcessRow.CreationDate).ToUniversalTime().Ticks.ToString() }
    catch { return [string]$ProcessRow.CreationDate }
}

function Test-PathUnder([string]$Candidate, [string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    try {
        $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
        $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
        return $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
            $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Test-OwnedPayloadPath($ProcessRow) {
    $executable = [string]$ProcessRow.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($executable)) { return $false }
    if ((Test-PathUnder $executable $target) -or (Test-PathUnder $executable $script:installerDir)) { return $true }
    if (Test-PathUnder $executable $script:tempRoot) {
        try {
            $relative = [System.IO.Path]::GetFullPath($executable).Substring($script:tempRoot.Length).TrimStart('\')
            return $relative -match '(?i)^(?:is-[^\\]+\.tmp|IXP[^\\]+\.TMP)\\'
        } catch { return $false }
    }
    return $false
}

function Read-EncodedFile([string]$Path) {
    [byte[]]$bytes = [System.IO.File]::ReadAllBytes($Path)
    $offset = 0
    [byte[]]$preamble = @()
    $encoding = [System.Text.Encoding]::Default
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $encoding = New-Object System.Text.UTF8Encoding($true)
        $offset = 3
        $preamble = [byte[]](0xEF, 0xBB, 0xBF)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        $encoding = [System.Text.Encoding]::Unicode
        $offset = 2
        $preamble = [byte[]](0xFF, 0xFE)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
        $encoding = [System.Text.Encoding]::BigEndianUnicode
        $offset = 2
        $preamble = [byte[]](0xFE, 0xFF)
    }
    $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
    return [PSCustomObject]@{ Text = $text; Encoding = $encoding; Preamble = $preamble }
}

function Write-EncodedFile([string]$Path, $State, [string]$Text) {
    [byte[]]$body = $State.Encoding.GetBytes($Text)
    [byte[]]$all = New-Object byte[] ($State.Preamble.Length + $body.Length)
    if ($State.Preamble.Length -gt 0) { [Array]::Copy($State.Preamble, 0, $all, 0, $State.Preamble.Length) }
    [Array]::Copy($body, 0, $all, $State.Preamble.Length, $body.Length)
    [System.IO.File]::WriteAllBytes($Path, $all)
}

function Restore-NewFitGirlHostsEntries {
    if (-not $skipExtras -or $null -eq $script:hostsSnapshot) { return }
    try {
        $current = Read-EncodedFile $script:hostsPath
        $separator = if ($current.Text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $hadTrailingNewline = $current.Text.EndsWith("`n") -or $current.Text.EndsWith("`r")
        $kept = New-Object System.Collections.Generic.List[string]
        $changed = $false
        foreach ($line in [regex]::Split($current.Text, "`r`n|`n|`r")) {
            $newFitGirlRule = -not $script:hostsBefore.ContainsKey($line) -and
                $line -match '(?i)\bfitgirl(?:-repacks?|repacks?)?(?:\.[a-z0-9-]+)+\b'
            if ($newFitGirlRule) {
                $changed = $true
                Write-Status ('SKIP hosts-entry ' + $line.Trim())
            } else {
                [void]$kept.Add($line)
            }
        }
        if ($changed) {
            $rewritten = [string]::Join($separator, $kept.ToArray())
            if ($hadTrailingNewline -and -not $rewritten.EndsWith($separator)) { $rewritten += $separator }
            Write-EncodedFile $script:hostsPath $current $rewritten
        }
    } catch {
        Write-Status ('POLICY_WARNING hosts restore failed: ' + $_.Exception.Message)
    }
}

function Stop-OwnedProcess($ProcessRow, [string]$Reason) {
    $pidValue = [int]$ProcessRow.ProcessId
    if ($pidValue -le 0 -or -not $script:owned.ContainsKey($pidValue)) { return }
    Write-Status ('SKIP ' + $Reason + ' pid=' + $pidValue + ' name=' + [string]$ProcessRow.Name)
    try { [void][InstallWindow]::Close([uint32]$pidValue) } catch {}
    Start-Sleep -Milliseconds 350
    try {
        if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
            Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Apply-SkipPolicy($ProcessRows) {
    if (-not $skipExtras) { return }
    foreach ($row in @($ProcessRows)) {
        $pidValue = [int]$row.ProcessId
        if ($pidValue -eq $script:rootPid) { continue }
        $name = [System.IO.Path]::GetFileName([string]$row.Name)
        $windowText = ''

        if ($name -match '(?i)^(?:dxsetup|dxwebsetup|vc_redist(?:\.[a-z0-9_-]+)?|vcredist[a-z0-9_.-]*)\.exe$' -and
            (Test-OwnedPayloadPath $row)) {
            Stop-OwnedProcess $row 'prerequisite'
            continue
        }

        if ($name -ieq 'cmd.exe') {
            try { $windowText = [InstallWindow]::Text([uint32]$pidValue) } catch {}
            $command = [string]$row.CommandLine
            if ($windowText -match '(?i)Applying redirection rules for fake FitGirl sites' -or
                $command -match '(?i)fg-optional-fake-site-redirect') {
                Stop-OwnedProcess $row 'fake-site-redirect'
                Restore-NewFitGirlHostsEntries
                continue
            }
        }

        if ($name -match '(?i)^(?:quicksfv|sfv)\.exe$' -and (Test-OwnedPayloadPath $row)) {
            if ([string]::IsNullOrWhiteSpace($windowText)) {
                try { $windowText = [InstallWindow]::Text([uint32]$pidValue) } catch {}
            }
            $finished = $windowText -match '(?i)\bFinished\b'
            $clean = $windowText -match '(?i)All files OK' -or
                ($windowText -match '(?i)Bad:\s*0' -and $windowText -match '(?i)Missing:\s*0')
            if ($finished -and $clean) {
                Stop-OwnedProcess $row 'completed-integrity-check'
            } elseif ($finished) {
                Write-Status ('INTEGRITY_REQUIRES_ATTENTION pid=' + $pidValue)
            }
        }
    }
}

$script:installerDir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($installer))
$script:tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$script:hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$script:hostsSnapshot = $null
$script:hostsBefore = @{}
if ($skipExtras) {
    try {
        $script:hostsSnapshot = Read-EncodedFile $script:hostsPath
        foreach ($line in [regex]::Split($script:hostsSnapshot.Text, "`r`n|`n|`r")) {
            $script:hostsBefore[$line] = $true
        }
    } catch {
        Write-Status ('POLICY_WARNING hosts snapshot failed: ' + $_.Exception.Message)
    }
}

$script:owned = @{}
$script:rootPid = 0
$launchUtc = [datetime]::UtcNow.AddSeconds(-2)

function Update-OwnedProcesses {
    $rows = @()
    try { $rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) } catch { return @() }
    $byPid = @{}
    foreach ($row in $rows) { $byPid[[int]$row.ProcessId] = $row }

    if ($script:rootPid -gt 0 -and $byPid.ContainsKey($script:rootPid) -and -not $script:owned.ContainsKey($script:rootPid)) {
        $script:owned[$script:rootPid] = Get-ProcessStamp $byPid[$script:rootPid]
    }

    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($row in $rows) {
            $pidValue = [int]$row.ProcessId
            $parent = [int]$row.ParentProcessId
            if ($pidValue -le 0 -or $script:owned.ContainsKey($pidValue) -or -not $script:owned.ContainsKey($parent)) { continue }
            try {
                if (([datetime]$row.CreationDate).ToUniversalTime() -lt $launchUtc) { continue }
            } catch { continue }
            $script:owned[$pidValue] = Get-ProcessStamp $row
            $changed = $true
        }
    }

    $active = New-Object System.Collections.Generic.List[object]
    foreach ($row in $rows) {
        $pidValue = [int]$row.ProcessId
        if ($script:owned.ContainsKey($pidValue) -and $script:owned[$pidValue] -eq (Get-ProcessStamp $row)) {
            [void]$active.Add($row)
        }
    }
    return $active.ToArray()
}

$proc = $null
$exitCode = 0
try {
    Write-Status ('LAUNCH installer=' + $installer + ' target=' + $target + ' skipExtras=' + $skipExtras)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $installer
    $psi.Arguments = $innoArgs + ' "/DIR=' + $target + '" "/LOG=' + $innoLog + '"'
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $script:installerDir
    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $proc) { throw 'Installer process did not start.' }
    $script:rootPid = [int]$proc.Id
    Write-Status ('ROOT=' + $script:rootPid)

    $startSize = Get-FolderSize $target
    $seen = $false
    for ($grace = 0; $grace -lt 60; $grace++) {
        $active = @(Update-OwnedProcesses)
        if ($active.Count -gt 0) { $seen = $true; break }
        if (((Get-FolderSize $target) - $startSize) -gt 2MB) { $seen = $true; break }
        Start-Sleep -Milliseconds 500
    }
    Write-Status ('PHASE1 seen=' + $seen)

    $lastSize = Get-FolderSize $target
    $idle = 0
    for ($loop = 0; $loop -lt 10800; $loop++) {
        $active = @(Update-OwnedProcesses)
        Apply-SkipPolicy $active
        $active = @(Update-OwnedProcesses)

        if ($active.Count -gt 0) {
            $seen = $true
            $idle = 0
            $ids = New-Object System.Collections.Generic.List[uint32]
            foreach ($row in $active) { try { [void]$ids.Add([uint32]$row.ProcessId) } catch {} }
            $muteState = $true
            try {
                if ((Get-Content -LiteralPath $muteFlag -ErrorAction SilentlyContinue) -eq '0') { $muteState = $false }
            } catch {}
            try { [void][AppMuter]::SetMute($ids.ToArray(), $muteState) } catch {}
        } elseif (($loop % 4) -eq 0) {
            $size = Get-FolderSize $target
            if (($size - $lastSize) -gt 1MB) { $idle = 0 } else { $idle++ }
            $lastSize = $size
        }

        if ($skipExtras -and ($loop % 4) -eq 0) { Restore-NewFitGirlHostsEntries }
        $neededIdleChecks = if ($seen) { 3 } else { 4 }
        if ($idle -ge $neededIdleChecks) { break }
        Start-Sleep -Milliseconds 500
    }

    try {
        if ($proc.HasExited) { $exitCode = [int]$proc.ExitCode }
        else {
            $proc.WaitForExit()
            $exitCode = [int]$proc.ExitCode
        }
    } catch { $exitCode = 3 }
    Write-Status ('DONE size=' + $lastSize + ' exit=' + $exitCode)
} catch {
    Write-Status ('LAUNCH_FAIL ' + $_.Exception.Message)
    $exitCode = 3
} finally {
    Restore-NewFitGirlHostsEntries
}

exit $exitCode
