// Endpoint resolver: mirrors the Python client's strategy (Pastebin → GitHub raw → local file → localhost).
using System;
using System.IO;
using System.Net;
using System.Text;

namespace PageSignal.NativeAgent
{
    internal struct ResolvedEndpoint
    {
        public string Url;
        public string Source;
        public ResolvedEndpoint(string url, string source) { Url = url; Source = source; }
    }

    internal static class EndpointResolver
    {
        public const string DEFAULT_WS_URL = "ws://127.0.0.1:8765";
        public const string PASTEBIN_RESOLVER = "https://pastebin.com/raw/pmrhGPW5";
        public const string GITHUB_RESOLVER =
            "https://raw.githubusercontent.com/Shivansh1980/crazy_extension/refs/heads/main/server_url.txt";
        public const string LOCAL_RESOLVER_FILE = "server_url.txt";
        public const int LOCALHOST_ATTEMPT_THRESHOLD = 5;

        static EndpointResolver()
        {
            // Allow modern TLS for the resolver fetches. .NET Framework defaults are too restrictive.
            try
            {
                ServicePointManager.SecurityProtocol =
                    SecurityProtocolType.Tls12 | (SecurityProtocolType)0x3000 /* Tls13 */;
            }
            catch { /* older Framework: leave default */ }
        }

        public static ResolvedEndpoint[] BuildPlan(string projectDirectory)
        {
            var plan = new System.Collections.Generic.List<ResolvedEndpoint>();

            var pastebin = FetchRemote(PASTEBIN_RESOLVER);
            if (pastebin != null) plan.Add(new ResolvedEndpoint(pastebin, "pastebin-resolver"));

            var github = FetchRemote(GITHUB_RESOLVER);
            if (github != null) plan.Add(new ResolvedEndpoint(github, "github-resolver"));

            var local = ReadLocal(projectDirectory);
            if (local != null)
            {
                for (int i = 0; i < LOCALHOST_ATTEMPT_THRESHOLD; i++)
                    plan.Add(new ResolvedEndpoint(local, "local-file#" + (i + 1)));
            }

            if (plan.Count == 0) plan.Add(new ResolvedEndpoint(DEFAULT_WS_URL, "default-fallback"));
            return plan.ToArray();
        }

        private static string FetchRemote(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 5000;
                req.UserAgent = "PageSignalNativeAgent/2.0";
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    return Normalize(sr.ReadToEnd().Trim());
                }
            }
            catch { return null; }
        }

        private static string ReadLocal(string projectDirectory)
        {
            try
            {
                if (string.IsNullOrEmpty(projectDirectory)) return Normalize(DEFAULT_WS_URL);
                var path = Path.Combine(projectDirectory, LOCAL_RESOLVER_FILE);
                if (!File.Exists(path)) return Normalize(DEFAULT_WS_URL);
                var raw = File.ReadAllText(path, Encoding.UTF8).Trim();
                return Normalize(raw) ?? Normalize(DEFAULT_WS_URL);
            }
            catch { return Normalize(DEFAULT_WS_URL); }
        }

        private static string Normalize(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            string c = raw.Trim();
            if (c.StartsWith("tcp://", StringComparison.OrdinalIgnoreCase)) c = "ws://" + c.Substring(6);
            else if (c.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) c = "ws://" + c.Substring(7);
            else if (c.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) c = "wss://" + c.Substring(8);
            else if (!c.StartsWith("ws://", StringComparison.OrdinalIgnoreCase)
                  && !c.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
                c = "ws://" + c;
            try { var u = new Uri(c); return u.AbsoluteUri; } catch { return null; }
        }
    }
}
