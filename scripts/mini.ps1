# Desktop mini window for Claude Code Monitor.
#
# A small frameless window that stays on top of every other one: the live
# sessions, and Allow / Deny on pending approvals. Started by
# scripts/mini.js; PowerShell 5.1 and WPF ship with Windows, so there is
# nothing to install.
#
#   drag anywhere        move it (the position is kept in data/mini.json)
#   click a session      bring its window to the front
#   right-click          open the dashboard, or close
#
# Keep this file ASCII: PowerShell 5.1 reads a script without a BOM in the
# ANSI code page, and anything else comes out garbled.

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dataDir = Join-Path $root 'data'
$logFile = Join-Path $dataDir 'mini.log'
$posFile = Join-Path $dataDir 'mini.json'

# One window is enough; a second launch just leaves.
$created = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'Local\ClaudeCodeMonitorMini', [ref]$created)
if (-not $created) { exit 0 }

try {

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http

$port = if ($env:PORT) { $env:PORT } else { 7888 }
$baseUrl = "http://localhost:$port"
$token = (Get-Content (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json).apiToken

$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(3)
$http.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)

function Log($msg) {
  try { "$(Get-Date -Format s) $msg" | Add-Content $logFile } catch {}
}

# Requests in flight, checked by the poll timer: the window never waits
# on one, but one that fails still says so in the log.
$script:inflight = New-Object System.Collections.ArrayList
function Post-Json($path, $json) {
  $body = New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, 'application/json')
  [void]$script:inflight.Add(@{ path = $path; task = $http.PostAsync($baseUrl + $path, $body) })
}
function Check-Inflight {
  foreach ($r in @($script:inflight)) {
    if (-not $r.task.IsCompleted) { continue }
    $script:inflight.Remove($r)
    if ($r.task.Status -ne 'RanToCompletion') { Log "POST $($r.path) failed: $($r.task.Exception.InnerException.Message)"; continue }
    $res = $r.task.Result
    $text = $res.Content.ReadAsStringAsync().Result
    # Focus answers 200 with ok:false when it found no window to raise.
    if (-not $res.IsSuccessStatusCode -or $text -match '"ok":false') { Log "POST $($r.path) -> $([int]$res.StatusCode) $text" }
  }
}

# Windows only lets a process take the foreground if the one in front lets
# it. When a session row is clicked, the one in front is this window, and
# the focus is done by the server, so this window has to hand it over.
Add-Type -Namespace MiniWin -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);'

function Brush($hex) { (New-Object System.Windows.Media.BrushConverter).ConvertFromString($hex) }

$C = @{
  bg = Brush '#F0141414'; border = Brush '#40FFFFFF'; hover = Brush '#1FFFFFFF'
  text = Brush '#E5E5E5'; muted = Brush '#8A8A8A'; dim = Brush '#5A5A5A'
  amber = Brush '#F59E0B'; amberBg = Brush '#26F59E0B'; red = Brush '#EF4444'
  green = Brush '#22C55E'; transparent = [System.Windows.Media.Brushes]::Transparent
}
$dotColor = @{ working = $C.green; waiting_permission = $C.amber; idle = Brush '#3B82F6' }

$buttonTemplate = [Windows.Markup.XamlReader]::Parse(@'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button">
  <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
          BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="4" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
</ControlTemplate>
'@)

function Text($s, $size, $brush, $weight = 'Normal') {
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = $s; $t.FontSize = $size; $t.Foreground = $brush; $t.FontWeight = $weight
  $t.TextTrimming = 'CharacterEllipsis'
  $t
}

function Ago($ms) {
  $d = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $ms
  if ($d -lt 60000) { 'now' } elseif ($d -lt 3600000) { [string][int][Math]::Floor($d / 60000) + 'm' }
  elseif ($d -lt 86400000) { [string][int][Math]::Floor($d / 3600000) + 'h' } else { [string][int][Math]::Floor($d / 86400000) + 'd' }
}

# ---- Window ----
$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'; $win.AllowsTransparency = $true; $win.Background = $C.transparent
$win.Topmost = $true; $win.ShowInTaskbar = $false; $win.ResizeMode = 'NoResize'
$win.SizeToContent = 'Height'; $win.Width = 220
$win.FontFamily = 'Segoe UI'; $win.Title = 'Claude Code Monitor'

$frame = New-Object System.Windows.Controls.Border
$frame.Background = $C.bg; $frame.BorderBrush = $C.border; $frame.BorderThickness = 1
$frame.CornerRadius = 8; $frame.Padding = 4
$scroll = New-Object System.Windows.Controls.ScrollViewer
$scroll.VerticalScrollBarVisibility = 'Auto'; $scroll.MaxHeight = 520
# A focusable ScrollViewer takes focus on a press and marks it handled, so
# the press never reaches the window: no click, no drag.
$scroll.Focusable = $false
$list = New-Object System.Windows.Controls.StackPanel
$scroll.Content = $list; $frame.Child = $scroll; $win.Content = $frame

$menu = New-Object System.Windows.Controls.ContextMenu
$miOpen = New-Object System.Windows.Controls.MenuItem; $miOpen.Header = 'Open dashboard'
$miOpen.Add_Click({ Start-Process $baseUrl })
$miClose = New-Object System.Windows.Controls.MenuItem; $miClose.Header = 'Close'
$miClose.Add_Click({ $win.Close() })
[void]$menu.Items.Add($miOpen); [void]$menu.Items.Add($miClose)
$win.ContextMenu = $menu

# ---- Position ----
# The window grows upward from its bottom edge, so a widget parked above
# the taskbar stays there however many sessions it lists.
$script:anchor = $null
try { $script:anchor = Get-Content $posFile -Raw | ConvertFrom-Json } catch {}
$vs = @{ l = [System.Windows.SystemParameters]::VirtualScreenLeft; t = [System.Windows.SystemParameters]::VirtualScreenTop
         w = [System.Windows.SystemParameters]::VirtualScreenWidth; h = [System.Windows.SystemParameters]::VirtualScreenHeight }
if (-not $script:anchor -or $script:anchor.left -lt $vs.l -or $script:anchor.left -gt $vs.l + $vs.w - 40 -or
    $script:anchor.bottom -lt $vs.t + 40 -or $script:anchor.bottom -gt $vs.t + $vs.h) {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $script:anchor = [pscustomobject]@{ left = $wa.Right - $win.Width - 12; bottom = $wa.Bottom - 12 }
}
$win.WindowStartupLocation = 'Manual'
$win.Left = $script:anchor.left; $win.Top = $script:anchor.bottom - 60
$win.Add_SizeChanged({ $win.Top = $script:anchor.bottom - $win.ActualHeight })

# One handler for the whole window: a press that moves it is a drag, one
# that does not is a click on whatever session row is under the pointer.
# Buttons handle their own presses and never get here.
$win.Add_MouseLeftButtonDown({
  param($sender, $e)
  $left = $win.Left; $top = $win.Top
  try { $win.DragMove() } catch {}
  if ($win.Left -ne $left -or $win.Top -ne $top) {
    $script:anchor = [pscustomobject]@{ left = $win.Left; bottom = $win.Top + $win.ActualHeight }
    try { $script:anchor | ConvertTo-Json | Set-Content $posFile -Encoding UTF8 } catch {}
    return
  }
  $el = $e.OriginalSource
  while ($el -and -not ($el.Tag -is [string])) {
    try { $el = [System.Windows.Media.VisualTreeHelper]::GetParent($el) } catch { $el = $null }
  }
  if ($el) {
    [void][MiniWin.User32]::AllowSetForegroundWindow(-1)  # ASFW_ANY
    Post-Json "/api/sessions/$($el.Tag)/focus" '{}'
  }
})

$onEnter = { param($s) $s.Background = $C.hover }
$onLeave = { param($s) $s.Background = $C.transparent }
$onDecide = {
  param($s)
  $s.Parent.IsEnabled = $false
  Post-Json "/api/pending/$($s.Tag.id)/decide" ('{"decision":"' + $s.Tag.decision + '"}')
}

function Decision-Button($label, $approvalId, $decision, $bg, $fg, $borderBrush) {
  $b = New-Object System.Windows.Controls.Button
  $b.Template = $buttonTemplate; $b.Content = $label
  $b.Background = $bg; $b.Foreground = $fg; $b.BorderBrush = $borderBrush; $b.BorderThickness = 1
  $b.Padding = '12,2'; $b.Margin = '0,0,6,0'; $b.FontSize = 11; $b.FontWeight = 'SemiBold'; $b.Cursor = 'Hand'
  $b.Tag = @{ id = $approvalId; decision = $decision }
  $b.Add_Click($onDecide)
  $b
}

function Render($state) {
  $list.Children.Clear()
  foreach ($a in $state.approvals) {
    $card = New-Object System.Windows.Controls.Border
    $card.Background = $C.amberBg; $card.BorderBrush = $C.amber; $card.BorderThickness = 1
    $card.CornerRadius = 5; $card.Padding = '7,5'; $card.Margin = '0,0,0,4'
    $body = New-Object System.Windows.Controls.StackPanel
    [void]$body.Children.Add((Text "$($a.toolName)  $($a.project)" 11 $C.amber 'SemiBold'))
    $desc = Text $a.description 11 $C.text
    $desc.FontFamily = 'Cascadia Code, Consolas'; $desc.TextWrapping = 'Wrap'; $desc.MaxHeight = 44; $desc.Margin = '0,2,0,5'
    [void]$body.Children.Add($desc)
    $btns = New-Object System.Windows.Controls.StackPanel; $btns.Orientation = 'Horizontal'
    [void]$btns.Children.Add((Decision-Button 'Allow' $a.id 'allow' $C.green (Brush '#000000') $C.green))
    [void]$btns.Children.Add((Decision-Button 'Deny' $a.id 'deny' $C.transparent $C.red $C.red))
    [void]$body.Children.Add($btns)
    $card.Child = $body
    [void]$list.Children.Add($card)
  }
  foreach ($s in $state.sessions) {
    $row = New-Object System.Windows.Controls.Border
    $row.CornerRadius = 5; $row.Padding = '6,3'; $row.Background = $C.transparent
    if ($s.status -eq 'waiting_permission') { $row.BorderBrush = $C.amber; $row.BorderThickness = 1 }
    if ($s.canFocus) {
      $row.Tag = [string]$s.id; $row.Cursor = 'Hand'; $row.ToolTip = 'Bring the session window to the front'
      $row.Add_MouseEnter($onEnter); $row.Add_MouseLeave($onLeave)
    }
    $body = New-Object System.Windows.Controls.StackPanel
    $top = New-Object System.Windows.Controls.DockPanel
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 7; $dot.Height = 7; $dot.Margin = '0,0,6,0'; $dot.VerticalAlignment = 'Center'
    $dot.Fill = if ($dotColor[$s.status]) { $dotColor[$s.status] } else { $C.dim }
    [System.Windows.Controls.DockPanel]::SetDock($dot, 'Left')
    [void]$top.Children.Add($dot)
    $ago = Text (Ago $s.lastActivity) 10 $C.dim
    $ago.Margin = '6,0,0,0'; $ago.VerticalAlignment = 'Center'
    [System.Windows.Controls.DockPanel]::SetDock($ago, 'Right')
    [void]$top.Children.Add($ago)
    $nameBrush = if ($s.status -eq 'idle') { $C.muted } else { $C.text }
    [void]$top.Children.Add((Text $s.name 12 $nameBrush 'SemiBold'))
    [void]$body.Children.Add($top)
    if ($s.activity) {
      $act = Text $s.activity 11 $C.muted
      $act.Margin = '13,0,0,0'
      [void]$body.Children.Add($act)
    }
    $row.Child = $body
    [void]$list.Children.Add($row)
  }
  if (-not $state.approvals -and -not $state.sessions) {
    $note = Text $(if ($state.error) { $state.error } else { 'No active session' }) 11 $(if ($state.error) { $C.red } else { $C.dim })
    $note.Margin = '6,3'
    [void]$list.Children.Add($note)
  }
}

# ---- Polling ----
# The request runs on the thread pool and the timer only collects it once
# it is done, so a slow or dead server never freezes the window.
$script:pending = $null
$script:lastSig = $null
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
  Check-Inflight
  if (-not $script:pending) { $script:pending = $http.GetStringAsync("$baseUrl/api/mini"); return }
  if (-not $script:pending.IsCompleted) { return }
  $task = $script:pending; $script:pending = $null
  if ($task.Status -eq 'RanToCompletion') {
    $json = $task.Result
    $state = $json | ConvertFrom-Json
    $sig = $json + '|' + (($state.sessions | ForEach-Object { Ago $_.lastActivity }) -join ',')
  } else {
    $msg = $task.Exception.ToString()
    $err = if ($msg -match '401') { 'Bad API token - re-run npm run mini' } else { 'Monitor unreachable' }
    $state = [pscustomobject]@{ sessions = @(); approvals = @(); error = $err }
    $sig = $err
  }
  # Rebuilding the list under a pressed button would swallow the click.
  if ($sig -eq $script:lastSig -or [System.Windows.Input.Mouse]::LeftButton -eq 'Pressed') { return }
  $script:lastSig = $sig
  Render $state
})
$timer.Start()

Render ([pscustomobject]@{ sessions = @(); approvals = @(); error = 'Connecting...' })
[void]$win.ShowDialog()

} catch {
  "$(Get-Date -Format s) $($_ | Out-String)" | Add-Content $logFile
} finally {
  $script:mutex.ReleaseMutex()
}
