export interface AIKeyDraft {
  deepseekInput: string;
  visionInput: string;
  visionProvider: 'zhipu' | 'dashscope';
  visionModel: string;
  clearDeepseek: boolean;
  clearVision: boolean;
  profileRefineIntervalMinutes: number;
  profileRefineDailyLimit: number;
}

export interface SharedAISettingsDraft {
  deepseekInput: string;
  visionInput: string;
  visionApiUrl: string;
  visionModel: string;
  sharedFallbackEnabled: boolean;
}

/**
 * 构造 PUT /api/ai-settings 的三态请求体：
 * 清除标记发送 null；非空输入 trim 后覆盖；空输入省略（不修改）。
 * provider 与模型始终随保存提交。
 */
export function buildAISettingsPatch(draft: AIKeyDraft): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = {};

  if (draft.clearDeepseek) patch.deepseekApiKey = null;
  else if (draft.deepseekInput.trim()) patch.deepseekApiKey = draft.deepseekInput.trim();

  if (draft.clearVision) patch.visionApiKey = null;
  else if (draft.visionInput.trim()) patch.visionApiKey = draft.visionInput.trim();

  patch.visionProvider = draft.visionProvider;
  patch.visionModel = draft.visionModel.trim();
  patch.profileRefineIntervalMinutes = draft.profileRefineIntervalMinutes;
  patch.profileRefineDailyLimit = draft.profileRefineDailyLimit;
  return patch;
}

export function buildSharedAISettingsPatch(
  draft: SharedAISettingsDraft,
): Record<string, string | boolean> {
  const patch: Record<string, string | boolean> = {
    visionApiUrl: draft.visionApiUrl.trim(),
    visionModel: draft.visionModel.trim(),
    sharedFallbackEnabled: draft.sharedFallbackEnabled,
  };
  if (draft.deepseekInput.trim()) patch.deepseekApiKey = draft.deepseekInput.trim();
  if (draft.visionInput.trim()) patch.visionApiKey = draft.visionInput.trim();
  return patch;
}

export function validateProfileRefineSettings(intervalMinutes: number, dailyLimit: number): string | null {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    return '画像提炼间隔需为 1–1440 的整数（分钟）';
  }
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000) {
    return '每日提炼上限需为 0–1000 的整数（0 表示不限）';
  }
  return null;
}
