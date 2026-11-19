using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

// A local QA fixture, not an installer. Only touches its own working directory.
internal static class Counter {
    static int Main(string[] args) {
        try {
            string dir = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
            if (!String.Equals(dir, Environment.CurrentDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) return 2;
            string mode = File.Exists("mode.txt") ? File.ReadAllText("mode.txt") : "write";
            if (mode == "unchanged") return 0;
            if (mode == "child" && args.Length == 0) {
                using (Process child = Process.Start(new ProcessStartInfo(Path.Combine(dir, "Counter.exe"), "--write") { WorkingDirectory = dir, UseShellExecute = false })) { }
                return 0;
            }
            Thread.Sleep(650);
            if (!File.Exists("assets/runtime.txt") || File.ReadAllText("assets/runtime.txt") != "MiniZip portable QA") {
                File.WriteAllText("probe-missing.txt", "Companion file not staged");
                return 3;
            }
            string text = File.ReadAllText("config.txt");
            if (!text.StartsWith("counter=", StringComparison.Ordinal)) return 4;
            int count;
            if (!Int32.TryParse(text.Substring(8), out count) || count < 0 || count > 1000) return 5;
            string next = (count + 1).ToString(CultureInfo.InvariantCulture);
            File.WriteAllText("config.txt", "counter=" + next, new UTF8Encoding(false));
            Directory.CreateDirectory("data");
            File.WriteAllText("data/last-run.txt", "saved=" + next, new UTF8Encoding(false));
            Thread.Sleep(500);
            return 0;
        } catch { return 6; }
    }
}
