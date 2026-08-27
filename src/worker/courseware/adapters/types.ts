import type { ResolvedModelSelection } from '../../ai-catalog/repository';

export type NormalizedProviderErrorCode =
  | 'missing_credential'
  | 'invalid_credential'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'invalid_model_output'
  | 'model_unavailable'
  | 'incompatible_voice'
  | 'storage_failed'
  | 'internal_error';

/** The non-secret catalog selection passed from preference resolution to an adapter. */
export type AdapterSelection = Pick<
  ResolvedModelSelection,
  'adapterType' | 'baseUrl' | 'capability' | 'modelId' | 'voiceId' | 'endpointConfig' | 'modelConfig' | 'params'
>;

export interface TextGenerationRequest {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  system: string;
  user: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  responseFormat?: 'json_object' | 'text';
}

export interface TextGenerationResult {
  jsonText: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SpeechSynthesisRequest {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  voiceId: string;
  text: string;
  format: 'mp3';
  sampleRate: 24000;
  allowedMediaHostSuffixes: string[];
  timeoutMs: number;
}

export interface BinaryMediaResult {
  bytes: ArrayBuffer;
  contentType: string;
  requestId: string;
}

export interface ImageGenerationRequest {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  size: string;
  allowedMediaHostSuffixes: string[];
  timeoutMs: number;
}

export interface TextGenerationAdapter {
  generateStructured(request: TextGenerationRequest): Promise<TextGenerationResult>;
}

export interface SpeechSynthesisAdapter {
  synthesize(request: SpeechSynthesisRequest): Promise<BinaryMediaResult>;
}

export interface ImageGenerationAdapter {
  generate(request: ImageGenerationRequest): Promise<BinaryMediaResult>;
}
