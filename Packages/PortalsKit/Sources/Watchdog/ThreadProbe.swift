import Darwin
import Foundation
import MachO

/// Looks at one thread from another, with the Mach calls the SDK declares (no private API):
/// its CPU time, and the return addresses on its stack.
public struct ThreadProbe: @unchecked Sendable {
    /// The thread's Mach port, kept for the life of the process.
    public let port: thread_act_t

    /// The thread this runs on. Call it on the thread to be looked at.
    public static func current() -> ThreadProbe {
        ThreadProbe(port: mach_thread_self())
    }

    public init(port: thread_act_t) {
        self.port = port
    }

    /// CPU time the thread has used so far, in seconds (to the microsecond), or nil when
    /// it can't be read.
    public func cpuSeconds() -> Double? {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                thread_info(port, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        let seconds = Double(info.user_time.seconds) + Double(info.system_time.seconds)
        let micros = Double(info.user_time.microseconds) + Double(info.system_time.microseconds)
        return seconds + micros / 1_000_000
    }

    /// The return addresses on the thread's stack, innermost first, at most `limit`: the
    /// thread is stopped for as long as it takes to copy them (well under a millisecond),
    /// then let go. Empty where it can't be done: not on this CPU, or on the thread itself.
    ///
    /// Nothing between stopping and letting go may take a lock the stopped thread could
    /// hold (allocating included), so the frames are copied into a buffer made before, and
    /// the stack is read with `vm_read_overwrite`, which fails on a bad address
    /// rather than crashing. The walk follows the frame pointers the arm64 ABI keeps.
    public func backtrace(limit: Int = 64) -> [UInt] {
        #if arch(arm64)
        let this = mach_thread_self()
        mach_port_deallocate(mach_task_self_, this)
        guard port != this else { return [] }
        let frames = UnsafeMutableBufferPointer<UInt>.allocate(capacity: max(limit, 2))
        defer { frames.deallocate() }
        var count = 0

        var state = arm_thread_state64_t()
        var stateCount = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<UInt32>.size)
        guard thread_suspend(port) == KERN_SUCCESS else { return [] }
        let got = withUnsafeMutablePointer(to: &state) { pointer in
            pointer.withMemoryRebound(to: natural_t.self, capacity: Int(stateCount)) {
                thread_get_state(port, ARM_THREAD_STATE64, $0, &stateCount)
            }
        }
        if got == KERN_SUCCESS {
            frames[0] = Self.strip(UInt(state.__pc))
            frames[1] = Self.strip(UInt(state.__lr))
            count = 2
            var framePointer = UInt(state.__fp)
            var pair: (UInt, UInt) = (0, 0)
            while count < frames.count, framePointer != 0, framePointer & 0xF == 0 {
                var read: vm_size_t = 0
                let ok = withUnsafeMutablePointer(to: &pair) {
                    vm_read_overwrite(mach_task_self_, vm_address_t(framePointer), 16, vm_address_t(UInt(bitPattern: $0)), &read)
                }
                guard ok == KERN_SUCCESS, read == 16 else { break }
                let returnAddress = Self.strip(pair.1)
                if returnAddress == 0 { break }
                frames[count] = returnAddress
                count += 1
                // The stack grows down, so each caller's frame is above its callee's.
                guard pair.0 > framePointer else { break }
                framePointer = pair.0
            }
        }
        thread_resume(port)
        // A function stopped before saving its return address has it only in lr, which then
        // comes again as the first saved one.
        if count > 2, frames[1] == frames[2] {
            return [frames[0]] + Array(frames[2..<count])
        }
        return Array(frames[0..<count])
        #else
        return []
        #endif
    }

    /// An address without the bits pointer authentication may have put above it.
    static func strip(_ address: UInt) -> UInt {
        #if os(iOS) && !targetEnvironment(simulator) && !targetEnvironment(macCatalyst)
        address & 0x0000_000F_FFFF_FFFF
        #else
        address & 0x0000_7FFF_FFFF_FFFF
        #endif
    }
}

/// Return addresses named after the images they are in, as text that can be read as it
/// is and looked up later in the image's dSYM with `atos -o <dSYM> -l <base> <address>`.
public enum StackText {
    public struct Frame: Sendable, Equatable, Codable {
        /// The image's file name: `Portals`, `SwiftUICore`.
        public var image: String
        public var address: UInt
        /// Where the image was loaded, for `atos -l`.
        public var base: UInt
        /// The nearest exported symbol before the address, when there is one: a hint only,
        /// as an app keeps few (a function of its own is often named after the last
        /// exported one before it). The dSYM has the real names.
        public var symbol: String?

        /// `Portals 0x100a3c4f0 +0xa3c4f0 $s7Portals…F + 12`: the image, the address, where
        /// it is in the image, and the symbol when there is one.
        public var line: String {
            let offset = address &- base
            var text = "\(image) 0x\(String(address, radix: 16)) +0x\(String(offset, radix: 16))"
            if let symbol { text += " \(symbol)" }
            return text
        }
    }

    /// The frames for these addresses. Every frame but the first is a return address, so
    /// it is looked up one byte before, in the call that returns to it.
    public static func frames(_ addresses: [UInt]) -> [Frame] {
        addresses.enumerated().map { index, address in
            var info = Dl_info()
            let lookup = index == 0 ? address : address &- 1
            guard let pointer = UnsafeRawPointer(bitPattern: lookup), dladdr(pointer, &info) != 0 else {
                return Frame(image: "?", address: address, base: 0, symbol: nil)
            }
            let image = info.dli_fname.map { String(cString: $0) }.map { ($0 as NSString).lastPathComponent } ?? "?"
            let base = UInt(bitPattern: info.dli_fbase)
            var symbol: String?
            if let name = info.dli_sname {
                let start = UInt(bitPattern: info.dli_saddr)
                symbol = "\(String(cString: name)) + \(lookup &- start)"
            }
            return Frame(image: image, address: address, base: base, symbol: symbol)
        }
    }

    /// The build each image named in the frames is, by its UUID: what finds its dSYM.
    public static func uuids(of frames: [Frame]) -> [String: String] {
        var result: [String: String] = [:]
        for frame in frames where result[frame.image] == nil && frame.base != 0 {
            if let pointer = UnsafeRawPointer(bitPattern: frame.base), let uuid = uuid(ofImageAt: pointer) {
                result[frame.image] = uuid
            }
        }
        return result
    }

    /// The `LC_UUID` of the Mach-O image whose header is at `header`.
    static func uuid(ofImageAt header: UnsafeRawPointer) -> String? {
        let mach = header.load(as: mach_header_64.self)
        guard mach.magic == MH_MAGIC_64 else { return nil }
        var command = header + MemoryLayout<mach_header_64>.size
        for _ in 0..<mach.ncmds {
            let load = command.load(as: load_command.self)
            if load.cmd == UInt32(LC_UUID) {
                let uuid = command.load(as: uuid_command.self).uuid
                return UUID(uuid: uuid).uuidString
            }
            command += Int(load.cmdsize)
        }
        return nil
    }
}
