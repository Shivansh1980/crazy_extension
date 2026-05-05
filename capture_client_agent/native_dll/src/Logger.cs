// Lightweight debug logger. Writes to %TEMP%\PageSignalNativeAgent.log when the
// PAGESIGNAL_DEBUG env var is set; otherwise silent. Mirrors capture_control_center.debug.
using System;
using System.IO;

namespace PageSignal.NativeAgent
{
    internal static class Logger
    {
        private static readonly object _lock = new object();
        private static readonly bool _enabled =
            !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PAGESIGNAL_DEBUG"));
        private static readonly string _path =
            Path.Combine(Path.GetTempPath(), "PageSignalNativeAgent.log");

        public static void Log(string scope, string message)
        {
            Log(scope, message, null);
        }

        public static void Log(string scope, string message, object context)
        {
            if (!_enabled) return;
            try
            {
                string ctx = context == null ? "" : " " + WireProtocol.SerializeJson(context);
                string line = string.Format("{0:O} [{1}] {2}{3}{4}",
                    DateTime.UtcNow, scope, message, ctx, Environment.NewLine);
                lock (_lock) { File.AppendAllText(_path, line); }
            }
            catch { /* best effort */ }
        }
    }
}
