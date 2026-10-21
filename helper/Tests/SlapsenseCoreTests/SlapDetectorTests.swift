import Foundation
import XCTest
@testable import SlapsenseCore

final class SlapDetectorTests: XCTestCase {
    private let sampleRate = 800.0
    private let ringHz = 120.0
    private let shortRing = 0.02
    private let longRing = 0.15
    private let ringLengthInDecays = 6.0
    private let noiseG: Float = 0.002
    private let noisePhaseStep = 2.39996

    /// A shake of `g` at `at` seconds that rings with this decay, as a slap
    /// rings the case.
    private struct Impulse {
        let at: Double
        let g: Float
        var decay = 0.02
    }

    /// A MacBook lying flat for `seconds`, with faint noise and the impulses.
    private func slaps(
        _ detector: SlapDetector = SlapDetector(),
        seconds: Double = 3,
        impulses: [Impulse] = [],
        tilt: Double = 0
    ) -> [SlapDetector.Slap] {
        var detector = detector
        var found: [SlapDetector.Slap] = []
        for index in 0..<Int(seconds * sampleRate) {
            let time = Double(index) / sampleRate
            let angle = tilt * min(1, time / seconds)
            var z = Float(-cos(angle))
            let y = Float(sin(angle))
            for impulse in impulses where time >= impulse.at && time < impulse.at + impulse.decay * ringLengthInDecays {
                let since = time - impulse.at
                z += impulse.g * Float(sin(2 * .pi * ringHz * since) * exp(-since / impulse.decay))
            }
            z += noiseG * Float(sin(Double(index) * noisePhaseStep))
            if let slap = detector.process(x: 0, y: y, z: z, time: time) { found.append(slap) }
        }
        return found
    }

    func testAQuietDeskIsNoSlap() {
        XCTAssertEqual(slaps().count, 0)
    }

    func testTiltingTheLidIsNoSlap() {
        XCTAssertEqual(slaps(tilt: .pi / 6).count, 0)
    }

    func testOneSlapIsOneEvent() {
        let found = slaps(impulses: [Impulse(at: 1.0, g: 0.5)])
        XCTAssertEqual(found.count, 1)
        XCTAssertGreaterThan(found.first?.strength ?? 0, 0.4)
    }

    func testRingingRightAfterIsTheSameSlap() {
        XCTAssertEqual(slaps(impulses: [Impulse(at: 1.0, g: 0.5), Impulse(at: 1.15, g: 0.5)]).count, 1)
    }

    func testAQuickDoubleSlapIsTwo() {
        XCTAssertEqual(slaps(impulses: [Impulse(at: 1.0, g: 0.5), Impulse(at: 1.22, g: 0.5)]).count, 2)
    }

    func testALongRingIsOneSlap() {
        XCTAssertEqual(slaps(impulses: [Impulse(at: 1.0, g: 0.8, decay: longRing)]).count, 1)
    }

    func testTwoSlapsApartAreTwo() {
        XCTAssertEqual(slaps(impulses: [Impulse(at: 1.0, g: 0.5), Impulse(at: 1.8, g: 0.5)]).count, 2)
    }

    func testSensitivityDecidesATap() {
        let tap = [Impulse(at: 1.0, g: 0.07)]
        XCTAssertEqual(slaps(SlapDetector(sensitivity: .low), impulses: tap).count, 0)
        XCTAssertEqual(slaps(SlapDetector(sensitivity: .high), impulses: tap).count, 1)
    }

    func testTheThresholdDecidesATap() {
        let tap = [Impulse(at: 1.0, g: 0.07)]
        XCTAssertEqual(slaps(SlapDetector(minimumPeak: 0.1), impulses: tap).count, 0)
        XCTAssertEqual(slaps(SlapDetector(minimumPeak: 0.05), impulses: tap).count, 1)
    }

    func testAHarderSlapIsStronger() {
        let soft = slaps(impulses: [Impulse(at: 1.0, g: 0.2)]).first?.strength ?? 0
        let hard = slaps(impulses: [Impulse(at: 1.0, g: 1.5)]).first?.strength ?? 0
        XCTAssertGreaterThan(hard, soft)
        XCTAssertLessThanOrEqual(hard, 1)
    }
}
