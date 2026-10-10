# Talks to Windows' own media controls: what is playing, and pause or play it.
#
# The media keys can only toggle, so "pause" pressed while nothing is playing
# starts the music - the opposite of what was asked. Windows keeps a session
# for every app that plays media and will pause or resume one explicitly, and
# report what it is playing, which is what this does.
#
# Needs Windows PowerShell 5.1 (powershell.exe): the WinRT types used here are
# not available in PowerShell 7. The bridge starts it that way.
param(
  [ValidateSet('status', 'pause', 'play')]
  [string]$Action = 'status'
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(5000) | Out-Null
  $task.Result
}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
  ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$sessions = @($manager.GetSessions())
# Act on what the user is most likely to mean: the session Windows considers
# current, and failing that any that is playing.
$current = $manager.GetCurrentSession()

if ($Action -eq 'pause') {
  foreach ($s in $sessions) {
    if ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { [void](Await ($s.TryPauseAsync()) ([bool])) }
  }
}
elseif ($Action -eq 'play') {
  $target = $current
  if (-not $target) { $target = $sessions | Select-Object -First 1 }
  if ($target -and $target.GetPlaybackInfo().PlaybackStatus -ne 'Playing') { [void](Await ($target.TryPlayAsync()) ([bool])) }
}

if ($Action -ne 'status') { Start-Sleep -Milliseconds 500 }

$out = foreach ($s in $sessions) {
  $info = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  [pscustomobject]@{
    app    = ($s.SourceAppUserModelId -replace '[_!].*$', '' -replace '^.*\.', '')
    status = [string]$s.GetPlaybackInfo().PlaybackStatus
    artist = $info.Artist
    title  = $info.Title
  }
}
ConvertTo-Json -Compress -InputObject @($out)
