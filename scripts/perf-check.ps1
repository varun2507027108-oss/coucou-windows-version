# Measures how much CPU Coucou uses in each of the three states it can be in.
# Not part of the app - run it by hand against a running build:
#
#   cargo build --release -p coucou
#   .\target\release\coucou.exe
#   powershell -NoProfile -File .\scripts\perf-check.ps1
#
# Hidden is the state the app spends most of its life in and the one CLAUDE.md
# pins at 0 %. The other two matter because the island runs a 60 fps frame loop
# and a cursor poll whenever it is visible.
#
# Two lessons learned the hard way, both of which produced nonsense numbers
# before they were fixed:
#
#   * Only Coucou's own process tree may be counted. A Windows box typically has
#     dozens of msedgewebview2.exe processes belonging to other apps; summing them
#     all attributed their CPU to Coucou and reported 3700 % of a core.
#   * The settle time has to outlast the auto-close (10 s by default) or the
#     "hidden" case silently measures a still-open, still-animating island. That
#     produced 18-23 % for a supposedly hidden app; with a long enough settle the
#     same state measures ~0.1 %.
#
# To A/B a change, edit the source, let the dev server hot-reload, and run this
# twice - taking a reading is enough, the island is deterministic once settled.

param(
  [int]$Seconds = 15
)

# SetCursorPos only - no GetCursorPos, so System.Drawing is not needed and the
# type resolves reliably.
if (-not ("Win32.Move" -as [type])) {
  Add-Type -Namespace Win32 -Name Move -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
"@
}

$proc = Get-Process coucou -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) {
  Write-Output "coucou.exe is not running - start it first."
  exit 1
}

# The island is drawn in a WebView2, which runs in its own processes. Measuring
# only coucou.exe reports the Rust side and nothing of the 60 fps canvas work.
#
# Only Coucou's own WebView2 processes may be counted: a machine typically has a
# few dozen msedgewebview2.exe processes belonging to other apps, and summing
# them all attributes their CPU to Coucou (it produced 3700 % of a core before
# this filter existed). So the tree is walked from coucou.exe by parent pid.
function Own-Tree {
  $root = Get-Process coucou -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $root) { return @() }
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
  $mine = @($all | Where-Object { $_.ProcessId -eq $root.Id })
  $queue = @($mine.ProcessId)
  while ($queue.Count -gt 0) {
    $parent = $queue[0]
    $queue = @($queue | Select-Object -Skip 1)
    $kids = @($all | Where-Object { $_.ParentProcessId -eq $parent })
    foreach ($kid in $kids) {
      if ($kid.ProcessId -notin $mine.ProcessId) {
        $mine = @($mine) + $kid
        $queue = @($queue) + $kid.ProcessId
      }
    }
  }
  return $mine
}

function Cpu-Of($tree) {
  $total = 0.0
  foreach ($p in $tree) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { $total += $proc.TotalProcessorTime.TotalSeconds }
  }
  $total
}

$tree = Own-Tree
$isWebview = @($tree | Where-Object { $_.Name -like "msedgewebview2*" })
Write-Output ("tracking {0} processes: {1} coucou + {2} webview`n" -f $tree.Count, ($tree.Count - $isWebview.Count), $isWebview.Count)

$w = [Win32.Move]::GetSystemMetrics(0)
$h = [Win32.Move]::GetSystemMetrics(1)
$cx = [int]($w / 2)
$top = 2
$awayX = [int]($w / 2)
$awayY = [int]($h / 2)

function Measure-State($label, $atX, $atY, $move) {
  if ($null -ne $atX) {
    [Win32.Move]::SetCursorPos($atX, $atY) | Out-Null
    Start-Sleep -Milliseconds 1500   # let the island wake
  }
  $cpu0 = Cpu-Of $tree
  $wall0 = Get-Date
  if ($move) {
    $end = (Get-Date).AddSeconds($Seconds)
    $i = 0
    while ((Get-Date) -lt $end) {
      # A real sweep across the island, so the poll stays in its 16 ms mode.
      $i++
      [Win32.Move]::SetCursorPos([int]($atX + [math]::Sin($i / 4) * 80), $atY) | Out-Null
      Start-Sleep -Milliseconds 16
    }
  } else {
    Start-Sleep -Seconds $Seconds
  }
  # Parenthesised on purpose: `Cpu-Of $tree - $cpu0` would pass the subtraction
  # as a second argument and return the whole cumulative total.
  $cpu = (Cpu-Of $tree) - $cpu0
  $wall = ((Get-Date) - $wall0).TotalSeconds
  "{0,-30} {1,6:P2} of a core  ({2:N1}s)" -f $label, ($cpu / $wall), $wall
}

Write-Output ("screen {0}x{1}`n" -f $w, $h)
# Warm up for longer than the auto-close (15 s by default), so the "hidden" case
# really is hidden: the launch greeting and the first paint are done and the
# island has retracted. Measuring sooner reported the open island as the hidden
# one, which is how a 25 % "hidden" reading appears.
Start-Sleep -Seconds 22
Measure-State "hidden (cursor away)"    $awayX $awayY $false
Measure-State "visible, cursor still"   $cx    $top   $false
Measure-State "visible, cursor moving"  $cx    $top   $true
[Win32.Move]::SetCursorPos($awayX, $awayY) | Out-Null
Write-Output ("`nworking set {0:N1} MB across {1} processes" -f (($tree | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum).Sum / 1MB), $tree.Count)
