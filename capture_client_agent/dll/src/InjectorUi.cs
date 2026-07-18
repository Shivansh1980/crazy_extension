using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PageSignal.NativeAgent.InjectorUi
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args != null && args.Any(a => string.Equals(a, "--self-test", StringComparison.OrdinalIgnoreCase)))
                return ArtifactLocator.SelfTest();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InjectorForm());
            return 0;
        }
    }

    internal enum TargetArchitecture
    {
        Unknown,
        X86,
        X64,
        Arm64,
    }

    internal sealed class ProcessRecord
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public TargetArchitecture Architecture { get; set; }
        public string WindowTitle { get; set; }
        public string Session { get; set; }
        public string Started { get; set; }
        public string Path { get; set; }

        public string ArchitectureLabel
        {
            get
            {
                switch (Architecture)
                {
                    case TargetArchitecture.X86: return "x86";
                    case TargetArchitecture.X64: return "x64";
                    case TargetArchitecture.Arm64: return "ARM64";
                    default: return "Unknown";
                }
            }
        }

        public bool Matches(string filter)
        {
            if (string.IsNullOrWhiteSpace(filter)) return true;
            string needle = filter.Trim();
            return Contains(Name, needle)
                || Id.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0
                || Contains(WindowTitle, needle)
                || Contains(Path, needle)
                || Contains(ArchitectureLabel, needle);
        }

        private static bool Contains(string value, string needle)
        {
            return !string.IsNullOrEmpty(value)
                && value.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }

    internal static class ProcessCatalog
    {
        public static List<ProcessRecord> ReadAll()
        {
            var records = new List<ProcessRecord>();
            foreach (Process process in Process.GetProcesses())
            {
                try
                {
                    if (process.Id == 0) continue;
                    records.Add(Read(process));
                }
                catch
                {
                    // A process may exit between enumeration and inspection. Skip only that row.
                }
                finally
                {
                    process.Dispose();
                }
            }
            return records
                .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item.Id)
                .ToList();
        }

        private static ProcessRecord Read(Process process)
        {
            return new ProcessRecord
            {
                Id = process.Id,
                Name = Safe(() => process.ProcessName, "Unknown"),
                Architecture = ProcessInspector.Architecture(process.Id),
                WindowTitle = Safe(() => process.MainWindowTitle, string.Empty),
                Session = Safe(() => process.SessionId.ToString(), "?"),
                Started = Safe(() => process.StartTime.ToString("yyyy-MM-dd HH:mm:ss"), "Unavailable"),
                Path = ProcessInspector.ImagePath(process.Id),
            };
        }

        private static string Safe(Func<string> getter, string fallback)
        {
            try
            {
                string value = getter();
                return string.IsNullOrEmpty(value) ? fallback : value;
            }
            catch
            {
                return fallback;
            }
        }
    }

    internal static class ProcessInspector
    {
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const ushort IMAGE_FILE_MACHINE_UNKNOWN = 0x0000;
        private const ushort IMAGE_FILE_MACHINE_I386 = 0x014c;
        private const ushort IMAGE_FILE_MACHINE_AMD64 = 0x8664;
        private const ushort IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsWow64Process(IntPtr process, out bool wow64Process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(
            IntPtr process,
            int flags,
            StringBuilder fileName,
            ref int size);

        public static TargetArchitecture Architecture(int processId)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (handle == IntPtr.Zero) return TargetArchitecture.Unknown;
            try
            {
                try
                {
                    ushort processMachine;
                    ushort nativeMachine;
                    if (IsWow64Process2(handle, out processMachine, out nativeMachine))
                    {
                        ushort effectiveMachine = processMachine == IMAGE_FILE_MACHINE_UNKNOWN
                            ? nativeMachine
                            : processMachine;
                        return FromMachine(effectiveMachine);
                    }
                }
                catch (EntryPointNotFoundException)
                {
                    // IsWow64Process2 requires newer Windows. The fallback covers older releases.
                }

                bool wow64;
                if (!IsWow64Process(handle, out wow64)) return TargetArchitecture.Unknown;
                if (!Environment.Is64BitOperatingSystem) return TargetArchitecture.X86;
                return wow64 ? TargetArchitecture.X86 : TargetArchitecture.X64;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        public static string ImagePath(int processId)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (handle == IntPtr.Zero) return "Unavailable (access denied)";
            try
            {
                var buffer = new StringBuilder(32768);
                int size = buffer.Capacity;
                return QueryFullProcessImageName(handle, 0, buffer, ref size)
                    ? buffer.ToString()
                    : "Unavailable";
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private static TargetArchitecture FromMachine(ushort machine)
        {
            if (machine == IMAGE_FILE_MACHINE_I386) return TargetArchitecture.X86;
            if (machine == IMAGE_FILE_MACHINE_AMD64) return TargetArchitecture.X64;
            if (machine == IMAGE_FILE_MACHINE_ARM64) return TargetArchitecture.Arm64;
            return TargetArchitecture.Unknown;
        }
    }

    internal static class ArtifactLocator
    {
        public static string DirectoryPath
        {
            get { return Path.GetDirectoryName(typeof(ArtifactLocator).Assembly.Location); }
        }

        public static string AgentPath
        {
            get { return Path.Combine(DirectoryPath, "PageSignalAgent.dll"); }
        }

        public static string HostPath(TargetArchitecture architecture)
        {
            return Path.Combine(
                DirectoryPath,
                architecture == TargetArchitecture.X86
                    ? "PageSignalAgentHost.x86.exe"
                    : "PageSignalAgentHost.exe");
        }

        public static string BootstrapPath(TargetArchitecture architecture)
        {
            return Path.Combine(
                DirectoryPath,
                architecture == TargetArchitecture.X86
                    ? "PageSignalBootstrap.x86.dll"
                    : "PageSignalBootstrap.x64.dll");
        }

        public static string Validate(TargetArchitecture architecture)
        {
            if (architecture != TargetArchitecture.X86 && architecture != TargetArchitecture.X64)
                return "Only x86 and x64 target processes are supported.";
            if (!File.Exists(AgentPath)) return "PageSignalAgent.dll is missing from the injector folder.";
            string host = HostPath(architecture);
            if (!File.Exists(host)) return Path.GetFileName(host) + " is missing from the injector folder.";
            string bootstrap = BootstrapPath(architecture);
            if (!File.Exists(bootstrap)) return Path.GetFileName(bootstrap) + " is missing from the injector folder.";
            return null;
        }

        public static int SelfTest()
        {
            if (!File.Exists(AgentPath)) return 20;
            if (!File.Exists(HostPath(TargetArchitecture.X86))) return 21;
            if (!File.Exists(BootstrapPath(TargetArchitecture.X86))) return 22;
            if (Environment.Is64BitOperatingSystem)
            {
                if (!File.Exists(HostPath(TargetArchitecture.X64))) return 23;
                if (!File.Exists(BootstrapPath(TargetArchitecture.X64))) return 24;
            }
            TargetArchitecture current = ProcessInspector.Architecture(Process.GetCurrentProcess().Id);
            return current == TargetArchitecture.Unknown ? 25 : 0;
        }
    }

    internal sealed class InjectionResult
    {
        public int ExitCode { get; set; }
        public string Output { get; set; }
        public bool TimedOut { get; set; }

        public bool AccessDenied
        {
            get
            {
                string text = Output ?? string.Empty;
                return ExitCode == 5
                    || text.IndexOf("OpenProcess failed", StringComparison.OrdinalIgnoreCase) >= 0
                    || text.IndexOf("access", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
    }

    internal static class InjectionRunner
    {
        public static InjectionResult Run(ProcessRecord target)
        {
            string host = ArtifactLocator.HostPath(target.Architecture);
            string bootstrap = ArtifactLocator.BootstrapPath(target.Architecture);
            var startInfo = new ProcessStartInfo(host)
            {
                Arguments = "inject " + target.Id + " " + Quote(bootstrap),
                WorkingDirectory = ArtifactLocator.DirectoryPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                    return new InjectionResult { ExitCode = 30, Output = "The injector host could not be started." };

                Task<string> outputTask = Task.Factory.StartNew(() => process.StandardOutput.ReadToEnd());
                Task<string> errorTask = Task.Factory.StartNew(() => process.StandardError.ReadToEnd());
                bool exited = process.WaitForExit(45000);
                if (!exited)
                {
                    try { process.Kill(); }
                    catch { }
                    return new InjectionResult
                    {
                        ExitCode = 31,
                        TimedOut = true,
                        Output = "Injection did not finish within 45 seconds.",
                    };
                }
                Task.WaitAll(new Task[] { outputTask, errorTask }, 5000);
                string output = (outputTask.IsCompleted ? outputTask.Result : string.Empty)
                    + (errorTask.IsCompleted ? errorTask.Result : string.Empty);
                return new InjectionResult { ExitCode = process.ExitCode, Output = output.Trim() };
            }
        }

        public static int RunElevated(ProcessRecord target)
        {
            string host = ArtifactLocator.HostPath(target.Architecture);
            string bootstrap = ArtifactLocator.BootstrapPath(target.Architecture);
            var startInfo = new ProcessStartInfo(host)
            {
                Arguments = "inject " + target.Id + " " + Quote(bootstrap),
                WorkingDirectory = ArtifactLocator.DirectoryPath,
                UseShellExecute = true,
                Verb = "runas",
            };
            using (Process process = Process.Start(startInfo))
            {
                if (process == null) return 30;
                if (!process.WaitForExit(45000))
                {
                    try { process.Kill(); }
                    catch { }
                    return 31;
                }
                return process.ExitCode;
            }
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }
    }

    internal sealed class InjectorForm : Form
    {
        private static readonly int CurrentProcessId = Process.GetCurrentProcess().Id;

        private readonly TextBox _searchBox;
        private readonly Button _refreshButton;
        private readonly Button _injectButton;
        private readonly ListView _processList;
        private readonly Label _detailsLabel;
        private readonly Label _statusLabel;
        private readonly Timer _refreshTimer;
        private List<ProcessRecord> _records = new List<ProcessRecord>();
        private bool _refreshing;
        private bool _injecting;
        private bool _closing;

        public InjectorForm()
        {
            Text = "PageSignal Process Injector";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(920, 620);
            Size = new Size(1120, 720);
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.FromArgb(245, 247, 250);
            Icon = SystemIcons.Application;

            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 5,
                Padding = new Padding(16),
                BackColor = BackColor,
            };
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(root);

            var heading = new Label
            {
                AutoSize = true,
                Text = "Select a running Windows process",
                Font = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = Color.FromArgb(25, 38, 58),
                Margin = new Padding(0, 0, 0, 10),
            };
            root.Controls.Add(heading, 0, 0);

            var searchPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                ColumnCount = 4,
                Margin = new Padding(0, 0, 0, 12),
            };
            searchPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            searchPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            searchPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            searchPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            root.Controls.Add(searchPanel, 0, 1);

            searchPanel.Controls.Add(new Label
            {
                AutoSize = true,
                Text = "Search",
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                Anchor = AnchorStyles.Left,
                Margin = new Padding(0, 7, 10, 0),
            }, 0, 0);

            _searchBox = new TextBox
            {
                Dock = DockStyle.Fill,
                Font = new Font("Segoe UI", 10),
                Margin = new Padding(0, 2, 10, 2),
            };
            _searchBox.TextChanged += delegate { ApplyFilter(); };
            searchPanel.Controls.Add(_searchBox, 1, 0);

            _refreshButton = new Button
            {
                AutoSize = true,
                Text = "Refresh",
                Font = new Font("Segoe UI", 9),
                Margin = new Padding(0, 0, 10, 0),
                Padding = new Padding(10, 3, 10, 3),
            };
            _refreshButton.Click += async delegate { await RefreshProcessesAsync(); };
            searchPanel.Controls.Add(_refreshButton, 2, 0);

            _injectButton = new Button
            {
                AutoSize = true,
                Text = "Inject PageSignal",
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                BackColor = Color.FromArgb(47, 110, 234),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Padding = new Padding(12, 3, 12, 3),
                Enabled = false,
            };
            _injectButton.FlatAppearance.BorderSize = 0;
            _injectButton.Click += async delegate { await InjectSelectedAsync(); };
            searchPanel.Controls.Add(_injectButton, 3, 0);

            _processList = new ListView
            {
                Dock = DockStyle.Fill,
                View = View.Details,
                FullRowSelect = true,
                MultiSelect = false,
                HideSelection = false,
                GridLines = true,
                Font = new Font("Segoe UI", 9),
                BackColor = Color.White,
            };
            _processList.Columns.Add("Name", 165);
            _processList.Columns.Add("PID", 65);
            _processList.Columns.Add("Architecture", 115);
            _processList.Columns.Add("Window title", 190);
            _processList.Columns.Add("Session", 75);
            _processList.Columns.Add("Started", 150);
            _processList.Columns.Add("Executable path", 295);
            _processList.SelectedIndexChanged += delegate { UpdateSelection(); };
            _processList.DoubleClick += async delegate { await InjectSelectedAsync(); };
            root.Controls.Add(_processList, 0, 2);

            _detailsLabel = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(1040, 0),
                Text = "Select a process to see its details.",
                Font = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(65, 78, 98),
                Margin = new Padding(0, 10, 0, 4),
            };
            root.Controls.Add(_detailsLabel, 0, 3);

            _statusLabel = new Label
            {
                AutoSize = true,
                Text = "Loading running processes...",
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Color.FromArgb(47, 110, 234),
                Margin = new Padding(0, 4, 0, 0),
            };
            root.Controls.Add(_statusLabel, 0, 4);

            _refreshTimer = new Timer { Interval = 5000 };
            _refreshTimer.Tick += async delegate { await RefreshProcessesAsync(); };
            _refreshTimer.Start();
            Shown += async delegate { await RefreshProcessesAsync(); };
            FormClosing += delegate
            {
                _closing = true;
                _refreshTimer.Stop();
                _refreshTimer.Dispose();
            };
            SetInjectEnabled(false);
        }

        private async Task RefreshProcessesAsync()
        {
            if (_refreshing || _injecting || _closing) return;
            _refreshing = true;
            _refreshButton.Enabled = false;
            int selectedPid = SelectedRecord == null ? -1 : SelectedRecord.Id;
            try
            {
                List<ProcessRecord> records = await Task.Run(() => ProcessCatalog.ReadAll());
                if (_closing || IsDisposed) return;
                _records = records;
                ApplyFilter(selectedPid);
                _statusLabel.ForeColor = Color.FromArgb(47, 110, 234);
                _statusLabel.Text = records.Count + " running processes found. The list refreshes every 5 seconds.";
            }
            catch (Exception ex)
            {
                if (_closing || IsDisposed) return;
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = "Unable to refresh processes: " + ex.Message;
            }
            finally
            {
                _refreshing = false;
                if (!_closing && !IsDisposed) _refreshButton.Enabled = true;
            }
        }

        private void ApplyFilter(int preferredPid = -1)
        {
            if (_closing || IsDisposed) return;
            if (preferredPid < 0 && SelectedRecord != null) preferredPid = SelectedRecord.Id;
            string filter = _searchBox.Text;
            List<ProcessRecord> visible = _records.Where(item => item.Matches(filter)).ToList();

            _processList.BeginUpdate();
            try
            {
                _processList.Items.Clear();
                foreach (ProcessRecord record in visible)
                {
                    var item = new ListViewItem(record.Name) { Tag = record };
                    item.SubItems.Add(record.Id.ToString());
                    item.SubItems.Add(record.ArchitectureLabel);
                    item.SubItems.Add(record.WindowTitle);
                    item.SubItems.Add(record.Session);
                    item.SubItems.Add(record.Started);
                    item.SubItems.Add(record.Path);
                    if (record.Architecture == TargetArchitecture.Unknown || record.Architecture == TargetArchitecture.Arm64)
                        item.ForeColor = Color.Gray;
                    _processList.Items.Add(item);
                    if (record.Id == preferredPid) item.Selected = true;
                }
            }
            finally
            {
                _processList.EndUpdate();
            }
            if (_processList.SelectedItems.Count > 0) _processList.SelectedItems[0].EnsureVisible();
            UpdateSelection();
        }

        private ProcessRecord SelectedRecord
        {
            get
            {
                if (_processList.SelectedItems.Count != 1) return null;
                return _processList.SelectedItems[0].Tag as ProcessRecord;
            }
        }

        private void UpdateSelection()
        {
            ProcessRecord record = SelectedRecord;
            if (record == null)
            {
                _detailsLabel.Text = "Select a process to see its details.";
                SetInjectEnabled(false);
                return;
            }
            _detailsLabel.Text = record.Name + " (PID " + record.Id + ", " + record.ArchitectureLabel + ")"
                + " | Session " + record.Session + " | Started " + record.Started
                + Environment.NewLine + record.Path
                + (string.IsNullOrEmpty(record.WindowTitle) ? string.Empty : Environment.NewLine + "Window: " + record.WindowTitle);
            SetInjectEnabled(!_injecting
                && record.Id != CurrentProcessId
                && (record.Architecture == TargetArchitecture.X86 || record.Architecture == TargetArchitecture.X64));
        }

        private async Task InjectSelectedAsync()
        {
            ProcessRecord target = SelectedRecord;
            if (target == null || _injecting) return;
            string validationError = ArtifactLocator.Validate(target.Architecture);
            if (validationError != null)
            {
                MessageBox.Show(this, validationError, "Injection unavailable", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (target.Id == CurrentProcessId)
            {
                MessageBox.Show(this, "The injector cannot target itself.", "Select another process", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            _injecting = true;
            SetInjectEnabled(false);
            _refreshButton.Enabled = false;
            _statusLabel.ForeColor = Color.FromArgb(47, 110, 234);
            _statusLabel.Text = "Injecting PageSignal into " + target.Name + " (PID " + target.Id + ")...";
            try
            {
                InjectionResult result = await Task.Run(() => InjectionRunner.Run(target));
                if (_closing || IsDisposed) return;
                if (result.ExitCode == 0)
                {
                    _statusLabel.ForeColor = Color.FromArgb(22, 132, 91);
                    _statusLabel.Text = "PageSignal loaded into " + target.Name + " (PID " + target.Id + ") and is starting.";
                    return;
                }

                if (result.AccessDenied)
                {
                    DialogResult retry = MessageBox.Show(
                        this,
                        "Windows denied access to the selected process. Retry with administrator permission?",
                        "Administrator permission required",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Warning);
                    if (retry == DialogResult.Yes)
                    {
                        int elevatedResult;
                        try
                        {
                            elevatedResult = await Task.Run(() => InjectionRunner.RunElevated(target));
                        }
                        catch (Win32Exception ex)
                        {
                            _statusLabel.ForeColor = Color.Firebrick;
                            _statusLabel.Text = ex.NativeErrorCode == 1223
                                ? "Administrator permission was cancelled."
                                : "Elevated injection could not start: " + ex.Message;
                            return;
                        }
                        _statusLabel.ForeColor = elevatedResult == 0 ? Color.FromArgb(22, 132, 91) : Color.Firebrick;
                        _statusLabel.Text = elevatedResult == 0
                            ? "PageSignal loaded with administrator permission and is starting."
                            : "Elevated injection failed with exit code " + elevatedResult + ".";
                        return;
                    }
                }

                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = result.TimedOut
                    ? result.Output
                    : "Injection failed (exit " + result.ExitCode + "): " + LastLine(result.Output);
            }
            catch (Exception ex)
            {
                if (_closing || IsDisposed) return;
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = "Injection failed: " + ex.Message;
            }
            finally
            {
                _injecting = false;
                if (!_closing && !IsDisposed)
                {
                    _refreshButton.Enabled = true;
                    UpdateSelection();
                }
            }
        }

        private static string LastLine(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return "No error details were returned.";
            string[] lines = text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            return lines.Length == 0 ? text.Trim() : lines[lines.Length - 1].Trim();
        }

        private void SetInjectEnabled(bool enabled)
        {
            _injectButton.Enabled = enabled;
            _injectButton.BackColor = enabled ? Color.FromArgb(47, 110, 234) : Color.FromArgb(218, 224, 232);
            _injectButton.ForeColor = enabled ? Color.White : Color.FromArgb(112, 124, 142);
        }
    }
}
