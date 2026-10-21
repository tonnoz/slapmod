import Foundation
import IOKit
import IOKit.hid

/// Reads the motion sensor of an Apple Silicon MacBook (the accelerometer
/// behind the SPU) through IOKit HID. The device is opened shared, not
/// seized, so no root is needed and other apps can read it at the same time.
final class Accelerometer {
    enum Failure: Error {
        case noSensor
        case openFailed(IOReturn)
    }

    /// One sample, in g, and the system uptime it arrived at.
    var onSample: ((SIMD3<Float>, TimeInterval) -> Void)?
    private(set) var sampleCount = 0

    private static let vendorUsagePage = 0xFF00
    private static let accelerometerUsage = 3
    private static let reportIntervalMicroseconds = 1000
    private static let minimumReportLength = 18
    private static let axisOffsets = [6, 10, 14]
    private static let fixedPointScale: Float = 65536

    private let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))

    /// Turns the sensor's reporting on; it can sleep until someone asks.
    static func wake() {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleSPUHIDDriver"), &iterator) == KERN_SUCCESS else { return }
        defer { IOObjectRelease(iterator) }
        var service = IOIteratorNext(iterator)
        while service != 0 {
            IORegistryEntrySetCFProperty(service, "SensorPropertyReportingState" as CFString, 1 as CFNumber)
            IORegistryEntrySetCFProperty(service, "SensorPropertyPowerState" as CFString, 1 as CFNumber)
            IORegistryEntrySetCFProperty(service, "ReportInterval" as CFString, reportIntervalMicroseconds as CFNumber)
            IOObjectRelease(service)
            service = IOIteratorNext(iterator)
        }
    }

    /// Opens the sensor on the current run loop; samples arrive while it runs.
    func open() throws {
        let matching = IOServiceMatching("AppleSPUHIDDevice") as NSMutableDictionary
        matching[kIOHIDPrimaryUsagePageKey] = Self.vendorUsagePage
        matching[kIOHIDPrimaryUsageKey] = Self.accelerometerUsage
        IOHIDManagerSetDeviceMatching(manager, matching)
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)

        let opened = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        guard opened == kIOReturnSuccess else { throw Failure.openFailed(opened) }
        guard let devices = IOHIDManagerCopyDevices(manager), CFSetGetCount(devices) > 0 else { throw Failure.noSensor }

        IOHIDManagerRegisterInputReportCallback(manager, { context, _, _, _, _, report, length in
            guard let context else { return }
            Unmanaged<Accelerometer>.fromOpaque(context).takeUnretainedValue().receive(report, length: length)
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    private func receive(_ report: UnsafePointer<UInt8>, length: CFIndex) {
        guard length >= Self.minimumReportLength else { return }
        func axis(_ offset: Int) -> Float {
            let bits = UInt32(report[offset]) | UInt32(report[offset + 1]) << 8
                | UInt32(report[offset + 2]) << 16 | UInt32(report[offset + 3]) << 24
            return Float(Int32(bitPattern: bits)) / Self.fixedPointScale
        }
        let offsets = Self.axisOffsets
        sampleCount += 1
        onSample?(SIMD3(axis(offsets[0]), axis(offsets[1]), axis(offsets[2])), ProcessInfo.processInfo.systemUptime)
    }
}
