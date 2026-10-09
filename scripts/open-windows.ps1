# Opens JARVIS across every monitor: the main interface on the primary one and a
# satellite on each of the others, each in its own full-screen app window.
#
# A browser decides for itself where a new window goes, and "the monitor the
# last window was on" is its usual answer - so three windows opened in a row
# land in a pile. This opens each one, finds it by title, moves it onto its
# monitor with the Win32 API and only then asks it to go full screen, which a
# browser does on whichever monitor the window is sitting on.
#
# Run by Jarvis.cmd once the servers are up. Safe to run again: it reuses
# windows that are already open instead of opening duplicates.

param(
  [string]$Url = 'http://localhost:5173',
  # Leave the side monitors alone and open only the main window.
  [switch]$MainOnly
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JarvisWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# Edge first: it is the only browser on Windows with neural Portuguese voices,
# which matter whenever the ElevenLabs voice is not in use.
$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Write-Error 'Neither Edge nor Chrome was found.'; exit 1 }

$screens = [System.Windows.Forms.Screen]::AllScreens
$primary = $screens | Where-Object Primary
$others = @($screens | Where-Object { -not $_.Primary } | Sort-Object { $_.Bounds.X })

# The dashboard goes on the larger of the side monitors when there is a
# choice. Windows are titled by slot (A, B), not by what they show, because
# each can be switched to another view from its own header.
$plan = @(@{ Title = 'J.A.R.V.I.S.'; Path = '/'; Screen = $primary })
# The titles carry a middle dot; spelled as a code point so this file stays
# plain ASCII and reads the same whatever encoding PowerShell assumes.
$dot = [char]0x00B7
if (-not $MainOnly) {
  $kinds = @(
    @{ Title = "J.A.R.V.I.S. $dot A"; Path = '/?sat=telemetry&slot=A' },
    @{ Title = "J.A.R.V.I.S. $dot B"; Path = '/?sat=world&slot=B' }
  )
  $bySize = @($others | Sort-Object { $_.Bounds.Width * $_.Bounds.Height } -Descending)
  for ($i = 0; $i -lt [Math]::Min($bySize.Count, $kinds.Count); $i++) {
    $plan += @{ Title = $kinds[$i].Title; Path = $kinds[$i].Path; Screen = $bySize[$i] }
  }
}

function Wait-Window([string]$title, [int]$seconds = 20) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $h = [JarvisWin]::Find($title)
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 250
  }
  return [IntPtr]::Zero
}

# Is the window already covering its monitor? Then it is full screen and
# pressing F11 again would take it back out.
function Test-Covers($handle, $bounds) {
  $r = New-Object JarvisWin+RECT
  [void][JarvisWin]::GetWindowRect($handle, [ref]$r)
  return ($r.L -le $bounds.X -and $r.T -le $bounds.Y -and
          $r.R -ge $bounds.Right -and $r.B -ge $bounds.Bottom -and
          ($r.R - $r.L) -le ($bounds.Width + 32))
}

foreach ($item in $plan) {
  $b = $item.Screen.Bounds
  $handle = [JarvisWin]::Find($item.Title)
  if ($handle -eq [IntPtr]::Zero) {
    # The position flags are honoured when this starts the browser and ignored
    # when it joins one already running; the move below covers both.
    Start-Process -FilePath $browser -ArgumentList @(
      "--app=$Url$($item.Path)",
      "--window-position=$($b.X + 40),$($b.Y + 40)",
      "--window-size=$([Math]::Min(1200, $b.Width - 80)),$([Math]::Min(760, $b.Height - 80))"
    )
    $handle = Wait-Window $item.Title
  }
  if ($handle -eq [IntPtr]::Zero) {
    Write-Warning "The window '$($item.Title)' did not appear."
    continue
  }
  if (Test-Covers $handle $b) { continue }

  [void][JarvisWin]::ShowWindow($handle, 9)   # restore, in case it was maximised
  [void][JarvisWin]::SetWindowPos($handle, [IntPtr]::Zero, $b.X + 40, $b.Y + 40, $b.Width - 80, $b.Height - 80, 0x0044)
  Start-Sleep -Milliseconds 350

  # F11 goes to whichever window has the keyboard, and Windows refuses to hand
  # the keyboard to a window on the say-so of a background script. Tapping Alt
  # first is the documented way to be allowed to; and because a refusal is
  # silent, check that the window really did fill its monitor and try again.
  for ($try = 0; $try -lt 3 -and -not (Test-Covers $handle $b); $try++) {
    [JarvisWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [JarvisWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][JarvisWin]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 300
    if ([JarvisWin]::GetForegroundWindow() -eq $handle) {
      [System.Windows.Forms.SendKeys]::SendWait('{F11}')
    }
    Start-Sleep -Milliseconds 700
  }
}

# Leave the keyboard with the main window: that is the one that takes Space,
# and the one whose INICIAR button has to be clicked.
$main = [JarvisWin]::Find('J.A.R.V.I.S.')
if ($main -ne [IntPtr]::Zero) { [void][JarvisWin]::SetForegroundWindow($main) }
