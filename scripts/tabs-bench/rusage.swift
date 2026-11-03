// What a process has used so far, from the kernel's own count (proc_pid_rusage): no
// sudo, unlike powermetrics. Part of scripts/tabs-bench.sh.
//
//     rusage <pid>
//
// prints one line: `<cpu ms> <idle wakeups> <interrupt wakeups> <footprint MB> <instructions M>`,
// each counted from the process's start; the bench takes differences of two lines.
import Darwin
import Foundation

guard CommandLine.arguments.count > 1, let pid = Int32(CommandLine.arguments[1]) else {
    FileHandle.standardError.write(Data("usage: rusage <pid>\n".utf8))
    exit(2)
}
var info = rusage_info_v4()
let result = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
}
guard result == 0 else { exit(1) }
var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
let ticks = Double(info.ri_user_time + info.ri_system_time)
let cpuMs = ticks * Double(timebase.numer) / Double(timebase.denom) / 1e6
print(String(format: "%.1f %llu %llu %.1f %.1f", cpuMs, info.ri_pkg_idle_wkups, info.ri_interrupt_wkups,
             Double(info.ri_phys_footprint) / 1_048_576, Double(info.ri_instructions) / 1e6))
