export interface SummarizeRequest {
  text: string;
  maxLength?: number;
  minLength?: number;
}

export interface SummarizeResult {
  summary: string;
  inputChars: number;
  inputTokens: number;
  outputChars: number;
  elapsedMs: number;
}

export interface SummarizerHealth {
  status: 'ok' | 'unavailable';
  model: string;
}

export interface ISummarizer {
  summarize(request: SummarizeRequest): Promise<SummarizeResult>;
  isAvailable(): Promise<boolean>;
}
