using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Management.Automation;
using System.Net;
using System.Reflection;
using System.Security;
using System.Threading.Tasks;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]
[assembly: AssemblyTitle("FORGE Setup")]
[assembly: AssemblyProduct("FORGE Workbench")]
[assembly: AssemblyCompany("ProjForge")]

internal sealed class ForgeSetup : Form
{
    private static readonly string Distribution = AppDomain.CurrentDomain.BaseDirectory;
    private readonly TextBox host = new TextBox();
    private readonly NumericUpDown databasePort = Port(5432);
    private readonly TextBox database = new TextBox();
    private readonly TextBox user = new TextBox();
    private readonly TextBox password = new TextBox { UseSystemPasswordChar = true, MaxLength = 4096, ShortcutsEnabled = false };
    private readonly NumericUpDown workbenchPort = Port(7334);
    private readonly Button reconfigure = new Button { AutoSize = true };
    private readonly CheckBox launch = new CheckBox { Text = "Abrir Forge al terminar", AutoSize = true, Checked = true };
    private readonly Button check = new Button { Text = "Probar conexión", AutoSize = true };
    private readonly Button install = new Button { Text = "Instalar", AutoSize = true };
    private readonly Label summary = new Label { AutoSize = true };
    private readonly Label status = new Label { AutoSize = true, MaximumSize = new System.Drawing.Size(430, 0) };
    private readonly TableLayoutPanel settings = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Top };
    private bool existing;
    private bool installed;
    private bool changingConnection;
    private bool verified;
    private bool busy;

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 1 && args[0] == "--open-workbench")
        {
            OpenWorkbench();
            return;
        }
        Application.Run(new ForgeSetup());
    }

    private static Process FindWorkbench(string executable)
    {
        Process match = null;
        foreach (var candidate in Process.GetProcessesByName("FORGE-Workbench"))
        {
            try
            {
                if (match == null && String.Equals(candidate.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase))
                {
                    match = candidate;
                    continue;
                }
            }
            catch (Win32Exception) { }
            catch (InvalidOperationException) { }
            candidate.Dispose();
        }
        return match;
    }

    private static void OpenWorkbench()
    {
        try
        {
            var url = new Uri(File.ReadAllText(Path.Combine(Distribution, "workbench.url")).Trim(), UriKind.Absolute);
            if (url.Scheme != "http" || url.Host != "127.0.0.1" || url.UserInfo != "" || url.PathAndQuery != "/" || url.Fragment != "")
                throw new InvalidOperationException("La dirección local de Forge no es válida.");

            var executable = Path.Combine(Distribution, "FORGE-Workbench.exe");
            using (var process = FindWorkbench(executable) ?? Process.Start(new ProcessStartInfo(executable) {
                WorkingDirectory = Distribution, UseShellExecute = false, CreateNoWindow = true
            }))
            {
                var deadline = Stopwatch.StartNew();
                while (deadline.Elapsed < TimeSpan.FromSeconds(20) && !process.HasExited)
                {
                    try
                    {
                        var request = (HttpWebRequest)WebRequest.Create(new Uri(url, "api/bootstrap"));
                        request.Proxy = null;
                        request.AllowAutoRedirect = false;
                        request.Timeout = 500;
                        using (var response = (HttpWebResponse)request.GetResponse())
                        {
                            if (response.StatusCode == HttpStatusCode.OK && response.ContentType.StartsWith("application/json"))
                            {
                                Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });
                                return;
                            }
                        }
                    }
                    catch (WebException error) { if (error.Response != null) error.Response.Dispose(); }
                    Thread.Sleep(150);
                }
            }
            throw new InvalidOperationException("Forge no pudo iniciar. Comprueba PostgreSQL y el puerto local con el asistente.");
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "FORGE Workbench", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private ForgeSetup()
    {
        Text = "Instalar FORGE Workbench";
        AutoScaleMode = AutoScaleMode.Font;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        var layout = new FlowLayoutPanel {
            FlowDirection = FlowDirection.TopDown, WrapContents = false,
            AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(16)
        };
        Controls.Add(layout);
        layout.Controls.Add(summary);
        layout.Controls.Add(settings);
        AddField("Servidor PostgreSQL", host);
        AddField("Puerto PostgreSQL", databasePort);
        AddField("Base de datos", database);
        AddField("Usuario", user);
        AddField("Contraseña", password);
        AddField("Puerto local de Forge", workbenchPort);
        layout.Controls.Add(launch);
        var buttons = new FlowLayoutPanel { AutoSize = true };
        buttons.Controls.Add(check);
        buttons.Controls.Add(install);
        buttons.Controls.Add(reconfigure);
        layout.Controls.Add(buttons);
        layout.Controls.Add(status);
        layout.Controls.Add(new Label { Text = "LM Studio es opcional para buscar en la memoria del proyecto.", AutoSize = true });
        reconfigure.Click += delegate {
            if (busy || !verified) return;
            changingConnection = !changingConnection;
            password.Clear();
            status.Text = changingConnection ? "Introduce y prueba la nueva conexión." : "Se conservará la conexión actual.";
            UpdateControls();
            if (changingConnection) host.Focus();
        };
        check.Click += async delegate { await Run(true); };
        install.Click += async delegate { await Run(false); };
        Shown += async delegate { await Inspect(); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) { args.Cancel = busy; };
        UpdateControls();
    }

    private static NumericUpDown Port(int value)
    {
        return new NumericUpDown { Minimum = 1, Maximum = 65535, Value = value };
    }

    private void AddField(string label, Control control)
    {
        int row = settings.RowCount++;
        settings.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
        control.Width = 280;
        control.AccessibleName = label;
        settings.Controls.Add(control, 1, row);
    }

    private void UpdateControls()
    {
        settings.Enabled = verified && !busy && (!existing || changingConnection);
        workbenchPort.Enabled = !changingConnection || !installed;
        reconfigure.Visible = existing;
        reconfigure.Enabled = verified && !busy;
        reconfigure.Text = changingConnection ? "Volver" : "Cambiar conexión";
        check.Enabled = install.Enabled = launch.Enabled = verified && !busy;
        install.Text = changingConnection && installed ? "Guardar conexión" : installed && existing ? "Actualizar" : "Instalar";
        AcceptButton = !existing || changingConnection ? check : install;
    }

    private static IList<PSObject> Execute(Dictionary<string, object> parameters)
    {
        using (var reader = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream("FORGE.Install")))
        using (var manifest = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream("FORGE.Manifest")))
        using (var shell = PowerShell.Create())
        {
            shell.AddScript(reader.ReadToEnd(), true)
                .AddParameter("DistributionRoot", Distribution)
                .AddParameter("TrustedManifest", manifest.ReadToEnd());
            foreach (var parameter in parameters)
                shell.AddParameter(parameter.Key, parameter.Value);

            var output = shell.Invoke();
            if (shell.Streams.Error.Count != 0)
                throw new InvalidOperationException(shell.Streams.Error[0].Exception.Message);
            return output;
        }
    }

    private async Task Inspect()
    {
        busy = true;
        UpdateControls();
        status.Text = "Verificando el paquete…";
        try
        {
            var output = await Task.Run(() => Execute(new Dictionary<string, object> { { "Inspect", true } }));
            var config = output[0].Properties;
            existing = LanguagePrimitives.ConvertTo<bool>(config["Existing"].Value);
            installed = LanguagePrimitives.ConvertTo<bool>(config["Installed"].Value);
            host.Text = LanguagePrimitives.ConvertTo<string>(config["DatabaseHost"].Value);
            databasePort.Value = LanguagePrimitives.ConvertTo<int>(config["DatabasePort"].Value);
            database.Text = LanguagePrimitives.ConvertTo<string>(config["DatabaseName"].Value);
            user.Text = LanguagePrimitives.ConvertTo<string>(config["DatabaseUser"].Value);
            workbenchPort.Value = LanguagePrimitives.ConvertTo<int>(config["WorkbenchPort"].Value);
            verified = true;
            summary.Text = "FORGE Workbench " + config["Version"].Value + " · " +
                (LanguagePrimitives.ConvertTo<bool>(config["Signed"].Value) ? "Firmado" : "Sin firma");
            status.Text = existing ? "Hay una conexión guardada." : "Conecta Forge con una base PostgreSQL preparada.";
        }
        catch (Exception error)
        {
            status.Text = error.Message;
        }
        busy = false;
        UpdateControls();
    }

    private async Task Run(bool checkOnly)
    {
        if (busy || !verified) return;
        bool enter = !existing || changingConnection;
        if (enter && password.TextLength == 0)
        {
            status.Text = "Introduce la contraseña de PostgreSQL.";
            password.Focus();
            return;
        }
        busy = true;
        UpdateControls();
        status.Text = checkOnly ? "Probando la conexión…" : "Aplicando los cambios…";
        try
        {
            using (var secret = new SecureString())
            {
                var parameters = new Dictionary<string, object>();
                if (checkOnly) parameters.Add("CheckOnly", true);
                if (!launch.Checked) parameters.Add("NoLaunch", true);
                if (enter)
                {
                    foreach (char character in password.Text) secret.AppendChar(character);
                    secret.MakeReadOnly();
                    if (existing || installed) parameters.Add("Reconfigure", true);
                    if (existing && installed) parameters.Add("ConnectionOnly", true);
                    parameters.Add("DatabaseHost", host.Text.Trim());
                    parameters.Add("DatabasePort", (int)databasePort.Value);
                    parameters.Add("DatabaseName", database.Text.Trim());
                    parameters.Add("DatabaseUser", user.Text.Trim());
                    parameters.Add("WorkbenchPort", (int)workbenchPort.Value);
                    parameters.Add("DatabasePassword", secret);
                }
                var output = await Task.Run(() => Execute(parameters));
                status.Text = checkOnly ? "Conexión y permisos verificados." :
                    (output.Count > 0 ? output[0].ToString() : "Forge está listo.");
            }
            if (!checkOnly)
            {
                busy = false;
                password.Clear();
                Close();
            }
        }
        catch (Exception error)
        {
            status.Text = error.Message;
        }
        finally
        {
            busy = false;
            if (!IsDisposed) UpdateControls();
        }
    }
}
