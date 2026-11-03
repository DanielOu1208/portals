#!/usr/bin/env python3 -I
"""CPU of a process and of its main thread over a stretch, with its idle wake-ups.

    python3 -I scripts/phone-bench/threads.py <pid> <seconds>
    python3 -I scripts/phone-bench/threads.py poll <pid> <out> <frames file>

Prints one line of key=value pairs: cpu (all threads, % of a core), main (the main
thread), top (the three busiest other threads, by name), wakeups (idle wake-ups a
second, from top), power (top's energy impact, the mean of its samples). Total CPU is
the process counter's delta, including workers that ended during the sample. Reads each
thread's CPU time with proc_pidinfo (the process must be the caller's user, as a
simulator's apps are). The main thread is the first in the task's list. `poll` writes the running
CPU (ps, threads that ended included), the main thread's, and the frame meter's line
count every half second.
"""
import ctypes, subprocess, sys, time

libc = ctypes.CDLL("/usr/lib/libc.dylib")
PROC_PIDLISTTHREADS, PROC_PIDTHREADINFO = 6, 5


class ThreadInfo(ctypes.Structure):
    _fields_ = [("user", ctypes.c_uint64), ("system", ctypes.c_uint64), ("cpu_usage", ctypes.c_int32),
                ("policy", ctypes.c_int32), ("run_state", ctypes.c_int32), ("flags", ctypes.c_int32),
                ("sleep_time", ctypes.c_int32), ("curpri", ctypes.c_int32), ("priority", ctypes.c_int32),
                ("maxpriority", ctypes.c_int32), ("name", ctypes.c_char * 64)]


def threads(pid):
    buf = (ctypes.c_uint64 * 4096)()
    n = libc.proc_pidinfo(pid, PROC_PIDLISTTHREADS, 0, buf, ctypes.sizeof(buf)) // 8
    out = []
    for index in range(n):
        info = ThreadInfo()
        if libc.proc_pidinfo(pid, PROC_PIDTHREADINFO, ctypes.c_uint64(buf[index]), ctypes.byref(info), ctypes.sizeof(info)) <= 0:
            continue
        out.append((buf[index], info.name.decode(errors="replace") or "?", (info.user + info.system) / 1e9, index == 0))
    return out


def cputime(pid):
    """The process's CPU seconds so far, threads that ended included (ps)."""
    t = subprocess.run(["ps", "-o", "time=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    total = 0.0
    for part in t.replace("-", ":").split(":"):
        total = total * 60 + float(part or 0)
    return total


def poll(pid, out, frames):
    """Every half second until the process ends: <unix time> <CPU s> <main thread CPU s> <frame meter lines>."""
    import os
    with open(out, "a") as f:
        while True:
            try:
                os.kill(pid, 0)
            except OSError:
                return
            rows = threads(pid)
            try:
                with open(frames) as m:
                    lines = sum(1 for _ in m)
            except OSError:
                lines = 0
            f.write("%.3f %.2f %.4f %d\n" % (time.time(), cputime(pid), sum(r[2] for r in rows if r[3]), lines))
            f.flush()
            time.sleep(0.5)


def main():
    if sys.argv[1] == "poll":
        return poll(int(sys.argv[2]), sys.argv[3], sys.argv[4])
    pid, seconds = int(sys.argv[1]), float(sys.argv[2])
    t0, cpu0 = time.time(), cputime(pid)
    a = {t[0]: t for t in threads(pid)}
    top = subprocess.run(["top", "-l", "2", "-s", str(int(seconds)), "-pid", str(pid), "-stats", "pid,idlew,power"],
                         capture_output=True, text=True).stdout
    t1, cpu1 = time.time(), cputime(pid)
    b = threads(pid)
    span = t1 - t0
    rows, main_cpu = [], 0.0
    for handle, name, cpu, is_main in b:
        used = cpu - (a[handle][2] if handle in a else 0.0)
        if is_main:
            main_cpu = used
        else:
            rows.append((used, name))
    rows.sort(reverse=True)
    lines = [l.split() for l in top.splitlines() if l.split() and l.split()[0] == str(pid)]
    wake = power = "?"
    if len(lines) == 2:
        wake = "%.0f" % ((int(lines[1][1].strip("+-")) - int(lines[0][1].strip("+-"))) / seconds)
        power = lines[1][2]
    busiest = ",".join("%s:%.1f" % (name.replace(" ", "_")[:28], 100 * used / span) for used, name in rows[:3])
    process_cpu = 100 * (cpu1 - cpu0) / span
    print("cpu=%.1f main=%.1f wakeups=%s power=%s threads=%d top=%s" % (process_cpu, 100 * main_cpu / span, wake, power, len(b), busiest))


if __name__ == "__main__":
    main()
