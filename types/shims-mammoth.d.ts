declare module 'mammoth' {
  export interface MammothResult { value: string }
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<MammothResult>;
  const _default: { extractRawText: typeof extractRawText };
  export default _default;
}

