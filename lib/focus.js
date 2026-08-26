const { execFile } = require("child_process");

// ──────────────────────────────────────────────
// Cross-platform window focus
// ──────────────────────────────────────────────

// Sanitize strings for safe interpolation into shell scripts.
// Strict allowlist: word chars, common path separators, dot, dash, space.
// Anything else (quotes, backticks, dollar, semicolon, ampersand, redirects)
// is dropped entirely. Length capped at 200.
function sanitizeForShell(str) {
  return String(str)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^\w./\\:\- ]/g, "")
    .slice(0, 200);
}

function focusWindowWin32(searchTerms, ancestorPids, callback) {
  const termsStr = searchTerms.map(t => sanitizeForShell(t)).join("|").replace(/'/g, "''");
  // Digits and commas only — safe to interpolate
  const pidsStr = (ancestorPids || [])
    .filter(p => Number.isInteger(p) && p > 0)
    .slice(0, 20)
    .join(",");
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
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    public static string Focus(string termsStr, string pidsStr) {
        string[] terms = termsStr.Split('|');
        uint[] pids = new uint[0];
        if (pidsStr.Length > 0) {
            string[] parts = pidsStr.Split(',');
            pids = new uint[parts.Length];
            for (int i = 0; i < parts.Length; i++) { uint v; uint.TryParse(parts[i], out v); pids[i] = v; }
        }
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

            // Rank of the first term the title matches, -1 for no match.
            // Terms arrive ordered from most to least authoritative, so a
            // lower rank is a stronger claim on the session.
            int matchRank = -1;
            for (int i = 0; i < terms.Length; i++) {
                if (terms[i].Length == 0) continue;
                if (titleLow.Contains(terms[i].ToLower())) { matchRank = i; break; }
            }

            uint wpid;
            GetWindowThreadProcessId(hWnd, out wpid);
            int pidRank = -1;
            for (int i = 0; i < pids.Length; i++) {
                if (pids[i] == wpid) { pidRank = i; break; }
            }

            if (pidRank < 0 && matchRank < 0) return true;

            // Explorer is never a session host: its title is just the folder
            // name, and it is an ancestor of every shell-launched session, so
            // on pid alone a stray folder window would outscore the real one.
            string pname = "";
            try { pname = System.Diagnostics.Process.GetProcessById((int)wpid).ProcessName.ToLower(); } catch {}
            if (pname == "explorer") return true;

            int score = 0;
            if (pidRank >= 0) {
                // Window owned by an ancestor of the session process: this is
                // (almost certainly) the hosting terminal/IDE. Which term
                // matched outweighs how near the ancestor is, because every
                // VS Code window reports the same main-process pid: the title
                // is the only thing telling the session's own window from its
                // siblings. Any match still beats any non-match.
                int rank = matchRank > 17 ? 17 : matchRank;
                score = 1000 - pidRank + (matchRank >= 0 ? 200 - 10 * rank : 0);
            } else {
                if (matchRank < 0) return true;
                // Title-only fallback, scored by how likely the window is to
                // host a session at all: VS Code > Windows Terminal >
                // PowerShell/cmd > other. Term rank breaks ties within a kind.
                int kind = 1;
                if (title.Contains("Visual Studio Code")) kind = 4;
                else if (title.Contains("Windows Terminal") || title.Contains("WindowsTerminal")) kind = 3;
                else if (title.Contains("PowerShell") || title.Contains("Command Prompt") || title.Contains("MINGW")) kind = 2;
                int rank = matchRank > 90 ? 90 : matchRank;
                score = kind * 100 + (100 - rank);
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = hWnd;
                bestTitle = title;
            }
            return true;
        }, IntPtr.Zero);

        if (bestMatch == IntPtr.Zero) return "NOT_FOUND";

        // Alt-tab semantics: bring the window forward, leave its state alone.
        // SW_RESTORE was being sent unconditionally, which un-maximizes a
        // maximized window — something alt-tab never does. Only a minimized
        // window needs restoring.
        if (IsIconic(bestMatch)) ShowWindow(bestMatch, 9); // SW_RESTORE

        // Tap Alt to release the foreground lock: Windows only lets the
        // process that owns the foreground window hand it over, unless the
        // calling thread has just seen input.
        keybd_event(0xA4, 0, 0, UIntPtr.Zero);
        keybd_event(0xA4, 0, 2, UIntPtr.Zero);

        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
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
[WinFocus]::Focus('${termsStr}','${pidsStr}')
`;
  execFile("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 8000 }, (err, stdout) => {
    const result = (stdout || "").trim();
    callback(!err && result !== "" && result !== "NOT_FOUND", result);
  });
}

function focusWindowMac(searchTerms, callback) {
  const termsList = searchTerms.map(t => `"${sanitizeForShell(t).replace(/"/g, '\\"')}"`).join(", ");
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
  const safeTerms = searchTerms.map(t => sanitizeForShell(t).replace(/"/g, '\\"'));
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

// Search terms for one directory, most specific first: the full path in both
// separator styles, then its last two segments.
function dirTerms(dir) {
  const slashed = dir.replace(/\\/g, "/");
  const terms = [dir, slashed];
  const parts = slashed.split("/").filter(Boolean);
  if (parts.length >= 2) {
    terms.push(parts.slice(-2).join("/"));
    terms.push(parts.slice(-2).join("\\"));
  }
  return terms;
}

// Build search terms from session data, ordered from the strongest claim on
// the session to the weakest — the scorer prefers an earlier match. The launch
// directory comes first: an editor window is titled after the workspace it
// opened, so a session that has cd'd elsewhere is still found by the project
// it belongs to instead of by the project it wandered into, whose window is a
// sibling sharing the very same pid.
function buildSearchTerms(session) {
  const raw = [];
  if (session.rootCwd) raw.push(...dirTerms(session.rootCwd));
  if (session.projectRoot) raw.push(session.projectRoot);
  if (session.cwd) raw.push(...dirTerms(session.cwd));
  if (session.project) raw.push(session.project);

  // Case-insensitive dedupe, first occurrence (best rank) wins: the same
  // directory often reaches us spelled two ways, "c:/x/y" and "C:\x\y".
  const seen = new Set();
  const terms = [];
  for (const t of raw) {
    const term = String(t).trim().replace(/'/g, "''");
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return terms;
}

function focusSession(session, callback) {
  const searchTerms = buildSearchTerms(session);
  if (process.platform === "win32") focusWindowWin32(searchTerms, session.ancestorPids, callback);
  else if (process.platform === "darwin") focusWindowMac(searchTerms, callback);
  else focusWindowLinux(searchTerms, callback);
}

module.exports = { focusSession, buildSearchTerms };
