"""Export Beat This! checkpoints to ONNX ([1, 1500, 128] -> beat, downbeat [1, 1500]) and
write the torchaudio mel filterbank as raw float32 [513, 128].

Usage: python export.py OUT_DIR [checkpoint ...]   (default checkpoints: small0 final0)
"""

import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from beat_this.inference import load_model
from beat_this.preprocessing import LogMelSpect


class Wrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):
        out = self.model(spect)
        return out["beat"], out["downbeat"]


def main():
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    names = sys.argv[2:] or ["small0", "final0"]
    mel = LogMelSpect()
    fb = mel.spect_class.mel_scale.fb.detach().numpy().astype("<f4")
    print("filterbank", fb.shape)
    (out_dir / "mel-filterbank.bin").write_bytes(fb.tobytes())

    torch.manual_seed(0)
    probe = torch.rand(1, 1500, 128) * 4
    for name in names:
        model = load_model(name, "cpu")
        wrapper = Wrapper(model).eval()
        path = out_dir / f"beat_this_{name}.onnx"
        with torch.inference_mode():
            ref_beat, ref_down = wrapper(probe)
        torch.onnx.export(
            wrapper,
            (probe,),
            str(path),
            input_names=["spect"],
            output_names=["beat", "downbeat"],
            opset_version=17,
            dynamo=False,
        )
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        beat, down = session.run(None, {"spect": probe.numpy()})
        print(
            name,
            f"{path.stat().st_size / 1e6:.1f} MB",
            "params",
            sum(p.numel() for p in model.parameters()),
            "max|diff| beat",
            float(np.abs(beat - ref_beat.numpy()).max()),
            "downbeat",
            float(np.abs(down - ref_down.numpy()).max()),
        )


if __name__ == "__main__":
    main()
