export interface CoursewareQueueMessage {
  coursewareId: number;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  COURSEWARE_MEDIA: R2Bucket;
  COURSEWARE_QUEUE: Queue<CoursewareQueueMessage>;
  DEEPSEEK_API_KEY: string;
  /** 可选：视觉模型（拍照识题）。不配置则前端隐藏拍照按钮 */
  VISION_API_KEY?: string;
  VISION_API_URL?: string;
  VISION_MODEL?: string;
  /** Base64 编码的 32 字节 AES-GCM 主密钥，只能通过 Worker Secret 注入。 */
  AI_SETTINGS_ENCRYPTION_KEY?: string;
}

export interface AuthUser {
  id: number;
  email: string;
  is_admin: number;
  daily_message_limit: number;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
  };
};
