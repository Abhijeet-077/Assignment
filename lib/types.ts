export type Intent = "nec" | "wattmonk" | "general";

export type Chunk = {
  id: string;
  source: "NEC" | "WATTMONK";
  file: string;
  text: string;
  vector: number[];
  meta?: Record<string, any>;
};

export type RetrievalResult = {
  chunks: Array<{ id: string; source: string; file: string; text: string; score: number }>;
};

