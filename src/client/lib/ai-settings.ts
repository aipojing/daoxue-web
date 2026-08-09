export interface AIKeyDraft {
  deepseekInput: string;
  visionInput: string;
  visionProvider: 'zhipu' | 'dashscope';
  visionModel: string;
  clearDeepseek: boolean;
  clearVision: boolean;
}

/**
 * 构造 PUT /api/ai-settings 的三态请求体：
 * 清除标记发送 null；非空输入 trim 后覆盖；空输入省略（不修改）。
 * provider 与模型始终随保存提交。
 */
export function buildAISettingsPatch(draft: AIKeyDraft): Record<string, string | null> {
  const patch: Record<string, string | null> = {};

  if (draft.clearDeepseek) patch.deepseekApiKey = null;
  else if (draft.deepseekInput.trim()) patch.deepseekApiKey = draft.deepseekInput.trim();

  if (draft.clearVision) patch.visionApiKey = null;
  else if (draft.visionInput.trim()) patch.visionApiKey = draft.visionInput.trim();

  patch.visionProvider = draft.visionProvider;
  patch.visionModel = draft.visionModel.trim();
  return patch;
}
