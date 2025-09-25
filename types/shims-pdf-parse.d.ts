declare module 'pdf-parse' {
  type PdfParseResult = { text?: string; numpages?: number; info?: any; metadata?: any };
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}

