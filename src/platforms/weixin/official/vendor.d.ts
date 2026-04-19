declare module 'silk-wasm' {
  export function decode(
    input: Buffer | Uint8Array,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
}
