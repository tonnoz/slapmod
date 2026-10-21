import Foundation
import SlapsenseCore

// slapsense streams the MacBook's motion as JSON lines on stdout:
//   {"type":"ready","version":"0.1.0","model":"Mac16,8"}
//   {"type":"leader"}                            this helper's mod plays the sounds
//   {"type":"level","g":0.012}                   the peak shake since the last level
//   {"type":"slap","g":0.420,"strength":0.62}
//   {"type":"error","code":"no-sensor","message":"..."}
// It exits when its parent does, so it never outlives the mod that started it.

let version = "0.2.0"
let defaultLevelHz = 10.0
let maximumLevelHz = 60.0
let thresholdRange: ClosedRange<Float> = 0.01...1.0
let firstSampleTimeout: TimeInterval = 3
let runLoopSlice: CFTimeInterval = 0.05
let soundLockName = "slapmod-sound.lock"
let leaderCheckInterval: TimeInterval = 1
let launchdPID: pid_t = 1

enum Exit: Int32 {
    case noSensor = 2
    case openFailed = 3
    case noData = 4
    case usage = 64
}

let usage = """
usage: slapsense [--threshold G | --sensitivity low|medium|high] [--level-hz N]
  --threshold    the smallest shake that counts as a slap, in g (\(thresholdRange.lowerBound) to \(thresholdRange.upperBound))
  --sensitivity  a preset threshold instead (default medium)
  --level-hz     motion levels per second, 0 for none (default \(Int(defaultLevelHz)), at most \(Int(maximumLevelHz)))
"""

struct Options {
    var minimumPeak = SlapDetector.Sensitivity.medium.minimumPeak
    var levelHz = defaultLevelHz
}

func parseOptions(_ arguments: [String]) -> Options {
    var options = Options()
    var rest = arguments[...]
    func fail() -> Never {
        FileHandle.standardError.write(Data((usage + "\n").utf8))
        exit(Exit.usage.rawValue)
    }
    while let flag = rest.popFirst() {
        switch flag {
        case "--sensitivity":
            guard let value = rest.popFirst(), let sensitivity = SlapDetector.Sensitivity(rawValue: value) else { fail() }
            options.minimumPeak = sensitivity.minimumPeak
        case "--threshold":
            guard let value = rest.popFirst(), let g = Float(value), thresholdRange.contains(g) else { fail() }
            options.minimumPeak = g
        case "--level-hz":
            guard let value = rest.popFirst(), let hz = Double(value), (0...maximumLevelHz).contains(hz) else { fail() }
            options.levelHz = hz
        case "--version":
            print(version)
            exit(0)
        default:
            fail()
        }
    }
    return options
}

func emit(_ fields: KeyValuePairs<String, Any>) {
    let pairs = fields.map { key, value -> String in
        switch value {
        case let number as Float: return "\"\(key)\":\(String(format: "%.3f", number))"
        case let text as String: return "\"\(key)\":\(quoted(text))"
        default: return "\"\(key)\":null"
        }
    }
    print("{" + pairs.joined(separator: ",") + "}")
}

func quoted(_ text: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed)
    return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
}

func fail(_ code: String, _ message: String, _ status: Exit) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(status.rawValue)
}

/// One slapmod plays the sounds however many Claude sessions run: the helper
/// holding this lock says so to its mod. The lock goes with the process.
final class SoundLeader {
    private let descriptor = open(NSTemporaryDirectory() + soundLockName, O_CREAT | O_RDWR, 0o600)
    private(set) var isLeader = false

    /// True the first time the lock is ours.
    func claim() -> Bool {
        guard !isLeader, descriptor >= 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return false }
        isLeader = true
        return true
    }
}

func machineModel() -> String {
    var size = 0
    sysctlbyname("hw.model", nil, &size, nil, 0)
    var model = [CChar](repeating: 0, count: size)
    sysctlbyname("hw.model", &model, &size, nil, 0)
    return String(cString: model)
}

setvbuf(stdout, nil, _IOLBF, 0)
let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
let parent = getppid()
// An orphan already belongs to launchd: nobody is left to read it.
if parent == launchdPID { exit(0) }

Accelerometer.wake()
let sensor = Accelerometer()
do {
    try sensor.open()
} catch Accelerometer.Failure.noSensor {
    fail("no-sensor", "This Mac has no motion sensor slapmod can read. It needs an Apple Silicon MacBook.", .noSensor)
} catch {
    fail("open-failed", "Could not open the motion sensor.", .openFailed)
}

var detector = SlapDetector(minimumPeak: options.minimumPeak)
let levelInterval = options.levelHz > 0 ? 1 / options.levelHz : .infinity
var levelPeak: Float = 0
var nextLevelAt: TimeInterval = 0

sensor.onSample = { sample, time in
    if let slap = detector.process(x: sample.x, y: sample.y, z: sample.z, time: time) {
        emit(["type": "slap", "g": slap.peak, "strength": slap.strength])
    }
    levelPeak = max(levelPeak, detector.magnitude)
    if time >= nextLevelAt {
        if nextLevelAt > 0 { emit(["type": "level", "g": levelPeak]) }
        levelPeak = 0
        nextLevelAt = time + levelInterval
    }
}

let startedAt = ProcessInfo.processInfo.systemUptime
let leader = SoundLeader()
var isReady = false
var nextLeaderCheck: TimeInterval = 0
while getppid() == parent {
    CFRunLoopRunInMode(.defaultMode, runLoopSlice, true)
    let now = ProcessInfo.processInfo.systemUptime
    if !isReady, sensor.sampleCount > 0 {
        isReady = true
        emit(["type": "ready", "version": version, "model": machineModel()])
    }
    if !isReady, now - startedAt > firstSampleTimeout {
        fail("no-data", "The motion sensor sent nothing.", .noData)
    }
    if isReady, now >= nextLeaderCheck {
        nextLeaderCheck = now + leaderCheckInterval
        if leader.claim() { emit(["type": "leader"]) }
    }
}
