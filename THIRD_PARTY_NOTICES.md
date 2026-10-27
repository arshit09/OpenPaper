# Third-party notices

OpenPaper is MIT-licensed. It bundles or depends on the following software whose licences ask for attribution.

## Paper Shaders

Packages: `@paper-design/shaders` and `@paper-design/shaders-react`, version 0.0.81 — https://github.com/paper-design/shaders
Licence: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)

Shader layers are rendered with this library, and `packages/core/src/shaders/presets.generated.ts` contains preset values taken from it. Its NOTICE file reads:

```
Paper Shaders
Copyright 2026 Paper

Powered by Paper Shaders:
https://shaders.paper.design
```

OpenPaper is not affiliated with or endorsed by Paper (Lost Coast Labs, Inc.).

## Figma clipboard decoding

- `kiwi-schema` 0.5.0 — MIT, by Evan Wallace — https://github.com/evanw/kiwi
- `fflate` 0.8.3 — MIT, Copyright (c) 2026 Arjun Barrett — https://github.com/101arrowz/fflate
- `fzstd` 0.1.1 — MIT, Copyright (c) 2020 Arjun Barrett — https://github.com/101arrowz/fzstd

Figma is a trademark of Figma, Inc. OpenPaper is not affiliated with Figma.

## Voice input

Speech is transcribed on the user's computer. The engine is an optional dependency, and the model is downloaded on first use rather than shipped with OpenPaper.

- `sherpa-onnx-node` 2.0.1 — Apache License 2.0, by the k2-fsa / Next-gen Kaldi team — https://github.com/k2-fsa/sherpa-onnx
- ONNX Runtime (bundled inside sherpa-onnx) — MIT, Copyright (c) Microsoft Corporation — https://github.com/microsoft/onnxruntime
- Model: NVIDIA Parakeet TDT 0.6B v2 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), in the int8 ONNX export by the sherpa-onnx project (https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8). Licence: Creative Commons Attribution 4.0 International (CC-BY-4.0, https://creativecommons.org/licenses/by/4.0/). The model was converted to ONNX and quantized to int8; OpenPaper uses it unmodified from that export.

NVIDIA and Parakeet are trademarks of NVIDIA Corporation. OpenPaper is not affiliated with NVIDIA.

Other dependencies are listed in each package's `package.json`; their licences ship with them in `node_modules`.
