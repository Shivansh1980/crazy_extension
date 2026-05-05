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
        [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")] private static extern bool BitBlt(
            IntPtr hdcDest, int xDest, int yDest, int wDest, int hDest,
            IntPtr hdcSrc, int xSrc, int ySrc, uint rop);

        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;
        // CAPTUREBLT (0x40000000) tells BitBlt to include layered windows in the
        // capture. Without it, modern transparent / topmost windows (notification
        // toasts, tooltips, some IME popups) come back missing. Combined with
        // SRCCOPY (0x00CC0020) this matches the behavior of the Win+PrtSc path.
        private const uint SRCCOPY = 0x00CC0020;
        private const uint CAPTUREBLT = 0x40000000;
        private const uint SCREEN_BLT_FLAGS = SRCCOPY | CAPTUREBLT;

        // A frame is treated as "all black" \u2014 the classic GDI-vs-HW-acceleration
        // failure mode \u2014 if it has zero non-near-black pixels in a small sample.
        // We use this to log a warning so operators know the capture stack is
        // hitting a protected / GPU-only window rather than silently shipping a
        // black frame to the dashboard.
        private const int BLACK_PIXEL_THRESHOLD = 8;
        private const int BLACK_FRAME_SAMPLE_STRIDE = 64;

        public static void GetPrimarySize(out int w, out int h)
        {
            w = GetSystemMetrics(SM_CXSCREEN);
            h = GetSystemMetrics(SM_CYSCREEN);
            if (w <= 0 || h <= 0) { w = 1920; h = 1080; }
        }

        /// <summary>
        /// Capture the primary screen into a freshly-allocated Bitmap using GDI
        /// BitBlt with the CAPTUREBLT flag. Caller owns the Bitmap.
        /// </summary>
        private static Bitmap CapturePrimaryBitmap(out bool looksBlack)
        {
            int w, h;
            GetPrimarySize(out w, out h);
            var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            bool blitOk = false;
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdcDst = IntPtr.Zero;
                IntPtr hdcSrc = IntPtr.Zero;
                try
                {
                    hdcDst = g.GetHdc();
                    hdcSrc = GetDC(IntPtr.Zero);
                    if (hdcSrc != IntPtr.Zero && hdcDst != IntPtr.Zero)
                    {
                        blitOk = BitBlt(hdcDst, 0, 0, w, h, hdcSrc, 0, 0, SCREEN_BLT_FLAGS);
                    }
                }
                catch
                {
                    blitOk = false;
                }
                finally
                {
                    if (hdcSrc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, hdcSrc);
                    if (hdcDst != IntPtr.Zero) g.ReleaseHdc(hdcDst);
                }

                if (!blitOk)
                {
                    // Fallback: GDI+ CopyFromScreen (no CAPTUREBLT, but still
                    // covers the common case). Better than a blank frame.
                    g.CopyFromScreen(0, 0, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                }
            }

            looksBlack = LooksAllBlack(bmp);
            if (looksBlack)
            {
                Logger.Log(
                    "screen-capture",
                    "Captured frame looks all-black; foreground content is likely hardware-accelerated " +
                    "or protected (DRM / WDA_EXCLUDEFROMCAPTURE). Install the Python agent for DXGI " +
                    "Desktop Duplication coverage.");
            }
            return bmp;
        }

        private static bool LooksAllBlack(Bitmap bmp)
        {
            // Sample a sparse grid (cheap: <2k reads even at 4K) and look for
            // any pixel with R+G+B above the threshold.
            int w = bmp.Width, h = bmp.Height;
            if (w < 4 || h < 4) return false;
            BitmapData data = null;
            try
            {
                data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                int stride = data.Stride;
                IntPtr scan0 = data.Scan0;
                unsafe
                {
                    byte* p = (byte*)scan0.ToPointer();
                    for (int y = 0; y < h; y += BLACK_FRAME_SAMPLE_STRIDE)
                    {
                        byte* row = p + y * stride;
                        for (int x = 0; x < w; x += BLACK_FRAME_SAMPLE_STRIDE)
                        {
                            byte* px = row + x * 3;
                            if (px[0] > BLACK_PIXEL_THRESHOLD ||
                                px[1] > BLACK_PIXEL_THRESHOLD ||
                                px[2] > BLACK_PIXEL_THRESHOLD)
                            {
                                return false;
                            }
                        }
                    }
                }
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (data != null) bmp.UnlockBits(data);
            }
        }

        public static byte[] CaptureFullScreenshotPng(out int width, out int height)
        {
            bool _;
            using (var bmp = CapturePrimaryBitmap(out _))
            {
                width = bmp.Width;
                height = bmp.Height;
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    return ms.ToArray();
                }
            }
        }

        public static byte[] CaptureFullScreenshotJpeg(int quality, int maxWidth, out int width, out int height)
        {
            bool _;
            using (var bmp = CapturePrimaryBitmap(out _))
            {
                int sw = bmp.Width, sh = bmp.Height;

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
