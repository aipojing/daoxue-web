export type AdapterType = 'openai_text' | 'token_plan_tts' | 'token_plan_image';
export type AdapterKind = 'text' | 'speech' | 'image';

export function getAdapterKind(adapterType: AdapterType): AdapterKind {
  if (adapterType === 'openai_text') return 'text';
  if (adapterType === 'token_plan_tts') return 'speech';
  return 'image';
}
