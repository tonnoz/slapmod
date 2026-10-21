#!/usr/bin/env python3
"""Synthesizes slapmod's free sounds into sounds/, so the repo owns every clip.

A bonk is a sine whose pitch drops fast, under a short burst of filtered noise
for the thwack; the hard one wobbles like a spring. Same seed, same files.
Run: python3 Scripts/make-sounds.py
"""
import math
import random
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 44_100
PEAK = 0.7  # about -3 dBFS
ATTACK = 0.002
SEED = 7
OUT = Path(__file__).resolve().parent.parent / "sounds"

BONKS = {
    "bonk-light": dict(length=0.18, start_hz=520, end_hz=240, pitch_tau=0.03, amp_tau=0.05, noise=0.25, wobble=0.0),
    "bonk": dict(length=0.28, start_hz=380, end_hz=140, pitch_tau=0.04, amp_tau=0.08, noise=0.35, wobble=0.0),
    "bonk-hard": dict(length=0.45, start_hz=300, end_hz=90, pitch_tau=0.06, amp_tau=0.14, noise=0.5, wobble=0.12),
}
NOISE_LENGTH = 0.012
NOISE_LOWPASS = 0.35
WOBBLE_HZ = 11
WOBBLE_TAU = 0.2


def bonk(length, start_hz, end_hz, pitch_tau, amp_tau, noise, wobble):
    rng = random.Random(SEED)
    samples, phase, smoothed = [], 0.0, 0.0
    for index in range(int(length * SAMPLE_RATE)):
        t = index / SAMPLE_RATE
        hz = end_hz + (start_hz - end_hz) * math.exp(-t / pitch_tau)
        hz *= 1 + wobble * math.sin(2 * math.pi * WOBBLE_HZ * t) * math.exp(-t / WOBBLE_TAU)
        phase += 2 * math.pi * hz / SAMPLE_RATE
        envelope = min(1.0, t / ATTACK) * math.exp(-t / amp_tau)
        value = math.sin(phase) * envelope
        if t < NOISE_LENGTH:
            smoothed += (rng.uniform(-1, 1) - smoothed) * NOISE_LOWPASS
            value += noise * smoothed * (1 - t / NOISE_LENGTH)
        samples.append(value)
    loudest = max(abs(value) for value in samples)
    return [value * PEAK / loudest for value in samples]


def write(name, samples):
    with wave.open(str(OUT / f"{name}.wav"), "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(SAMPLE_RATE)
        clip.writeframes(b"".join(struct.pack("<h", round(value * 32767)) for value in samples))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, shape in BONKS.items():
        write(name, bonk(**shape))
        print(f"sounds/{name}.wav")
