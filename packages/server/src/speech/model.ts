import { availableParallelism } from 'node:os';
import { join } from 'node:path';

/**
 * The speech model OpenPaper downloads on first use. NVIDIA Parakeet TDT 0.6B v2 (English, CC-BY-4.0) as the
 * int8 ONNX export sherpa-onnx publishes on Hugging Face, pinned to a commit and checked by size and SHA-256.
 */

export interface ModelFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface SpeechModel {
  /** Folder name under the models dir. */
  id: string;
  /** Human label shown in the editor. */
  label: string;
  files: ModelFile[];
}

/** Hugging Face host; HF_ENDPOINT points it at a mirror where huggingface.co is blocked. */
const HF = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
const REVISION = '1ab9323565ddb038682214b292f588070a538ce2';

const file = (name: string, size: number, sha256: string): ModelFile => ({ name, url: `${HF}/${REPO}/resolve/${REVISION}/${name}`, size, sha256 });

export const PARAKEET_TDT_V2: SpeechModel = {
  id: 'parakeet-tdt-0.6b-v2-int8',
  label: 'Parakeet TDT 0.6B v2',
  files: [
    file('encoder.int8.onnx', 652_184_296, 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab'),
    file('decoder.int8.onnx', 7_257_753, 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e'),
    file('joiner.int8.onnx', 1_739_080, '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2'),
    file('tokens.txt', 9_384, 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d'),
  ],
};

/** sherpa-onnx OfflineRecognizer config for a NeMo transducer in `dir`. Past 4 threads it gets no faster on CPU. */
export function recognizerConfig(dir: string): object {
  return {
    // NeMo models carry their own feature settings; sherpa-onnx reads them from the model metadata.
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx') },
      tokens: join(dir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: Math.min(4, availableParallelism()),
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  };
}
