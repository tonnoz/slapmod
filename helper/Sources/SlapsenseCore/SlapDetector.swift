import Foundation

/// Finds slaps in a stream of accelerometer samples, in g.
///
/// A one-pole high-pass filter removes gravity and slow tilting and leaves the
/// shake. A slap is a shake above both a fixed floor (the sensitivity) and a
/// multiple of the recent noise. Its strength is the peak over a short window
/// after it starts, and the detector then rests so one slap's ringing is not
/// counted twice. Pure logic with no IOKit, so tests can feed it samples.
public struct SlapDetector {
    public enum Sensitivity: String, CaseIterable, Sendable {
        case low, medium, high

        /// The smallest shake, in g, that can count as a slap.
        public var minimumPeak: Float {
            switch self {
            case .low: return 0.15
            case .medium: return 0.08
            case .high: return 0.04
            }
        }
    }

    public struct Slap: Equatable, Sendable {
        /// The peak shake, in g.
        public let peak: Float
        /// From 0 (barely a slap) to 1 (a hard one), on one scale for every
        /// sensitivity.
        public let strength: Float
    }

    private static let highPassAlpha: Float = 0.95
    private static let noiseFloorAlpha: Float = 0.0005
    private static let initialNoiseFloor: Float = 0.005
    private static let noiseRatio: Float = 4
    private static let warmup: Double = 0.3
    private static let peakWindow: Double = 0.05
    private static let restAfterSlap: Double = 0.4
    private static let strengthFloor: Float = 0.03
    private static let strengthCeiling: Float = 2.0

    public let sensitivity: Sensitivity
    /// The latest shake, in g, with gravity removed.
    public private(set) var magnitude: Float = 0

    private enum Phase {
        case idle
        case measuring(until: Double, peak: Float)
        case resting(until: Double)
    }

    private var previous: SIMD3<Float>?
    private var filtered = SIMD3<Float>(repeating: 0)
    private var noiseFloor = initialNoiseFloor
    private var warmUntil: Double?
    private var phase = Phase.idle

    public init(sensitivity: Sensitivity = .medium) {
        self.sensitivity = sensitivity
    }

    /// Feeds one sample taken at `time` seconds; returns a slap once its peak
    /// window has passed.
    public mutating func process(x: Float, y: Float, z: Float, time: Double) -> Slap? {
        let sample = SIMD3(x, y, z)
        defer { previous = sample }
        guard let previous else {
            warmUntil = time + Self.warmup
            return nil
        }
        filtered = Self.highPassAlpha * (filtered + sample - previous)
        magnitude = (filtered * filtered).sum().squareRoot()

        if let warmUntil, time < warmUntil {
            settleNoise()
            return nil
        }
        switch phase {
        case .idle:
            if magnitude > threshold {
                phase = .measuring(until: time + Self.peakWindow, peak: magnitude)
            } else {
                settleNoise()
            }
            return nil
        case let .measuring(until, peak):
            let peak = max(peak, magnitude)
            guard time >= until else {
                phase = .measuring(until: until, peak: peak)
                return nil
            }
            phase = .resting(until: time + Self.restAfterSlap)
            return Slap(peak: peak, strength: Self.strength(of: peak))
        case let .resting(until):
            if time >= until { phase = .idle }
            return nil
        }
    }

    private var threshold: Float {
        max(sensitivity.minimumPeak, noiseFloor * Self.noiseRatio)
    }

    private mutating func settleNoise() {
        noiseFloor += (magnitude - noiseFloor) * Self.noiseFloorAlpha
    }

    static func strength(of peak: Float) -> Float {
        let scale = log(strengthCeiling / strengthFloor)
        return min(1, max(0, log(peak / strengthFloor) / scale))
    }
}
