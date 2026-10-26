Add-Type -AssemblyName System.Drawing
$sig = @'
using System;using System.Text;using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class Probe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Run() {
    var outp = new List<string>();
    EnumWindows((h,l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h); if (len == 0) return true;
      var sb = new StringBuilder(len+1); GetWindowText(h, sb, sb.Capacity);
      RECT r; GetWindowRect(h, out r);
      uint pid; GetWindowThreadProcessId(h, out pid);
      int ex = GetWindowLong(h, -20);
      bool top = (ex & 8) != 0;
      outp.Add(string.Format("{0}|pid={1}|{2}x{3}@{4},{5}|topmost={6}|{7}", h, pid, r.Right-r.Left, r.Bottom-r.Top, r.Left, r.Top, top, sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
[Probe]::Run() | ForEach-Object { Write-Output $_ }
