using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

internal static class FitGirlPolicyHarness
{
    [STAThread]
    private static void Main()
    {
        string executable = Application.ExecutablePath;
        string name = Path.GetFileNameWithoutExtension(executable);
        if (name.Equals("dxsetup", StringComparison.OrdinalIgnoreCase))
        {
            Thread.Sleep(TimeSpan.FromSeconds(30));
            return;
        }

        if (name.Equals("cmd", StringComparison.OrdinalIgnoreCase))
        {
            Thread.Sleep(TimeSpan.FromSeconds(30));
            return;
        }

        if (name.Equals("QuickSFV", StringComparison.OrdinalIgnoreCase))
        {
            Application.EnableVisualStyles();
            using (var window = new Form
            {
                Text = "Finished",
                Width = 520,
                Height = 220,
                StartPosition = FormStartPosition.CenterScreen
            })
            {
                window.Controls.Add(new Label
                {
                    AutoSize = true,
                    Left = 24,
                    Top = 36,
                    Text = "Bad: 0    Missing: 0\r\nAll files OK"
                });
                Application.Run(window);
            }
            return;
        }

        string directory = Path.GetDirectoryName(executable);
        using (Process directX = Process.Start(new ProcessStartInfo
        {
            FileName = Path.Combine(directory, "dxsetup.exe"),
            UseShellExecute = false
        }))
        using (Process integrity = Process.Start(new ProcessStartInfo
        {
            FileName = Path.Combine(directory, "QuickSFV.exe"),
            UseShellExecute = false
        }))
        using (Process redirect = Process.Start(new ProcessStartInfo
        {
            FileName = Path.Combine(directory, "cmd.exe"),
            Arguments = "fg-optional-fake-site-redirect",
            UseShellExecute = false,
            CreateNoWindow = true
        }))
        {
            directX.WaitForExit();
            integrity.WaitForExit();
            redirect.WaitForExit();
        }
    }
}
