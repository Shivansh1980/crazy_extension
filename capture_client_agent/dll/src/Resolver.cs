// Endpoint resolver: mirrors the Python client's strategy (Pastebin → GitHub raw → local file → localhost).
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

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
            var plan = new List<ResolvedEndpoint>();
            Dictionary<string, string> config = ReadConfiguration(projectDirectory);
            string mode = Get(config, "NATIVE_CONNECTION_MODE", Get(config, "MODE", "auto")).ToLowerInvariant();
            if (mode != "auto" && mode != "direct" && mode != "relay") mode = "auto";

            string host = Get(config, "BRIDGE_HOST", "127.0.0.1");
            if (host == "0.0.0.0" || host == "::") host = "127.0.0.1";
            string direct = Normalize(Get(
                config,
                "NATIVE_BRIDGE_URL",
                Get(config, "WEBSOCKET_URL", "ws://" + host + ":" + Get(config, "BRIDGE_PORT", "8765"))))
                ?? DEFAULT_WS_URL;
            string relay = Normalize(Get(config, "RELAY_URL", ""));

            if (mode == "relay" && relay != null)
                plan.Add(new ResolvedEndpoint(relay, "configured-relay"));

            if (mode == "auto")
            {
                var pastebin = FetchRemote(Get(config, "WEBSOCKET_RESOLVER_URL", PASTEBIN_RESOLVER));
                if (pastebin != null) plan.Add(new ResolvedEndpoint(pastebin, "primary-resolver"));

                var github = FetchRemote(Get(config, "WEBSOCKET_SECONDARY_RESOLVER_URL", GITHUB_RESOLVER));
                if (github != null) plan.Add(new ResolvedEndpoint(github, "secondary-resolver"));

                var local = ReadLocal(projectDirectory);
                if (local != null) plan.Add(new ResolvedEndpoint(local, "local-file"));
            }

            for (int i = 0; i < LOCALHOST_ATTEMPT_THRESHOLD; i++)
                plan.Add(new ResolvedEndpoint(direct, "configured-direct#" + (i + 1)));
            if (mode == "auto" && relay != null)
                plan.Add(new ResolvedEndpoint(relay, "configured-relay-fallback"));
            return plan.ToArray();
        }

        public static string SessionId(string projectDirectory)
        {
            return Get(ReadConfiguration(projectDirectory), "SESSION_ID", "default");
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
                    string raw = sr.ReadToEnd().Trim();
                    try
                    {
                        var parsed = new JavaScriptSerializer().DeserializeObject(raw) as IDictionary<string, object>;
                        if (parsed != null)
                        {
                            string[] keys = { "websocketUrl", "webSocketUrl", "bridgeUrl", "url", "targetUrl" };
                            foreach (string key in keys)
                            {
                                object value;
                                if (parsed.TryGetValue(key, out value) && value != null)
                                {
                                    raw = Convert.ToString(value);
                                    break;
                                }
                            }
                        }
                    }
                    catch { }
                    return Normalize(raw);
                }
            }
            catch { return null; }
        }

        private static string ReadLocal(string projectDirectory)
        {
            try
            {
                string path = FindUpwards(projectDirectory, "server_url.local.txt");
                if (path == null) path = FindUpwards(projectDirectory, LOCAL_RESOLVER_FILE);
                if (path == null) return null;
                var raw = File.ReadAllText(path, Encoding.UTF8).Trim();
                return Normalize(raw);
            }
            catch { return null; }
        }

        private static Dictionary<string, string> ReadConfiguration(string projectDirectory)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string envPath = FindUpwards(projectDirectory, ".env");
            if (envPath != null)
            {
                try
                {
                    foreach (string rawLine in File.ReadAllLines(envPath, Encoding.UTF8))
                    {
                        string line = rawLine.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        int separator = line.IndexOf('=');
                        if (separator <= 0) continue;
                        string key = line.Substring(0, separator).Trim();
                        string value = line.Substring(separator + 1).Trim().Trim('"', '\'');
                        if (key.Length > 0) values[key] = value;
                    }
                }
                catch { }
            }

            string[] names =
            {
                "NATIVE_CONNECTION_MODE", "MODE", "NATIVE_BRIDGE_URL", "WEBSOCKET_URL",
                "BRIDGE_HOST", "BRIDGE_PORT", "RELAY_URL", "SESSION_ID",
                "WEBSOCKET_RESOLVER_URL", "WEBSOCKET_SECONDARY_RESOLVER_URL",
            };
            foreach (string name in names)
            {
                string value = Environment.GetEnvironmentVariable(name);
                if (!string.IsNullOrEmpty(value)) values[name] = value;
            }
            return values;
        }

        private static string FindUpwards(string startDirectory, string fileName)
        {
            try
            {
                var directory = new DirectoryInfo(string.IsNullOrEmpty(startDirectory)
                    ? AppDomain.CurrentDomain.BaseDirectory
                    : startDirectory);
                while (directory != null)
                {
                    string candidate = Path.Combine(directory.FullName, fileName);
                    if (File.Exists(candidate)) return candidate;
                    directory = directory.Parent;
                }
            }
            catch { }
            return null;
        }

        private static string Get(IDictionary<string, string> values, string key, string fallback)
        {
            string value;
            return values.TryGetValue(key, out value) && !string.IsNullOrWhiteSpace(value)
                ? value.Trim()
                : fallback;
        }

        private static string Normalize(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            string c = raw.Trim();
            foreach (char character in c)
                if (char.IsWhiteSpace(character)) return null;
            if (c.StartsWith("tcp://", StringComparison.OrdinalIgnoreCase)) c = "ws://" + c.Substring(6);
            else if (c.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) c = "ws://" + c.Substring(7);
            else if (c.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) c = "wss://" + c.Substring(8);
            else if (!c.StartsWith("ws://", StringComparison.OrdinalIgnoreCase)
                  && !c.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
                c = "ws://" + c;
            try
            {
                var u = new Uri(c, UriKind.Absolute);
                if (u.Scheme != "ws" && u.Scheme != "wss") return null;
                if (string.IsNullOrWhiteSpace(u.Host)) return null;
                return u.AbsoluteUri;
            }
            catch { return null; }
        }
    }
}
