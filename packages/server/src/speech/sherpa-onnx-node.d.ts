/** The slice of sherpa-onnx-node (an untyped CommonJS package with a native addon) that the speech engine uses. */
declare module 'sherpa-onnx-node' {
  interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  interface OfflineStream {
    acceptWaveform(wave: Waveform): void;
  }

  interface OfflineRecognizer {
    createStream(): OfflineStream;
    /** Decodes on a libuv worker thread. */
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
  }

  const sherpa: {
    OfflineRecognizer: { createAsync(config: object): Promise<OfflineRecognizer> };
    version: string;
  };
  export default sherpa;
}
