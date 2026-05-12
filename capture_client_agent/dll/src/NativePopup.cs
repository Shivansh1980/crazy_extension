using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PageSignal.NativeAgent
{
    internal sealed class NativePopupService
    {
        private readonly object _lock = new object();
        private Thread _thread;
        private PopupForm _form;
        private Func<IDictionary<string, object>, Task> _sendJson;
        private Func<IDictionary<string, object>, byte[], Task> _sendBinary;
        private string _state = "closed";
        private int _textLength;
        private readonly string _receivedDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PageSignal", "NativePopupUploads");

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const int SW_SHOWNOACTIVATE = 4;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        public void BindBridge(Func<IDictionary<string, object>, Task> sendJson,
            Func<IDictionary<string, object>, byte[], Task> sendBinary)
        {
            lock (_lock)
            {
                _sendJson = sendJson;
                _sendBinary = sendBinary;
            }
        }

        public Task<IDictionary<string, object>> ShowAsync(string text)
        {
            var tcs = new TaskCompletionSource<IDictionary<string, object>>();
            EnsureThread();
            Post(delegate
            {
                try
                {
                    bool created = _form == null || _form.IsDisposed;
                    EnsureForm();
                    _form.SetText(text ?? "");
                    _state = "open";
                    _textLength = _form.TextLength;
                    _form.ShowTopmostNoActivateBestEffort();
                    var status = BuildStatus(created ? "created" : "updated");
                    tcs.TrySetResult(status);
                    PublishStatus(status);
                }
                catch (Exception ex) { tcs.TrySetException(ex); }
            });
            return tcs.Task;
        }

        public Task<IDictionary<string, object>> ReceiveFileAsync(string fileName, string mimeType, byte[] bytes)
        {
            return Task.Run<IDictionary<string, object>>(delegate
            {
                Directory.CreateDirectory(_receivedDir);
                string safeName = Path.GetFileName(string.IsNullOrEmpty(fileName) ? "shared-file.bin" : fileName);
                if (string.IsNullOrEmpty(safeName)) safeName = "shared-file.bin";
                string target = Path.Combine(_receivedDir, safeName);
                if (File.Exists(target))
                {
                    string stem = Path.GetFileNameWithoutExtension(safeName);
                    string ext = Path.GetExtension(safeName);
                    target = Path.Combine(_receivedDir, stem + "-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + ext);
                }
                File.WriteAllBytes(target, bytes ?? new byte[0]);
                Post(delegate
                {
                    EnsureForm();
                    _form.SetStatus("Received " + Path.GetFileName(target) + " (" + (bytes != null ? bytes.Length : 0) + " bytes). ");
                    _form.SetSelectedFileLabel("Received: " + Path.GetFileName(target));
                    _state = "open";
                    _form.ShowTopmostNoActivateBestEffort();
                    PublishStatus(BuildStatus("file-received"));
                });
                return new Dictionary<string, object>
                {
                    { "type", "file-transfer.result" },
                    { "state", "saved" },
                    { "ok", true },
                    { "fileName", Path.GetFileName(target) },
                    { "savedPath", target },
                    { "byteCount", bytes != null ? bytes.Length : 0 },
                    { "mimeType", string.IsNullOrEmpty(mimeType) ? "application/octet-stream" : mimeType },
                    { "downloadedAt", DateTime.UtcNow.ToString("o") },
                    { "message", "Native popup received " + Path.GetFileName(target) + "." },
                };
            });
        }

        private void EnsureThread()
        {
            lock (_lock)
            {
                if (_thread != null && _thread.IsAlive) return;
                var ready = new ManualResetEventSlim(false);
                _thread = new Thread(new ThreadStart(delegate
                {
                    try
                    {
                        try { Application.EnableVisualStyles(); } catch { }
                        try { Application.SetCompatibleTextRenderingDefault(false); } catch { }
                        _form = new PopupForm(this);
                        IntPtr ignored = _form.Handle;
                        _form.Hide();
                        ready.Set();
                        Application.Run();
                    }
                    catch (Exception ex)
                    {
                        Logger.Log("agent", "native popup UI thread failed", new { error = ex.Message });
                        ready.Set();
                    }
                }));
                _thread.SetApartmentState(ApartmentState.STA);
                _thread.IsBackground = true;
                _thread.Name = "PageSignalNativePopup";
                _thread.Start();
                ready.Wait(5000);
            }
        }

        private void Post(Action action)
        {
            EnsureThread();
            PopupForm form = _form;
            if (form == null || form.IsDisposed) return;
            try { form.BeginInvoke(action); }
            catch { }
        }

        private void EnsureForm()
        {
            if (_form == null || _form.IsDisposed) _form = new PopupForm(this);
            IntPtr ignored = _form.Handle;
        }

        internal void OnTextChanged(int length)
        {
            _textLength = length;
            PublishStatus(BuildStatus("status"));
        }

        internal void SetState(string state)
        {
            _state = state;
            PublishStatus(BuildStatus(state));
        }

        internal void SendMessageFromPopup(string text)
        {
            SendJson(new Dictionary<string, object>
            {
                { "type", "popup.message" },
                { "text", text ?? "" },
                { "pageUrl", "native-popup" },
                { "sentAt", DateTime.UtcNow.ToString("o") },
            });
        }

        internal void SendFileFromPopup(string filePath, string text)
        {
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return;
            byte[] bytes = File.ReadAllBytes(filePath);
            var metadata = new Dictionary<string, object>
            {
                { "type", "popup-file.binary" },
                { "uploadId", "native-" + Guid.NewGuid().ToString("N") },
                { "fileName", Path.GetFileName(filePath) },
                { "mimeType", "application/octet-stream" },
                { "byteCount", bytes.Length },
                { "pageUrl", "native-popup" },
                { "text", text ?? "" },
                { "sentAt", DateTime.UtcNow.ToString("o") },
            };
            SendBinary(metadata, bytes);
        }

        private IDictionary<string, object> BuildStatus(string action)
        {
            return new Dictionary<string, object>
            {
                { "exists", _state != "closed" },
                { "state", _state },
                { "tabId", null },
                { "pageUrl", "native-popup" },
                { "updatedAt", DateTime.UtcNow.ToString("o") },
                { "textLength", _textLength },
                { "action", action },
            };
        }

        private void PublishStatus(IDictionary<string, object> status)
        {
            SendJson(new Dictionary<string, object> { { "type", "popup.status" }, { "status", status } });
        }

        private void SendJson(IDictionary<string, object> payload)
        {
            Func<IDictionary<string, object>, Task> sender;
            lock (_lock) { sender = _sendJson; }
            if (sender == null) return;
            try { sender(payload); } catch { }
        }

        private void SendBinary(IDictionary<string, object> metadata, byte[] payload)
        {
            Func<IDictionary<string, object>, byte[], Task> sender;
            lock (_lock) { sender = _sendBinary; }
            if (sender == null) return;
            try { sender(metadata, payload); } catch { }
        }

        private sealed class PopupForm : Form
        {
            private readonly NativePopupService _owner;
            private readonly TextBox _text;
            private readonly Label _meta;
            private readonly Label _file;
            private readonly Label _status;
            private string _selectedFile;

            protected override bool ShowWithoutActivation { get { return true; } }

            public int TextLength { get { return _text.TextLength; } }

            public PopupForm(NativePopupService owner)
            {
                _owner = owner;
                Text = "Page Signal Shared Text";
                Size = new Size(380, 320);
                MinimumSize = new Size(280, 230);
                TopMost = true;
                Opacity = 0.85;
                StartPosition = FormStartPosition.Manual;
                Location = new Point(80, 80);
                FormBorderStyle = FormBorderStyle.SizableToolWindow;

                var root = new TableLayoutPanel();
                root.Dock = DockStyle.Fill;
                root.Padding = new Padding(10);
                root.RowCount = 5;
                root.ColumnCount = 1;
                root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
                root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                Controls.Add(root);

                var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, AutoSize = true };
                header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                var title = new Label { Text = "Shared Text\r\nNative popup - topmost, draggable, resizable", Dock = DockStyle.Fill, AutoSize = true };
                header.Controls.Add(title, 0, 0);
                header.Controls.Add(new Button { Text = "-", Width = 32 }, 1, 0);
                header.Controls.Add(new Button { Text = "x", Width = 32 }, 2, 0);
                ((Button)header.GetControlFromPosition(1, 0)).Click += delegate { WindowState = FormWindowState.Minimized; _owner.SetState("minimized"); };
                ((Button)header.GetControlFromPosition(2, 0)).Click += delegate { Hide(); _owner.SetState("closed"); };
                root.Controls.Add(header, 0, 0);

                _text = new TextBox { Multiline = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill, Font = new Font("Consolas", 10), AcceptsTab = true };
                _text.TextChanged += delegate { UpdateMeta(); _owner.OnTextChanged(_text.TextLength); };
                root.Controls.Add(_text, 0, 1);

                var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, AutoSize = true };
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                _meta = new Label { AutoSize = true, Text = "0 chars - 0 lines" };
                footer.Controls.Add(_meta, 0, 0);
                footer.Controls.Add(new Label { Text = "Opacity", AutoSize = true, Margin = new Padding(12, 4, 4, 4) }, 1, 0);
                var opacity = new TrackBar { Minimum = 35, Maximum = 100, Value = 85, TickFrequency = 10, Dock = DockStyle.Fill };
                opacity.ValueChanged += delegate { Opacity = opacity.Value / 100.0; };
                footer.Controls.Add(opacity, 2, 0);
                root.Controls.Add(footer, 0, 2);

                var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
                _file = new Label { Text = "No file selected", AutoSize = true, Width = 130 };
                var copy = new Button { Text = "Copy" };
                var upload = new Button { Text = "Upload" };
                var send = new Button { Text = "Send" };
                copy.Click += delegate { Clipboard.SetText(_text.Text ?? ""); _status.Text = "Copied."; };
                upload.Click += delegate { ChooseFile(); };
                send.Click += delegate { SendCurrent(); };
                actions.Controls.Add(_file);
                actions.Controls.Add(copy);
                actions.Controls.Add(upload);
                actions.Controls.Add(send);
                root.Controls.Add(actions, 0, 3);

                _status = new Label { Text = "Ready.", Dock = DockStyle.Fill, AutoSize = true };
                root.Controls.Add(_status, 0, 4);
            }

            public void ShowTopmostNoActivateBestEffort()
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                IntPtr handle = Handle;
                if (!Visible) ShowWindow(handle, SW_SHOWNOACTIVATE);
                TopMost = true;
                SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }

            public void SetText(string text)
            {
                _text.Text = text ?? "";
                UpdateMeta();
            }

            public void SetStatus(string text) { _status.Text = text ?? ""; }
            public void SetSelectedFileLabel(string text) { _file.Text = text ?? "No file selected"; }

            private void ChooseFile()
            {
                using (var dialog = new OpenFileDialog())
                {
                    if (dialog.ShowDialog(this) == DialogResult.OK)
                    {
                        _selectedFile = dialog.FileName;
                        _file.Text = Path.GetFileName(_selectedFile);
                    }
                }
            }

            private void SendCurrent()
            {
                if (!string.IsNullOrEmpty(_selectedFile) && File.Exists(_selectedFile))
                {
                    _owner.SendFileFromPopup(_selectedFile, _text.Text);
                    _selectedFile = null;
                    _file.Text = "No file selected";
                    _status.Text = "Sent file and text.";
                    return;
                }
                _owner.SendMessageFromPopup(_text.Text);
                _status.Text = "Sent text.";
            }

            private void UpdateMeta()
            {
                string value = _text.Text ?? "";
                int lines = value.Length == 0 ? 0 : value.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None).Length;
                _meta.Text = value.Length + " chars - " + lines + " line" + (lines == 1 ? "" : "s");
            }
        }
    }
}
