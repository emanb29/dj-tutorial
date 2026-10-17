"""Reference outputs from the upstream PyTorch Beat This! (minimal postprocessing).

  python reference.py fixture OUT.f32           log-mel of the deterministic test signal (src/analysis/fixtures/logmel-reference.f32, checked by src/analysis/mel.test.ts)
  python reference.py beats OUT.json WAV...      beats/downbeats per checkpoint (small0, final0) for each WAV

Needs: torch, torchaudio, soxr, einops, rotary-embedding-torch, soundfile and beat_this
(https://github.com/CPJKU/beat_this, commit b95c8ab).
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

from beat_this.inference import Audio2Beats
from beat_this.preprocessing import LogMelSpect


def test_signal(n=44100, sr=22050):
    i = np.arange(n, dtype=np.float64)
    tone = 0.5 * np.sin(2 * np.pi * 440 * i / sr)
    gate = ((i % 11025) < 2000).astype(np.float64)
    thump = 0.3 * np.sin(2 * np.pi * 97 * i / sr) * gate
    return (tone + thump).astype(np.float32)


def fixture(out):
    spect = LogMelSpect()(torch.from_numpy(test_signal())).numpy().astype("<f4")
    print("fixture", spect.shape)
    Path(out).write_bytes(spect.tobytes())


def beats(out, wavs):
    results = {}
    for name in ["small0", "final0"]:
        tracker = Audio2Beats(name, "cpu")
        for wav in wavs:
            signal, sr = sf.read(wav, dtype="float64")
            started = time.perf_counter()
            with torch.inference_mode():
                beat, downbeat = tracker(signal, sr)
            elapsed = time.perf_counter() - started
            results.setdefault(Path(wav).stem, {})[name] = {
                "seconds": elapsed,
                "beats": [float(b) for b in beat],
                "downbeats": [float(d) for d in downbeat],
            }
            print(Path(wav).stem, name, f"{elapsed:.1f} s", len(beat), "beats", len(downbeat), "downbeats")
    Path(out).write_text(json.dumps(results))


if __name__ == "__main__":
    torch.set_num_threads(8)
    if sys.argv[1] == "fixture":
        fixture(sys.argv[2])
    else:
        beats(sys.argv[2], sys.argv[3:])
