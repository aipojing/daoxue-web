export interface CoursewareFeatureStatus {
  enabled: boolean;
  providerCount: number;
  enabledModelCount: number;
  failedLast24Hours: number;
}

interface CountRow {
  count: number;
}

/**
 * Only aggregates are returned here. In particular this deliberately avoids
 * courseware titles, prompts, scripts, child profiles, and raw provider errors.
 */
export async function getCoursewareFeatureStatus(db: D1Database): Promise<CoursewareFeatureStatus> {
  const [setting, providers, enabledModels, failures] = await Promise.all([
    db.prepare("SELECT value FROM app_settings WHERE key = 'courseware_enabled'")
      .first<{ value: string }>(),
    db.prepare('SELECT COUNT(*) AS count FROM ai_providers').first<CountRow>(),
    db.prepare(
      `SELECT COUNT(*) AS count
       FROM ai_models m
       JOIN ai_provider_endpoints e ON e.id = m.endpoint_id
       JOIN ai_providers p ON p.id = e.provider_id
       WHERE p.enabled = 1 AND e.enabled = 1 AND m.enabled = 1`,
    ).first<CountRow>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM coursewares
       WHERE status = 'failed' AND updated_at >= datetime('now', '-24 hours')`,
    ).first<CountRow>(),
  ]);
  return {
    enabled: setting?.value === '1',
    providerCount: providers?.count ?? 0,
    enabledModelCount: enabledModels?.count ?? 0,
    failedLast24Hours: failures?.count ?? 0,
  };
}

export async function setCoursewareFeatureEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('courseware_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).bind(enabled ? '1' : '0').run();
}
