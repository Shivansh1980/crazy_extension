// OS-level mouse/keyboard dispatcher (Win32 SendInput).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace PageSignal.NativeAgent
{
    internal static class InputDispatcher
    {
        // ---------------- Win32 ----------------
        private const int INPUT_MOUSE = 0;
        private const int INPUT_KEYBOARD = 1;

        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_HWHEEL = 0x01000;
        private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;
        private const uint KEYEVENTF_SCANCODE = 0x0008;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public uint type; public InputUnion u; }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")] private static extern bool SetCursorPos(int X, int Y);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
        [DllImport("user32.dll")] private static extern short VkKeyScan(char ch);

        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;

        public class DispatchResult
        {
            public string Message;
            public string TargetDescription;
            public int ViewportWidth;
            public int ViewportHeight;
        }

        public class KeyResult
        {
            public string Message;
            public string TargetDescription;
        }

        // -------------- Mouse --------------
        public static DispatchResult DispatchInput(IDictionary<string, object> p)
        {
            string action = AsString(p, "action");
            double nx = AsDouble(p, "normalizedX");
            double ny = AsDouble(p, "normalizedY");
            int button = (int)AsDouble(p, "button");
            double dx = AsDouble(p, "deltaX");
            double dy = AsDouble(p, "deltaY");
            var mods = AsModifiers(p, "modifiers");

            int sw = GetSystemMetrics(SM_CXSCREEN);
            int sh = GetSystemMetrics(SM_CYSCREEN);
            int tx = Clamp((int)Math.Round(nx * sw), 0, Math.Max(0, sw - 1));
            int ty = Clamp((int)Math.Round(ny * sh), 0, Math.Max(0, sh - 1));

            string msg;
            switch (action)
            {
                case "pointer-move":
                    SetCursorPos(tx, ty);
                    msg = "Moved cursor to " + tx + "," + ty + ".";
                    break;
                case "pointer-down":
                    SetCursorPos(tx, ty);
                    WithModifiers(mods, () => MouseButton(button, true));
                    msg = "Pressed button " + button + " at " + tx + "," + ty + ".";
                    break;
                case "pointer-up":
                    SetCursorPos(tx, ty);
                    WithModifiers(mods, () => MouseButton(button, false));
                    msg = "Released button " + button + " at " + tx + "," + ty + ".";
                    break;
                case "click":
                    SetCursorPos(tx, ty);
                    WithModifiers(mods, () => { MouseButton(button, true); MouseButton(button, false); });
                    msg = "Clicked button " + button + " at " + tx + "," + ty + ".";
                    break;
                case "double-click":
                    SetCursorPos(tx, ty);
                    WithModifiers(mods, () =>
                    {
                        MouseButton(button, true); MouseButton(button, false);
                        Thread.Sleep(30);
                        MouseButton(button, true); MouseButton(button, false);
                    });
                    msg = "Double-clicked button " + button + " at " + tx + "," + ty + ".";
                    break;
                case "wheel":
                    SetCursorPos(tx, ty);
                    if (Math.Abs(dy) > 0.0001) MouseWheel(-(int)Math.Round(dy), false);
                    if (Math.Abs(dx) > 0.0001) MouseWheel((int)Math.Round(dx), true);
                    msg = "Scrolled at " + tx + "," + ty + ".";
                    break;
                default:
                    throw new ArgumentException("Unsupported screen-share input action: " + action);
            }

            return new DispatchResult
            {
                Message = msg,
                TargetDescription = "desktop:" + tx + "," + ty,
                ViewportWidth = sw,
                ViewportHeight = sh,
            };
        }

        private static void MouseButton(int button, bool down)
        {
            uint flag;
            switch (button)
            {
                case 1: flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
                case 2: flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
                default: flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
            }
            var inp = new INPUT { type = INPUT_MOUSE };
            inp.u.mi = new MOUSEINPUT { dwFlags = flag };
            SendInput(1, new[] { inp }, Marshal.SizeOf(typeof(INPUT)));
        }

        private static void MouseWheel(int amount, bool horizontal)
        {
            // amount is in pixel-ish units; convert to wheel delta (~120 per notch).
            int delta = amount * 120 / 100;
            if (delta == 0) return;
            var inp = new INPUT { type = INPUT_MOUSE };
            inp.u.mi = new MOUSEINPUT
            {
                dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL,
                mouseData = (uint)delta,
            };
            SendInput(1, new[] { inp }, Marshal.SizeOf(typeof(INPUT)));
        }

        // -------------- Keyboard --------------
        public static KeyResult DispatchKey(IDictionary<string, object> p)
        {
            string action = AsString(p, "action");
            string key = AsString(p, "key") ?? "";
            string text = AsString(p, "text") ?? "";
            var mods = AsModifiers(p, "modifiers");

            if (action == "type" && !string.IsNullOrEmpty(text))
            {
                foreach (char ch in text) SendUnicodeChar(ch);
                return new KeyResult { Message = "Typed " + text.Length + " character(s).", TargetDescription = "desktop:typewrite" };
            }

            ushort vk = MapKey(key);
            if (vk == 0)
            {
                if (!string.IsNullOrEmpty(key) && key.Length == 1 && (action == "down" || action == "type"))
                {
                    WithModifiers(mods, () => SendUnicodeChar(key[0]));
                    return new KeyResult { Message = "Typed key '" + key + "'.", TargetDescription = "desktop:typewrite" };
                }
                return new KeyResult { Message = "Ignored unmappable key '" + key + "'.", TargetDescription = "desktop:noop" };
            }

            if (action == "down")
            {
                WithModifiers(mods, () => SendVk(vk, false), holdModifiers: false);
                return new KeyResult { Message = "keyDown " + key, TargetDescription = "desktop:key" };
            }
            if (action == "up")
            {
                WithModifiers(mods, () => SendVk(vk, true), holdModifiers: false);
                return new KeyResult { Message = "keyUp " + key, TargetDescription = "desktop:key" };
            }
            // type / press
            WithModifiers(mods, () => { SendVk(vk, false); SendVk(vk, true); });
            return new KeyResult { Message = "press " + key, TargetDescription = "desktop:key" };
        }

        private static void SendVk(ushort vk, bool up)
        {
            var inp = new INPUT { type = INPUT_KEYBOARD };
            inp.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYEVENTF_KEYUP : 0 };
            SendInput(1, new[] { inp }, Marshal.SizeOf(typeof(INPUT)));
        }

        private static void SendUnicodeChar(char ch)
        {
            var down = new INPUT { type = INPUT_KEYBOARD };
            down.u.ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE };
            var up = new INPUT { type = INPUT_KEYBOARD };
            up.u.ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP };
            SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
        }

        private static ushort MapKey(string key)
        {
            if (string.IsNullOrEmpty(key)) return 0;
            switch (key)
            {
                case "Enter": case "Return": return 0x0D;
                case "Tab": return 0x09;
                case "Backspace": return 0x08;
                case "Delete": return 0x2E;
                case "Escape": case "Esc": return 0x1B;
                case "ArrowUp": return 0x26;
                case "ArrowDown": return 0x28;
                case "ArrowLeft": return 0x25;
                case "ArrowRight": return 0x27;
                case "Home": return 0x24;
                case "End": return 0x23;
                case "PageUp": return 0x21;
                case "PageDown": return 0x22;
                case "Insert": return 0x2D;
                case "CapsLock": return 0x14;
                case " ": case "Space": case "Spacebar": return 0x20;
                case "Shift": return 0x10;
                case "Control": case "Ctrl": return 0x11;
                case "Alt": return 0x12;
                case "Meta": case "Win": return 0x5B;
            }
            if (key.Length > 1 && key[0] == 'F')
            {
                int n;
                if (int.TryParse(key.Substring(1), out n) && n >= 1 && n <= 24)
                    return (ushort)(0x70 + (n - 1));
            }
            if (key.Length == 1)
            {
                short v = VkKeyScan(key[0]);
                if (v != -1) return (ushort)(v & 0xFF);
            }
            return 0;
        }

        private static void WithModifiers(IDictionary<string, bool> mods, Action body, bool holdModifiers = true)
        {
            if (mods == null || !holdModifiers) { body(); return; }
            var pressed = new List<ushort>();
            try
            {
                if (mods.ContainsKey("ctrl") && mods["ctrl"]) { SendVk(0x11, false); pressed.Add(0x11); }
                if (mods.ContainsKey("shift") && mods["shift"]) { SendVk(0x10, false); pressed.Add(0x10); }
                if (mods.ContainsKey("alt") && mods["alt"]) { SendVk(0x12, false); pressed.Add(0x12); }
                if (mods.ContainsKey("meta") && mods["meta"]) { SendVk(0x5B, false); pressed.Add(0x5B); }
                body();
            }
            finally
            {
                for (int i = pressed.Count - 1; i >= 0; i--)
                {
                    try { SendVk(pressed[i], true); } catch { }
                }
            }
        }

        // -------------- helpers --------------
        private static int Clamp(int v, int lo, int hi) { if (v < lo) return lo; if (v > hi) return hi; return v; }

        private static string AsString(IDictionary<string, object> p, string k)
        {
            object v;
            if (p == null || !p.TryGetValue(k, out v) || v == null) return null;
            return Convert.ToString(v);
        }

        private static double AsDouble(IDictionary<string, object> p, string k)
        {
            object v;
            if (p == null || !p.TryGetValue(k, out v) || v == null) return 0.0;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); }
            catch { return 0.0; }
        }

        private static IDictionary<string, bool> AsModifiers(IDictionary<string, object> p, string k)
        {
            var result = new Dictionary<string, bool>
            {
                { "ctrl", false }, { "shift", false }, { "alt", false }, { "meta", false }
            };
            object v;
            if (p == null || !p.TryGetValue(k, out v) || !(v is IDictionary<string, object>)) return result;
            var src = (IDictionary<string, object>)v;
            foreach (var key in new[] { "ctrl", "shift", "alt", "meta" })
            {
                object x;
                if (src.TryGetValue(key, out x) && x != null)
                {
                    bool b;
                    if (x is bool) result[key] = (bool)x;
                    else if (bool.TryParse(Convert.ToString(x), out b)) result[key] = b;
                }
            }
            return result;
        }
    }
}
