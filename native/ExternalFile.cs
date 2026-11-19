// Windows shell associations do not always return a document-owning process.
// Report CLOSED only for the executable itself or a process proven to hold this file.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class ExternalFile {
    [StructLayout(LayoutKind.Sequential)] struct Owner { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME started; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Holder {
        public Owner process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
        public uint type, status, session;
        [MarshalAs(UnmanagedType.Bool)] public bool restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint files, string[] paths, uint apps, IntPtr processes, uint services, IntPtr names);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [Out] Holder[] holders, ref uint reason);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);

    static bool OwnsDocument(Process process, string file) {
        uint session;
        if (RmStartSession(out session, 0, new StringBuilder(33)) != 0) return false;
        try {
            if (RmRegisterResources(session, 1, new[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) return false;
            long start = process.StartTime.ToUniversalTime().ToFileTimeUtc();
            for (int i = 0; i < 12 && !process.HasExited; i++) {
                Holder[] holders = new Holder[32]; uint needed, count = (uint)holders.Length, reason = 0;
                if (RmGetList(session, out needed, ref count, holders, ref reason) == 0) {
                    for (int n = 0; n < count; n++) {
                        var p = holders[n].process;
                        long ticks = ((long)p.started.dwHighDateTime << 32) | (uint)p.started.dwLowDateTime;
                        if (p.pid == process.Id && ticks == start) return true;
                    }
                }
                if (process.WaitForExit(500)) break;
            }
            return false;
        } finally { RmEndSession(session); }
    }

    [StructLayout(LayoutKind.Sequential)] struct FileInfoNative {
        public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfoNative info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref byte disposition, uint size);

    [StructLayout(LayoutKind.Sequential)] struct JobCounts {
        public long user, kernel, periodUser, periodKernel;
        public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, out bool inside);
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out JobCounts counts, int size, IntPtr length);

    static int RunProgram(string file) {
        // Ordinary shell execution preserves Windows association and origin checks. The
        // helper joins an observation-only job before launch, so even fast children count.
        using (var job = CreateJobObject(IntPtr.Zero, null)) using (var self = Process.GetCurrentProcess()) {
            bool tracking = !job.IsInvalid && AssignProcessToJobObject(job, self.Handle);
            using (var process = Process.Start(new ProcessStartInfo { FileName = file, WorkingDirectory = Path.GetDirectoryName(file), UseShellExecute = true, Verb = "open" })) {
                Console.WriteLine("OPENED"); Console.Out.Flush();
                bool inJob;
                if (!tracking || process == null || !IsProcessInJob(process.Handle, job, out inJob) || !inJob) return 0;
                process.WaitForExit();
                JobCounts counts;
                while (QueryInformationJobObject(job, 1, out counts, Marshal.SizeOf(typeof(JobCounts)), IntPtr.Zero)) {
                    if (counts.active == 1) { Console.WriteLine("CLOSED"); break; }
                    Thread.Sleep(200);
                }
                return 0;
            }
        }
    }

    // Hash and mark for deletion on the SAME exclusively held file object. No
    // unlocked interval in which an editor could replace it or finish a late save.
    static bool Clean(string file, string expected) {
        using (var handle = CreateFile(file, 0x80010000, 0, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
            FileInfoNative info;
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || (info.attributes & 0x410) != 0 || info.links != 1) return false;
            using (var stream = new FileStream(handle, FileAccess.Read)) using (var sha = SHA256.Create()) {
                string digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
                if (!String.Equals(digest, expected, StringComparison.OrdinalIgnoreCase)) return false;
                byte remove = 1;
                return SetFileInformationByHandle(handle, 4, ref remove, 1);
            }
        }
    }
    static int Main(string[] args) {
        try {
            if (args.Length < 2 || !Path.IsPathRooted(args[1])) return 2;
            string file = Path.GetFullPath(args[1]);
            if (args[0] == "clean" && args.Length == 3) return Clean(file, args[2]) ? 0 : 1;
            if (args[0] == "program" && args.Length == 2 && String.Equals(Path.GetExtension(file), ".exe", StringComparison.OrdinalIgnoreCase)) return RunProgram(file);
            if (args[0] == "clean-batch" && args.Length == 2) {
                string prefix = file.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                string line;
                while ((line = Console.ReadLine()) != null) {
                    if (line.Length < 66 || line[64] != '\t') return 2;
                    string member = Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(65)));
                    string target = Path.GetFullPath(Path.Combine(file, member));
                    if (Path.IsPathRooted(member) || member.Contains(":") || !target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return 2;
                    for (var dir = new DirectoryInfo(Path.GetDirectoryName(target)); dir != null; dir = dir.Parent)
                        if ((dir.Attributes & FileAttributes.ReparsePoint) != 0) return 1;
                    if (!Clean(target, line.Substring(0, 64))) return 1;
                }
                return 0;
            }
            if (args[0] != "open" || args.Length != 2) return 2;
            using (var process = Process.Start(new ProcessStartInfo { FileName = file, WorkingDirectory = Path.GetDirectoryName(file), UseShellExecute = true, Verb = "open" })) {
                Console.WriteLine("OPENED"); Console.Out.Flush();
                if (process == null) return 0;
                bool own = String.Equals(Path.GetExtension(file), ".exe", StringComparison.OrdinalIgnoreCase) && String.Equals(process.MainModule.FileName, file, StringComparison.OrdinalIgnoreCase);
                if (own || OwnsDocument(process, file)) { process.WaitForExit(); Console.WriteLine("CLOSED"); }
                return 0;
            }
        } catch { return 1; }
    }
}
