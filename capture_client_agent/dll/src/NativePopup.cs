using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PageSignal.NativeAgent
{
    internal sealed class NativePopupService
    {
        private readonly object _gate = new object();
        private readonly ManualResetEventSlim _ready = new ManualResetEventSlim(false);
        private readonly Thread _uiThread;
        private Control _dispatcher;
        private NativePopupForm _form;
        private Func<IDictionary<string, object>, Task> _jsonSender;
        private Func<IDictionary<string, object>, byte[], Task> _binarySender;

        public NativePopupService()
        {
            _uiThread = new Thread(RunUi);
            _uiThread.IsBackground = true;
            _uiThread.Name = "PageSignalNativePopup";
            _uiThread.SetApartmentState(ApartmentState.STA);
            _uiThread.Start();
            if (!_ready.Wait(TimeSpan.FromSeconds(5)))
                throw new InvalidOperationException("Native popup UI thread did not start within five seconds.");
        }

        public void BindBridge(
            Func<IDictionary<string, object>, Task> jsonSender,
            Func<IDictionary<string, object>, byte[], Task> binarySender)
        {
            lock (_gate)
            {
                _jsonSender = jsonSender;
                _binarySender = binarySender;
            }
        }

        public void UnbindBridge()
        {
            lock (_gate)
            {
                _jsonSender = null;
                _binarySender = null;
            }
        }

        public Task<IDictionary<string, object>> ShowAsync(string text)
        {
            var completion = new TaskCompletionSource<IDictionary<string, object>>();
            Post(delegate
            {
                try
                {
                    bool created = _form == null;
                    EnsureForm();
                    _form.ShowText(text ?? string.Empty);
                    IDictionary<string, object> status = _form.BuildStatus(created ? "created" : "updated");
                    completion.SetResult(status);
                    PublishStatus(status);
                }
                catch (Exception ex)
                {
                    completion.SetException(ex);
                }
            });
            return completion.Task;
        }

        public async Task<IDictionary<string, object>> ReceiveFileAsync(
            string fileName,
            string mimeType,
            byte[] payload)
        {
            if (payload == null) payload = new byte[0];
            string savedPath = await Task.Run(() => SaveReceivedFile(fileName, payload)).ConfigureAwait(false);
            var shown = new TaskCompletionSource<bool>();
            Post(delegate
            {
                try
                {
                    EnsureForm();
                    _form.ShowReceivedFile(Path.GetFileName(savedPath), payload.Length);
                    PublishStatus(_form.BuildStatus("file-received"));
                    shown.SetResult(true);
                }
                catch (Exception ex)
                {
                    shown.SetException(ex);
                }
            });
            await shown.Task.ConfigureAwait(false);

            return new Dictionary<string, object>
            {
                { "type", "file-transfer.result" },
                { "state", "saved" },
                { "ok", true },
                { "fileName", Path.GetFileName(savedPath) },
                { "savedPath", savedPath },
                { "byteCount", payload.Length },
                { "mimeType", string.IsNullOrWhiteSpace(mimeType) ? "application/octet-stream" : mimeType },
                { "downloadedAt", DateTime.UtcNow.ToString("o") },
                { "message", "Native popup received " + Path.GetFileName(savedPath) + "." },
            };
        }

        private void RunUi()
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                _dispatcher = new Control();
                _dispatcher.CreateControl();
                _ready.Set();
                Application.Run();
            }
            catch (Exception ex)
            {
                Logger.Log("native-popup", "UI thread failed", new { error = ex.ToString() });
                _ready.Set();
            }
        }

        private void Post(Action action)
        {
            if (!_ready.Wait(TimeSpan.FromSeconds(5)) || _dispatcher == null || _dispatcher.IsDisposed)
                throw new InvalidOperationException("Native popup UI is unavailable.");
            _dispatcher.BeginInvoke(action);
        }

        private void EnsureForm()
        {
            if (_form != null && !_form.IsDisposed) return;
            _form = new NativePopupForm();
            _form.StatusChanged += PublishStatus;
            _form.SendRequested += SendFromPopup;
        }

        private void PublishStatus(IDictionary<string, object> status)
        {
            Func<IDictionary<string, object>, Task> sender;
            lock (_gate) sender = _jsonSender;
            if (sender == null) return;
            FireAndForget(sender(new Dictionary<string, object>
            {
                { "type", "popup.status" },
                { "status", status },
            }));
        }

        private bool SendFromPopup(string text, string selectedPath)
        {
            if (string.IsNullOrEmpty(selectedPath))
            {
                Func<IDictionary<string, object>, Task> jsonSender;
                lock (_gate) jsonSender = _jsonSender;
                if (jsonSender == null) return false;
                try
                {
                    TrackSend(jsonSender(new Dictionary<string, object>
                    {
                        { "type", "popup.message" },
                        { "text", text ?? string.Empty },
                        { "pageUrl", "native-popup" },
                        { "tabId", null },
                        { "sentAt", DateTime.UtcNow.ToString("o") },
                    }), "Sent text.");
                    return true;
                }
                catch (Exception ex)
                {
                    Logger.Log("native-popup", "Bridge send could not start", new { error = ex.Message });
                    return false;
                }
            }

            Func<IDictionary<string, object>, byte[], Task> binarySender;
            lock (_gate) binarySender = _binarySender;
            if (binarySender == null) return false;
            TrackSend(Task.Run(async delegate
            {
                byte[] bytes = File.ReadAllBytes(selectedPath);
                var metadata = new Dictionary<string, object>
                {
                    { "type", "popup-file.binary" },
                    { "uploadId", "native-" + Guid.NewGuid().ToString("N") },
                    { "fileName", Path.GetFileName(selectedPath) },
                    { "mimeType", MimeTypeFor(selectedPath) },
                    { "byteCount", bytes.Length },
                    { "pageUrl", "native-popup" },
                    { "tabId", null },
                    { "text", text ?? string.Empty },
                    { "sentAt", DateTime.UtcNow.ToString("o") },
                };
                await binarySender(metadata, bytes).ConfigureAwait(false);
            }), "Sent file and text.");
            return true;
        }

        private void TrackSend(Task task, string successMessage)
        {
            task.ContinueWith(completed =>
            {
                string message = successMessage;
                if (completed.IsCanceled) message = "Send cancelled while reconnecting.";
                if (completed.IsFaulted)
                {
                    message = "Send failed: " + completed.Exception.GetBaseException().Message;
                    Logger.Log("native-popup", "Bridge send failed", new { error = completed.Exception.ToString() });
                }
                try { Post(delegate { if (_form != null && !_form.IsDisposed) _form.SetTransportStatus(message); }); }
                catch { }
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
        }

        private static void FireAndForget(Task task)
        {
            if (task == null) return;
            task.ContinueWith(
                failed => Logger.Log("native-popup", "Bridge send failed", new { error = failed.Exception.ToString() }),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
        }

        private static string SaveReceivedFile(string fileName, byte[] payload)
        {
            string safeName = Path.GetFileName(string.IsNullOrWhiteSpace(fileName) ? "shared-file.bin" : fileName);
            if (string.IsNullOrWhiteSpace(safeName)) safeName = "shared-file.bin";
            string directory = Path.Combine(Environment.CurrentDirectory, "client_uploads", "native_popup");
            try
            {
                Directory.CreateDirectory(directory);
            }
            catch
            {
                directory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "PageSignalCapture",
                    "client_uploads",
                    "native_popup");
                Directory.CreateDirectory(directory);
            }

            string target = Path.Combine(directory, safeName);
            if (File.Exists(target))
            {
                string stem = Path.GetFileNameWithoutExtension(safeName);
                string extension = Path.GetExtension(safeName);
                target = Path.Combine(directory, stem + "-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmssfff") + extension);
            }
            File.WriteAllBytes(target, payload);
            return target;
        }

        private static string MimeTypeFor(string path)
        {
            string extension = Path.GetExtension(path).ToLowerInvariant();
            if (extension == ".txt" || extension == ".log" || extension == ".md") return "text/plain";
            if (extension == ".json") return "application/json";
            if (extension == ".png") return "image/png";
            if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
            if (extension == ".pdf") return "application/pdf";
            return "application/octet-stream";
        }
    }

    internal sealed class NativePopupForm : Form
    {
        private const int VK_SHIFT = 0x10;
        private const int VK_ALT = 0x12;
        private const int VK_P = 0x50;

        private readonly Panel _content;
        private readonly TextBox _text;
        private readonly Label _meta;
        private readonly Label _file;
        private readonly Label _status;
        private readonly Button _launcher;
        private readonly System.Windows.Forms.Timer _hotkeyTimer;
        private string _state = "closed";
        private string _selectedPath;
        private Size _normalSize = new Size(440, 360);
        private Point _normalLocation = new Point(80, 80);
        private bool _hotkeyPressed;

        public event Action<IDictionary<string, object>> StatusChanged;
        public event Func<string, string, bool> SendRequested;

        public NativePopupForm()
        {
            Text = "Page Signal Shared Text";
            StartPosition = FormStartPosition.Manual;
            Location = _normalLocation;
            Size = _normalSize;
            MinimumSize = new Size(300, 240);
            TopMost = true;
            Opacity = 0.88;
            FormClosing += OnFormClosing;

            _content = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10) };
            Controls.Add(_content);

            var header = new FlowLayoutPanel
            {
                Dock = DockStyle.Top,
                Height = 36,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
            };
            header.Controls.Add(new Label
            {
                Text = "Shared Text",
                AutoSize = true,
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                Margin = new Padding(0, 8, 12, 0),
            });
            var minimize = new Button { Text = "_", Width = 34, Height = 28 };
            minimize.Click += delegate { SetState("minimized"); };
            var close = new Button { Text = "X", Width = 34, Height = 28 };
            close.Click += delegate { SetState("closed"); };
            header.Controls.Add(minimize);
            header.Controls.Add(close);
            _content.Controls.Add(header);

            _text = new TextBox
            {
                Multiline = true,
                AcceptsTab = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Font = new Font("Consolas", 10),
                Dock = DockStyle.Fill,
            };
            _text.TextChanged += delegate { UpdateMeta(); };
            _content.Controls.Add(_text);
            _text.BringToFront();

            var footer = new TableLayoutPanel
            {
                Dock = DockStyle.Bottom,
                Height = 84,
                ColumnCount = 4,
                RowCount = 2,
            };
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _meta = new Label { AutoSize = true, Text = "0 chars - 0 lines", Dock = DockStyle.Fill };
            _file = new Label { AutoSize = true, Text = "No file selected", Dock = DockStyle.Fill };
            _status = new Label { AutoSize = true, Text = "Ready", Dock = DockStyle.Fill };
            var copy = new Button { Text = "Copy", AutoSize = true };
            copy.Click += delegate
            {
                try { Clipboard.SetText(_text.Text ?? string.Empty); _status.Text = "Copied."; }
                catch (Exception ex) { _status.Text = "Copy failed: " + ex.Message; }
            };
            var upload = new Button { Text = "File...", AutoSize = true };
            upload.Click += SelectFile;
            var send = new Button { Text = "Send", AutoSize = true };
            send.Click += SendCurrent;
            footer.Controls.Add(_meta, 0, 0);
            footer.Controls.Add(copy, 1, 0);
            footer.Controls.Add(upload, 2, 0);
            footer.Controls.Add(send, 3, 0);
            footer.Controls.Add(_file, 0, 1);
            footer.SetColumnSpan(_file, 2);
            footer.Controls.Add(_status, 2, 1);
            footer.SetColumnSpan(_status, 2);
            _content.Controls.Add(footer);

            _launcher = new Button
            {
                Text = "P",
                Dock = DockStyle.Fill,
                Font = new Font("Segoe UI", 18, FontStyle.Bold),
                Visible = false,
            };
            _launcher.Click += delegate { SetState("open"); };
            Controls.Add(_launcher);

            _hotkeyTimer = new System.Windows.Forms.Timer { Interval = 100 };
            _hotkeyTimer.Tick += PollHotkey;
            _hotkeyTimer.Start();
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        public void ShowText(string text)
        {
            _text.Text = text ?? string.Empty;
            SetState("open");
        }

        public void ShowReceivedFile(string fileName, int byteCount)
        {
            _status.Text = "Received " + fileName + " (" + byteCount + " bytes).";
            SetState("open");
        }

        public void SetTransportStatus(string message)
        {
            _status.Text = message ?? string.Empty;
        }

        public IDictionary<string, object> BuildStatus(string action)
        {
            return new Dictionary<string, object>
            {
                { "exists", _state != "closed" },
                { "state", _state },
                { "tabId", null },
                { "pageUrl", "native-popup" },
                { "updatedAt", DateTime.UtcNow.ToString("o") },
                { "textLength", (_text.Text ?? string.Empty).Length },
                { "action", action ?? "status" },
            };
        }

        private void SetState(string state)
        {
            _state = state;
            if (state == "closed")
            {
                Hide();
            }
            else if (state == "minimized")
            {
                if (Width > 100 && Height > 100)
                {
                    _normalSize = Size;
                    _normalLocation = Location;
                }
                _content.Visible = false;
                _launcher.Visible = true;
                MinimumSize = new Size(56, 56);
                Size = new Size(64, 64);
                Show();
            }
            else
            {
                _launcher.Visible = false;
                _content.Visible = true;
                MinimumSize = new Size(300, 240);
                Size = _normalSize;
                Location = _normalLocation;
                Show();
                BringToFront();
            }
            Action<IDictionary<string, object>> handler = StatusChanged;
            if (handler != null) handler(BuildStatus(state));
        }

        private void UpdateMeta()
        {
            string value = _text.Text ?? string.Empty;
            int lines = value.Length == 0 ? 0 : _text.Lines.Length;
            _meta.Text = value.Length + " chars - " + lines + " line" + (lines == 1 ? string.Empty : "s");
        }

        private void SelectFile(object sender, EventArgs args)
        {
            using (var dialog = new OpenFileDialog())
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                _selectedPath = dialog.FileName;
                _file.Text = Path.GetFileName(_selectedPath);
            }
        }

        private void SendCurrent(object sender, EventArgs args)
        {
            if (string.IsNullOrEmpty(_text.Text) && string.IsNullOrEmpty(_selectedPath))
            {
                _status.Text = "Nothing to send.";
                return;
            }
            Func<string, string, bool> handler = SendRequested;
            bool accepted = false;
            try { accepted = handler != null && handler(_text.Text ?? string.Empty, _selectedPath); }
            catch { accepted = false; }
            if (!accepted)
            {
                _status.Text = "Bridge is reconnecting. Try sending again shortly.";
                return;
            }
            _selectedPath = null;
            _file.Text = "No file selected";
            _status.Text = "Sending...";
        }

        private void OnFormClosing(object sender, FormClosingEventArgs args)
        {
            if (args.CloseReason == CloseReason.ApplicationExitCall) return;
            args.Cancel = true;
            SetState("closed");
        }

        private void PollHotkey(object sender, EventArgs args)
        {
            bool pressed = IsKeyDown(VK_SHIFT) && IsKeyDown(VK_ALT) && IsKeyDown(VK_P);
            if (pressed && !_hotkeyPressed) SetState(_state == "open" ? "minimized" : "open");
            _hotkeyPressed = pressed;
        }

        private static bool IsKeyDown(int virtualKey)
        {
            return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int virtualKey);
    }
}
