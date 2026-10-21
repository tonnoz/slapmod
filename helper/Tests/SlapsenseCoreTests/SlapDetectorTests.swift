import Foundation
import XCTest
@testable import SlapsenseCore

final class SlapDetectorTests: XCTestCase {
    private let sampleRate = 800.0
    private let ringHz = 120.0
    private let ringDecay = 0.02
    private let ringLength = 0.06
    private let noiseG: Float = 0.002
    private let noisePhaseStep = 2.39996

    /// A MacBook lying flat for `seconds`, with faint noise and a damped
    /// ring of `g` at each impulse time, as a slap shakes the case.
    private func slaps(
        _ sensitivity: SlapDetector.Sensitivity = .medium,
        seconds: Double = 3,
        impulses: [(at: Double, g: Float)] = [],
        tilt: Double = 0
    ) -> [SlapDetector.Slap] {
        var detector = SlapDetector(sensitivity: sensitivity)
        var found: [SlapDetector.Slap] = []
        for index in 0..<Int(seconds * sampleRate) {
            let time = Double(index) / sampleRate
            let angle = tilt * min(1, time / seconds)
            var z = Float(-cos(angle))
            let y = Float(sin(angle))
            for impulse in impulses where time >= impulse.at && time < impulse.at + ringLength {
                let since = time - impulse.at
                z += impulse.g * Float(sin(2 * .pi * ringHz * since) * exp(-since / ringDecay))
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
        let found = slaps(impulses: [(1.0, 0.5)])
        XCTAssertEqual(found.count, 1)
        XCTAssertGreaterThan(found.first?.strength ?? 0, 0.4)
    }

    func testRingingRightAfterIsTheSameSlap() {
        XCTAssertEqual(slaps(impulses: [(1.0, 0.5), (1.15, 0.5)]).count, 1)
    }

    func testTwoSlapsApartAreTwo() {
        XCTAssertEqual(slaps(impulses: [(1.0, 0.5), (1.8, 0.5)]).count, 2)
    }

    func testSensitivityDecidesATap() {
        let tap: [(at: Double, g: Float)] = [(1.0, 0.07)]
        XCTAssertEqual(slaps(.low, impulses: tap).count, 0)
        XCTAssertEqual(slaps(.high, impulses: tap).count, 1)
    }

    func testAHarderSlapIsStronger() {
        let soft = slaps(impulses: [(1.0, 0.2)]).first?.strength ?? 0
        let hard = slaps(impulses: [(1.0, 1.5)]).first?.strength ?? 0
        XCTAssertGreaterThan(hard, soft)
        XCTAssertLessThanOrEqual(hard, 1)
    }
}
