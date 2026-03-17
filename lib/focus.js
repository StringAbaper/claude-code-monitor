const { execFile } = require("child_process");

// ──────────────────────────────────────────────
// Cross-platform window focus
// ──────────────────────────────────────────────

function focusWindowWin32(searchTerms, callback) {
  const termsStr = searchTerms.join("|").replace(/'/g, "''");
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    public static string Focus(string termsStr) {
        string[] terms = termsStr.Split('|');
        IntPtr bestMatch = IntPtr.Zero;
        string bestTitle = "";
        int bestScore = 0;

        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string title = sb.ToString();
            if (title.Length == 0) return true;
            string titleLow = title.ToLower();

            bool matched = false;
            foreach (string t in terms) {
                if (titleLow.Contains(t.ToLower())) { matched = true; break; }
            }
            if (!matched) return true;

            // Score: VS Code > Windows Terminal > PowerShell/cmd > other
            int score = 1;
            if (title.Contains("Visual Studio Code")) score = 4;
            else if (title.Contains("Windows Terminal") || title.Contains("WindowsTerminal")) score = 3;
            else if (title.Contains("PowerShell") || title.Contains("Command Prompt") || title.Contains("MINGW")) score = 2;

            if (score > bestScore) {
                bestScore = score;
                bestMatch = hWnd;
                bestTitle = title;
            }
            return true;
        }, IntPtr.Zero);

        if (bestMatch == IntPtr.Zero) return "NOT_FOUND";

        ShowWindow(bestMatch, 9);
        keybd_event(0xA4, 0, 0, UIntPtr.Zero);
        keybd_event(0xA4, 0, 2, UIntPtr.Zero);

        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, out _);
        uint curThread = GetCurrentThreadId();
        if (fgThread != curThread) {
            AttachThreadInput(curThread, fgThread, true);
            SetForegroundWindow(bestMatch);
            AttachThreadInput(curThread, fgThread, false);
        } else {
            SetForegroundWindow(bestMatch);
        }
        SwitchToThisWindow(bestMatch, true);

        return bestTitle;
    }
}
'@
[WinFocus]::Focus('${termsStr}')
`;
  execFile("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 8000 }, (err, stdout) => {
    const result = (stdout || "").trim();
    callback(!err && result !== "" && result !== "NOT_FOUND", result);
  });
}

function focusWindowMac(searchTerms, callback) {
  const termsList = searchTerms.map(t => `"${t.replace(/"/g, '\\"')}"`).join(", ");
  const script = `
    set searchTerms to {${termsList}}
    set didFocus to false
    tell application "System Events"
      repeat with proc in (every process whose visible is true)
        try
          repeat with w in (every window of proc)
            set wName to name of w
            repeat with t in searchTerms
              if wName contains t then
                set appName to name of proc
                tell application appName to activate
                perform action "AXRaise" of w
                set didFocus to true
                exit repeat
              end if
            end repeat
            if didFocus then exit repeat
          end repeat
          if didFocus then exit repeat
        end try
      end repeat
    end tell
    if didFocus then return "OK"
    return "NOT_FOUND"
  `;
  execFile("osascript", ["-e", script], { timeout: 8000 }, (err, stdout) => {
    const result = (stdout || "").trim();
    callback(!err && result !== "NOT_FOUND", result);
  });
}

function focusWindowLinux(searchTerms, callback) {
  const safeTerms = searchTerms.map(t => t.replace(/"/g, '\\"'));
  const grepPattern = safeTerms.map(t => `-e "${t}"`).join(" ");
  const cmd = `
    # Try wmctrl first (X11)
    if command -v wmctrl >/dev/null 2>&1; then
      WID=$(wmctrl -l | grep -i ${grepPattern} | head -1 | awk '{print $1}')
      if [ -n "$WID" ]; then
        wmctrl -i -a "$WID" && echo "OK:wmctrl" && exit 0
      fi
    fi

    # Try xdotool (X11) - try each search term
    if command -v xdotool >/dev/null 2>&1; then
      for term in ${safeTerms.map(t => `"${t}"`).join(" ")}; do
        WID=$(xdotool search --name "$term" 2>/dev/null | head -1)
        if [ -n "$WID" ]; then
          xdotool windowactivate --sync "$WID" && echo "OK:xdotool" && exit 0
        fi
      done
    fi

    # Try gdbus for GNOME/Mutter (works on Wayland)
    if command -v gdbus >/dev/null 2>&1; then
      gdbus call --session \\
        --dest org.gnome.Shell \\
        --object-path /org/gnome/Shell \\
        --method org.gnome.Shell.Eval "
          const terms = ${JSON.stringify(safeTerms)}.map(t => t.toLowerCase());
          let found = false;
          global.get_window_actors().forEach(a => {
            if (found) return;
            let w = a.get_meta_window();
            let title = (w.get_title() || '').toLowerCase();
            if (terms.some(t => title.includes(t))) {
              w.activate(global.get_current_time());
              found = true;
            }
          });
        " 2>/dev/null && echo "OK:gdbus" && exit 0
    fi

    # Try qdbus for KDE Plasma (works on Wayland)
    if command -v qdbus >/dev/null 2>&1; then
      for wid in $(qdbus org.kde.KWin /KWin org.kde.KWin.queryWindowInfo 2>/dev/null | grep -i ${grepPattern} -B5 | grep "^windowId" | awk '{print $2}'); do
        qdbus org.kde.KWin /KWin org.kde.KWin.forceActivateWindow "$wid" 2>/dev/null && echo "OK:qdbus" && exit 0
      done
    fi

    echo "NOT_FOUND"
  `;
  execFile("bash", ["-c", cmd], { timeout: 8000 }, (err, stdout) => {
    const result = (stdout || "").trim();
    const ok = !err && result.startsWith("OK:");
    callback(ok, ok ? result : "NOT_FOUND");
  });
}

// Build search terms from session data
function buildSearchTerms(session) {
  const terms = [session.project];
  if (session.cwd) {
    terms.push(session.cwd);
    terms.push(session.cwd.replace(/\\/g, "/"));
    const parts = session.cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length >= 2) {
      terms.push(parts.slice(-2).join("/"));
      terms.push(parts.slice(-2).join("\\"));
    }
  }
  return [...new Set(terms)].map(t => t.replace(/'/g, "''"));
}

function focusSession(session, callback) {
  const searchTerms = buildSearchTerms(session);
  if (process.platform === "win32") focusWindowWin32(searchTerms, callback);
  else if (process.platform === "darwin") focusWindowMac(searchTerms, callback);
  else focusWindowLinux(searchTerms, callback);
}

module.exports = { focusSession };
