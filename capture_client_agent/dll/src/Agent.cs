// PageSignal native agent — main coordinator. Mirrors capture_client_agent/client.py.
//
// Public API (callable from a host EXE or via reflection after the DLL is loaded):
//   PageSignal.NativeAgent.Agent.StartBackground();   // spawn worker thread, return immediately
//   PageSignal.NativeAgent.Agent.Start();             // run synchronously on caller thread
//   PageSignal.NativeAgent.Agent.Stop();
//
// The agent connects to the bridge (resolver chain identical to the Python client),
// registers as a native client, and handles capture / screen-share / input messages.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace PageSignal.NativeAgent
{
    public static class Agent
    {
        private const string CLIENT_NAME = "page-signal-native-client";
        private const string CLIENT_VERSION = "2.1.0-csharp";
        private const int RECONNECT_INTERVAL_SECONDS = 5;
        private const int MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

        private static readonly object _lock = new object();
        private static CancellationTokenSource _cts;
        private static Thread _worker;
        private static readonly string _clientId = Guid.NewGuid().ToString();
        private static readonly NativePopupService _nativePopup = new NativePopupService();
        private static readonly SemaphoreSlim _sendGate = new SemaphoreSlim(1, 1);

        public static void StartBackground()
        {
            TryEnablePerMonitorV2DpiAwareness();
            lock (_lock)
            {
                if (_worker != null && _worker.IsAlive) return;
                _cts = new CancellationTokenSource();
                var source = _cts;
                var token = source.Token;
                _worker = new Thread(() =>
                {
                    try { RunForever(token).GetAwaiter().GetResult(); }
                    catch (Exception ex) { Logger.Log("agent", "worker crashed", new { error = ex.ToString() }); }
                    finally
                    {
                        lock (_lock)
                        {
                            if (object.ReferenceEquals(_cts, source)) _cts = null;
                            if (object.ReferenceEquals(_worker, Thread.CurrentThread)) _worker = null;
                        }
                        source.Dispose();
                    }
                });
                _worker.IsBackground = true;
                _worker.Name = "PageSignalNativeAgent";
                _worker.Start();
            }
            Logger.Log("agent", "started in background", new { clientId = _clientId });
        }

        // ICLRRuntimeHost.ExecuteInDefaultAppDomain requires a static method with the exact
        // signature int Method(string). The native bootstrap uses this adapter after loading
        // PageSignalAgent.dll into the target process.
        public static int StartBackgroundFromBootstrap(string unusedArgument)
        {
            StartBackground();
            return 0;
        }

        public static void Start()
        {
            TryEnablePerMonitorV2DpiAwareness();
            CancellationTokenSource cts;
            lock (_lock)
            {
                if (_cts != null) throw new InvalidOperationException("Agent already running.");
                _cts = new CancellationTokenSource();
                cts = _cts;
            }
            try { RunForever(cts.Token).GetAwaiter().GetResult(); }
            finally { lock (_lock) { _cts = null; } }
        }

        public static void Stop()
        {
            CancellationTokenSource cts; Thread w;
            lock (_lock) { cts = _cts; w = _worker; }
            if (cts != null) try { cts.Cancel(); } catch { }
            if (w != null && w != Thread.CurrentThread) try { w.Join(2500); } catch { }
            lock (_lock)
            {
                if (w == null || !w.IsAlive)
                {
                    if (object.ReferenceEquals(_cts, cts)) _cts = null;
                    if (object.ReferenceEquals(_worker, w)) _worker = null;
                }
            }
            Logger.Log("agent", "stop requested");
        }

        // ----------------- PerMonitorV2 DPI awareness -----------------
        // Belt-and-braces: the host EXE manifest already declares PerMonitorV2, but when the
        // managed agent is loaded into a third-party process via DLL injection that process'
        // manifest takes precedence. Try to escalate to PerMonitorV2 programmatically; if the
        // host has already locked DPI awareness this call simply returns false and we move on.
        private const int DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
        private const int DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE = -3;

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int value); // 2 = PerMonitor

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private static int _dpiInitialized; // 0 = no, 1 = yes (Interlocked)
        private static void TryEnablePerMonitorV2DpiAwareness()
        {
            if (Interlocked.Exchange(ref _dpiInitialized, 1) == 1) return;
            try { if (SetProcessDpiAwarenessContext(new IntPtr(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))) return; } catch { }
            try { if (SetProcessDpiAwarenessContext(new IntPtr(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE))) return; } catch { }
            try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        private static string ProjectDirectory()
        {
            try
            {
                var asmPath = Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(asmPath)) return Path.GetDirectoryName(asmPath);
            }
            catch { }
            return AppDomain.CurrentDomain.BaseDirectory;
        }

        private static async Task RunForever(CancellationToken token)
        {
            string projectDir = ProjectDirectory();
            Logger.Log("agent", "RunForever start", new { clientId = _clientId, projectDir });
            while (!token.IsCancellationRequested)
            {
                ResolvedEndpoint[] plan;
                try { plan = EndpointResolver.BuildPlan(projectDir); }
                catch (Exception ex)
                {
                    Logger.Log("agent", "resolver crashed; using default fallback", new { error = ex.Message });
                    plan = new[] { new ResolvedEndpoint(EndpointResolver.DEFAULT_WS_URL, "default-fallback") };
                }
                if (plan == null || plan.Length == 0)
                {
                    plan = new[] { new ResolvedEndpoint(EndpointResolver.DEFAULT_WS_URL, "default-fallback") };
                }

                foreach (var endpoint in plan)
                {
                    if (token.IsCancellationRequested) return;
                    Exception failure = null;
                    try
                    {
                        await ConnectAndServe(endpoint, token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) { return; }
                    catch (Exception ex) { failure = ex; }
                    if (failure != null)
                    {
                        Logger.Log("agent", "connection attempt failed",
                            new { endpoint = endpoint.Url, source = endpoint.Source, error = failure.Message });
                        try { await Task.Delay(RECONNECT_INTERVAL_SECONDS * 1000, token).ConfigureAwait(false); }
                        catch (TaskCanceledException) { return; }
                    }
                }

                Logger.Log("agent", "all endpoints exhausted; restarting resolver chain");
            }
        }

        private static async Task ConnectAndServe(ResolvedEndpoint endpoint, CancellationToken token)
        {
            Logger.Log("agent", "opening websocket",
                new { endpoint = endpoint.Url, source = endpoint.Source });
            using (var ws = new ClientWebSocket())
            {
                ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

                // Bound the ConnectAsync handshake so unreachable endpoints don't stall the
                // resolver chain. Once the websocket is open we go back to the caller's token only.
                using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(token))
                {
                    connectCts.CancelAfter(TimeSpan.FromSeconds(10));
                    try
                    {
                        await ws.ConnectAsync(new Uri(endpoint.Url), connectCts.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        if (token.IsCancellationRequested) throw;
                        throw new TimeoutException("Websocket handshake timed out after 10s.");
                    }
                }

                var capabilities = new List<string> { "os-input", "screen-capture", "native-popup", "file-transfer.native" };
                var register = new Dictionary<string, object>
                {
                    { "type", "client.register" },
                    { "clientId", _clientId },
                    { "name", CLIENT_NAME },
                    { "version", CLIENT_VERSION },
                    { "role", "native-input-client" },
                    { "sessionId", EndpointResolver.SessionId(ProjectDirectory()) },
                    { "capabilities", capabilities },
                };
                await SendJson(ws, register, token).ConfigureAwait(false);
                Logger.Log("agent", "registered with bridge",
                    new { endpoint = endpoint.Url, capabilities });

                var streamService = new ScreenStreamService();
                _nativePopup.BindBridge(
                    obj => SendJson(ws, obj, token),
                    (meta, bytes) => SendBinary(ws, meta, bytes, token));
                Exception loopError = null;
                try
                {
                    await ReceiveLoop(ws, streamService, token).ConfigureAwait(false);
                }
                catch (Exception ex) { loopError = ex; }
                finally
                {
                    streamService.Stop();
                    _nativePopup.UnbindBridge();
                }
                if (ws.State == WebSocketState.Open)
                {
                    try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "shutdown", CancellationToken.None); }
                    catch { }
                }
                if (loopError != null) throw loopError;
            }
        }

        private static async Task ReceiveLoop(ClientWebSocket ws, ScreenStreamService stream, CancellationToken token)
        {
            byte[] buffer = new byte[64 * 1024];
            using (var msBuf = new MemoryStream())
            {
                while (!token.IsCancellationRequested && ws.State == WebSocketState.Open)
                {
                    msBuf.SetLength(0);
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token).ConfigureAwait(false);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
                            return;
                        }
                        msBuf.Write(buffer, 0, result.Count);
                        if (msBuf.Length > MAX_MESSAGE_BYTES)
                            throw new InvalidDataException("Websocket message exceeded the 64 MiB safety limit.");
                    } while (!result.EndOfMessage);

                    byte[] frame = msBuf.ToArray();
                    if (result.MessageType == WebSocketMessageType.Binary)
                    {
                        IDictionary<string, object> metadata;
                        byte[] payloadBytes;
                        if (WireProtocol.TryDecodeBinaryEnvelope(frame, out metadata, out payloadBytes))
                        {
                            string payloadType = metadata.ContainsKey("type") ? Convert.ToString(metadata["type"]) : null;
                            if (payloadType == "file-transfer.upload.binary")
                            {
                                await HandleNativePopupFileUpload(ws, metadata, payloadBytes, token).ConfigureAwait(false);
                                continue;
                            }
                        }
                        Logger.Log("agent", "ignoring binary frame", new { bytes = frame.Length });
                        continue;
                    }

                    string text = Encoding.UTF8.GetString(frame);
                    IDictionary<string, object> payload;
                    try { payload = WireProtocol.ParseJsonObject(text); }
                    catch { Logger.Log("agent", "non-JSON text payload"); continue; }
                    if (payload == null) continue;

                    string mt = payload.ContainsKey("type") ? Convert.ToString(payload["type"]) : null;
                    try
                    {
                        switch (mt)
                        {
                            case "capture.request": await HandleCapture(ws, payload, token); break;
                            case "screen-share.input": await HandleInput(ws, payload, token); break;
                            case "screen-share.key": await HandleKey(ws, payload, token); break;
                            case "screen-share.start": await HandleStreamStart(ws, payload, stream, token); break;
                            case "screen-share.stop": await HandleStreamStop(ws, payload, stream, token); break;
                            case "popup.show": await HandleNativePopupShow(ws, payload, token); break;
                            default: Logger.Log("agent", "received text", new { type = mt }); break;
                        }
                    }
                    catch (Exception ex)
                    {
                        Logger.Log("agent", "handler crashed", new { type = mt, error = ex.Message });
                    }
                }
            }
        }

        // ---------------- handlers ----------------
        private static async Task HandleCapture(ClientWebSocket ws, IDictionary<string, object> p, CancellationToken token)
        {
            string requestId = p.ContainsKey("requestId") ? Convert.ToString(p["requestId"]) : "";
            string errorMessage = null;
            try
            {
                var captured = await Task.Run(() =>
                {
                    int cw, ch;
                    byte[] data = ScreenCapture.CaptureFullScreenshotPng(out cw, out ch);
                    return new { Bytes = data, Width = cw, Height = ch };
                }).ConfigureAwait(false);
                byte[] png = captured.Bytes;
                int w = captured.Width;
                int h = captured.Height;
                string ts = DateTime.UtcNow.ToString("o");
                var meta = new Dictionary<string, object>
                {
                    { "type", "capture.result.binary" },
                    { "requestId", requestId },
                    { "capturedPage", new Dictionary<string, object>
                        {
                            { "tab", new Dictionary<string, object> { { "url", "" }, { "title", "Native desktop capture" } } },
                            { "mimeType", "image/png" },
                            { "fileName", "native-capture-" + ts.Replace(":", "-").Replace(".", "-") + ".png" },
                            { "capturedAt", ts },
                            { "widthCssPx", w },
                            { "heightCssPx", h },
                            { "scale", 1 },
                        }
                    },
                };
                byte[] envelope = WireProtocol.BuildBinaryEnvelope(meta, png);
                await SendRaw(ws, envelope, WebSocketMessageType.Binary, token).ConfigureAwait(false);
                Logger.Log("agent", "sent capture result", new { requestId, bytes = png.Length, w, h });
                return;
            }
            catch (Exception ex) { errorMessage = ex.Message; }
            await SendJson(ws, new Dictionary<string, object>
            {
                { "type", "capture.error" },
                { "requestId", requestId },
                { "message", errorMessage },
            }, token);
        }

        private static async Task HandleInput(ClientWebSocket ws, IDictionary<string, object> p, CancellationToken token)
        {
            string requestId = p.ContainsKey("requestId") ? Convert.ToString(p["requestId"]) : "";
            InputDispatcher.DispatchResult r = null;
            string errorMessage = null;
            try { r = await Task.Run(() => InputDispatcher.DispatchInput(p)).ConfigureAwait(false); }
            catch (Exception ex) { errorMessage = ex.Message ?? "OS input dispatch failed."; }
            if (errorMessage != null)
            {
                await SendJson(ws, new Dictionary<string, object>
                {
                    { "type", "screen-share.input-error" },
                    { "requestId", requestId },
                    { "message", errorMessage },
                }, token);
                return;
            }
            await SendJson(ws, new Dictionary<string, object>
            {
                { "type", "screen-share.input-result" },
                { "requestId", requestId },
                { "message", r.Message },
                { "targetDescription", r.TargetDescription },
                { "viewportWidth", r.ViewportWidth },
                { "viewportHeight", r.ViewportHeight },
            }, token);
        }

        private static async Task HandleKey(ClientWebSocket ws, IDictionary<string, object> p, CancellationToken token)
        {
            string requestId = p.ContainsKey("requestId") ? Convert.ToString(p["requestId"]) : "";
            InputDispatcher.KeyResult r = null;
            string errorMessage = null;
            try { r = await Task.Run(() => InputDispatcher.DispatchKey(p)).ConfigureAwait(false); }
            catch (Exception ex) { errorMessage = ex.Message ?? "OS key dispatch failed."; }
            if (errorMessage != null)
            {
                await SendJson(ws, new Dictionary<string, object>
                {
                    { "type", "screen-share.key-error" },
                    { "requestId", requestId },
                    { "message", errorMessage },
                }, token);
                return;
            }
            await SendJson(ws, new Dictionary<string, object>
            {
                { "type", "screen-share.key-result" },
                { "requestId", requestId },
                { "message", r.Message },
                { "targetDescription", r.TargetDescription },
            }, token);
        }

        private static async Task HandleStreamStart(ClientWebSocket ws, IDictionary<string, object> p,
            ScreenStreamService stream, CancellationToken token)
        {
            string requestId = p.ContainsKey("requestId") ? Convert.ToString(p["requestId"]) : "";
            string errorMessage = null;
            try
            {
                stream.Start((bytes, sendToken) => SendRaw(ws, bytes, WebSocketMessageType.Binary, sendToken));
            }
            catch (Exception ex) { errorMessage = ex.Message ?? "Failed to start screen capture."; }
            if (errorMessage != null)
            {
                await SendJson(ws, new Dictionary<string, object>
                {
                    { "type", "screen-share.error" },
                    { "requestId", requestId },
                    { "message", errorMessage },
                }, token);
                return;
            }
            await SendJson(ws, new Dictionary<string, object>
            {
                { "type", "screen-share.result" },
                { "requestId", requestId },
                { "status", new Dictionary<string, object>
                    {
                        { "state", "streaming" },
                        { "active", true },
                        { "viewerWindowId", null },
                        { "sourceLabel", stream.SourceLabel },
                        { "updatedAt", DateTime.UtcNow.ToString("o") },
                        { "message", "Native client streaming desktop (" + stream.Width + "x" + stream.Height + ")." },
                    }
                },
            }, token);
        }

        private static async Task HandleStreamStop(ClientWebSocket ws, IDictionary<string, object> p,
            ScreenStreamService stream, CancellationToken token)
        {
            string requestId = p.ContainsKey("requestId") ? Convert.ToString(p["requestId"]) : "";
            try { stream.Stop(); } catch (Exception ex) { Logger.Log("agent", "stream.Stop failed", new { error = ex.Message }); }
            await SendJson(ws, new Dictionary<string, object>
            {
                { "type", "screen-share.stop-result" },
                { "requestId", requestId },
                { "status", new Dictionary<string, object>
                    {
                        { "state", "idle" },
                        { "active", false },
                        { "viewerWindowId", null },
                        { "sourceLabel", null },
                        { "updatedAt", DateTime.UtcNow.ToString("o") },
                        { "message", "Native screen share stopped." },
                    }
                },
            }, token);
        }

        private static async Task HandleNativePopupShow(ClientWebSocket ws, IDictionary<string, object> p, CancellationToken token)
        {
            string requestId = p.ContainsKey("requestId") ? Convert.ToString(p["requestId"]) : "";
            string text = p.ContainsKey("text") ? Convert.ToString(p["text"]) : "";
            IDictionary<string, object> response;
            try
            {
                var status = await _nativePopup.ShowAsync(text).ConfigureAwait(false);
                response = new Dictionary<string, object>
                {
                    { "type", "popup.result" },
                    { "requestId", requestId },
                    { "action", status.ContainsKey("action") ? status["action"] : "updated" },
                    { "status", status },
                };
            }
            catch (Exception ex)
            {
                response = new Dictionary<string, object>
                {
                    { "type", "popup.error" },
                    { "requestId", requestId },
                    { "message", ex.Message },
                };
            }
            await SendJson(ws, response, token);
        }

        private static async Task HandleNativePopupFileUpload(ClientWebSocket ws, IDictionary<string, object> metadata, byte[] payload, CancellationToken token)
        {
            string requestId = metadata.ContainsKey("requestId") ? Convert.ToString(metadata["requestId"]) : "";
            IDictionary<string, object> response;
            try
            {
                string fileName = metadata.ContainsKey("fileName") ? Convert.ToString(metadata["fileName"]) : "shared-file.bin";
                string mimeType = metadata.ContainsKey("mimeType") ? Convert.ToString(metadata["mimeType"]) : "application/octet-stream";
                var result = await _nativePopup.ReceiveFileAsync(fileName, mimeType, payload).ConfigureAwait(false);
                result["requestId"] = requestId;
                response = result;
            }
            catch (Exception ex)
            {
                response = new Dictionary<string, object>
                {
                    { "type", "file-transfer.error" },
                    { "requestId", requestId },
                    { "message", ex.Message },
                };
            }
            await SendJson(ws, response, token);
        }

        private static Task SendJson(ClientWebSocket ws, IDictionary<string, object> obj, CancellationToken token)
        {
            byte[] data = Encoding.UTF8.GetBytes(WireProtocol.SerializeJson(obj));
            return SendRaw(ws, data, WebSocketMessageType.Text, token);
        }

        private static Task SendBinary(ClientWebSocket ws, IDictionary<string, object> metadata, byte[] payload, CancellationToken token)
        {
            byte[] data = WireProtocol.BuildBinaryEnvelope(metadata, payload);
            return SendRaw(ws, data, WebSocketMessageType.Binary, token);
        }

        private static async Task SendRaw(
            ClientWebSocket ws,
            byte[] data,
            WebSocketMessageType messageType,
            CancellationToken token)
        {
            await _sendGate.WaitAsync(token).ConfigureAwait(false);
            try
            {
                if (ws == null || ws.State != WebSocketState.Open)
                    throw new WebSocketException("Websocket is not open.");
                await ws.SendAsync(new ArraySegment<byte>(data), messageType, true, token).ConfigureAwait(false);
            }
            finally
            {
                _sendGate.Release();
            }
        }
    }
}
