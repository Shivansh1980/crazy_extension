// Screen capture (GDI BitBlt + System.Drawing PNG/JPEG encoding) and a simple streaming service.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace PageSignal.NativeAgent
{
    internal static class ScreenCapture
    {
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;

        public static void GetPrimarySize(out int w, out int h)
        {
            w = GetSystemMetrics(SM_CXSCREEN);
            h = GetSystemMetrics(SM_CYSCREEN);
            if (w <= 0 || h <= 0) { w = 1920; h = 1080; }
        }

        public static byte[] CaptureFullScreenshotPng(out int width, out int height)
        {
            GetPrimarySize(out width, out height);
            using (var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(0, 0, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                }
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    return ms.ToArray();
                }
            }
        }

        public static byte[] CaptureFullScreenshotJpeg(int quality, int maxWidth, out int width, out int height)
        {
            int sw, sh;
            GetPrimarySize(out sw, out sh);

            using (var bmp = new Bitmap(sw, sh, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(0, 0, 0, 0, new Size(sw, sh), CopyPixelOperation.SourceCopy);
                }

                Bitmap toEncode = bmp;
                bool ownsScaled = false;
                if (maxWidth > 0 && sw > maxWidth)
                {
                    int newW = maxWidth;
                    int newH = (int)Math.Round(sh * (maxWidth / (double)sw));
                    var scaled = new Bitmap(newW, newH, PixelFormat.Format24bppRgb);
                    using (var g2 = Graphics.FromImage(scaled))
                    {
                        g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g2.DrawImage(bmp, 0, 0, newW, newH);
                    }
                    toEncode = scaled;
                    ownsScaled = true;
                }

                width = toEncode.Width;
                height = toEncode.Height;

                try
                {
                    using (var ms = new MemoryStream())
                    {
                        var encoder = GetJpegEncoder();
                        var p = new EncoderParameters(1);
                        p.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
                        toEncode.Save(ms, encoder, p);
                        return ms.ToArray();
                    }
                }
                finally
                {
                    if (ownsScaled) toEncode.Dispose();
                }
            }
        }

        private static ImageCodecInfo _jpegCodec;
        private static ImageCodecInfo GetJpegEncoder()
        {
            if (_jpegCodec != null) return _jpegCodec;
            foreach (var c in ImageCodecInfo.GetImageEncoders())
            {
                if (c.FormatID == ImageFormat.Jpeg.Guid) { _jpegCodec = c; return c; }
            }
            throw new InvalidOperationException("JPEG encoder not found.");
        }
    }

    internal sealed class ScreenStreamService
    {
        private const int FPS = 10;
        private const int MAX_WIDTH = 1600;
        private const int JPEG_QUALITY = 75;
        private const string SOURCE_LABEL = "Primary display";

        private readonly object _lock = new object();
        private CancellationTokenSource _cts;
        private Task _task;
        private ClientWebSocket _ws;
        private int _sequence;

        public bool Active
        {
            get { lock (_lock) { return _task != null && !_task.IsCompleted; } }
        }

        public string SourceLabel { get { return SOURCE_LABEL; } }

        public int Width { get; private set; }
        public int Height { get; private set; }

        public void Start(ClientWebSocket ws)
        {
            lock (_lock)
            {
                if (_task != null && !_task.IsCompleted) return;
                int w, h;
                ScreenCapture.GetPrimarySize(out w, out h);
                Width = Math.Min(w, MAX_WIDTH);
                Height = (int)Math.Round(h * (Width / (double)w));
                _ws = ws;
                _sequence = 0;
                _cts = new CancellationTokenSource();
                var token = _cts.Token;
                _task = Task.Run(() => Loop(token));
            }
        }

        public void Stop()
        {
            CancellationTokenSource cts;
            Task task;
            lock (_lock) { cts = _cts; task = _task; _cts = null; _task = null; _ws = null; }
            if (cts != null) try { cts.Cancel(); } catch { }
            if (task != null) try { task.Wait(2000); } catch { }
        }

        private async Task Loop(CancellationToken token)
        {
            int intervalMs = 1000 / FPS;
            while (!token.IsCancellationRequested)
            {
                long started = Environment.TickCount;
                try
                {
                    await CaptureAndSendAsync(token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    Logger.Log("screen-stream", "frame failed: " + ex.Message);
                }
                int elapsed = Environment.TickCount - (int)started;
                int sleep = intervalMs - elapsed;
                if (sleep > 0)
                {
                    try { await Task.Delay(sleep, token).ConfigureAwait(false); }
                    catch (TaskCanceledException) { break; }
                }
            }
        }

        private async Task CaptureAndSendAsync(CancellationToken token)
        {
            ClientWebSocket ws;
            lock (_lock) { ws = _ws; }
            if (ws == null || ws.State != WebSocketState.Open) return;

            int w, h;
            byte[] jpeg = ScreenCapture.CaptureFullScreenshotJpeg(JPEG_QUALITY, MAX_WIDTH, out w, out h);
            _sequence++;
            int sw, sh;
            ScreenCapture.GetPrimarySize(out sw, out sh);

            var meta = new System.Collections.Generic.Dictionary<string, object>
            {
                { "type", "screen-share.frame.binary" },
                { "sequence", _sequence },
                { "capturedAt", DateTime.UtcNow.ToString("o") },
                { "mimeType", "image/jpeg" },
                { "width", w }, { "height", h },
                { "frameWidth", w }, { "frameHeight", h },
                { "offsetX", 0 }, { "offsetY", 0 },
                { "partial", false },
                { "sourceWidth", sw }, { "sourceHeight", sh },
                { "sourceLabel", SOURCE_LABEL },
            };
            byte[] envelope = WireProtocol.BuildBinaryEnvelope(meta, jpeg);
            await ws.SendAsync(new ArraySegment<byte>(envelope), WebSocketMessageType.Binary, true, token)
                .ConfigureAwait(false);
        }
    }
}
