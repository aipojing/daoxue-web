# 可配置模型的语音互动课件设计

## 状态

- 日期：2026-08-26
- 分支：design/voice-interactive-courseware
- 状态：产品范围、技术方向和视觉方向均已由用户批准
- 视觉基准：[课程对话时间线设计稿](assets/2026-08-26-voice-interactive-courseware-ui.png)

## 背景

当前“自学陪伴”会在会话中生成一段 OpenMAIC 提示词，要求家长或孩子复制到外部站点上课，学完后再回到本项目继续正式测验。这个流程存在三个问题：

1. 学习过程跨站点，家长和孩子需要来回切换，学习上下文不能完整留在本项目。
2. 课件、播放进度、学习过程和正式测验没有统一数据归属。
3. 年龄较小或识字能力有限的孩子不能只依赖文字，需要老师语音持续讲解。

目标是在当前项目内部增加“语音互动课件”：AI 老师讲解，AI 同学主动提出典型问题和错误理解，老师再解释或纠正。孩子不需要主动开口提问，也不要求第一版实现实时语音对话。

## 产品目标

1. 在现有孩子自学流程中直接生成、播放并保存语音互动课件。
2. 把 AI 同学提问作为课件脚本的一部分，而不是依赖孩子主动提问。
3. 保留现有课后一题一答正式测验，并继续用它生成掌握证据和 L1–L4 等级。
4. 家长自备模型服务密钥；没有密钥、密钥无效或额度耗尽时禁止新生成。
5. 已经成功生成的旧课件不受当前密钥或额度状态影响，仍可播放。
6. 文本、语音和图片模型均由配置选择，不把具体模型 ID、音色或 Base URL 写死在课件业务代码中。
7. 使用 Cloudflare Queue 在后台生成，用户离开页面后任务仍可继续。
8. 在保留当前“黑板绿、暖纸白”设计语言的基础上，把孩子相关页面升级为清晰、精细的 AI 学习工作台。

## 非目标

第一版不包含：

- 孩子与模型的实时语音对话。
- 孩子语音识别或口语评分。
- 声音复刻、声音设计和儿童定制音色训练。
- PPTX 文件导出。
- 自由拖拽课件编辑器。
- 视频生成。
- OpenMAIC 完整运行时、任意 HTML/JavaScript 课件执行或多 Agent 运行时。
- 普通用户填写任意服务商 Base URL。
- 对现有普通辅导会话和课后测验的模型体系做全面迁移。

## 核心决策

### 课件不是 PPT 文件

第一版课件是本项目内可播放的结构化教学时间线。它可以包含讲解、公式、配图、语音、AI 同学提问、备用讲法和轻量检查，但不输出 PowerPoint 文件。

### AI 同学属于课件脚本

AI 同学由生成脚本主动安排，承担以下职责：

- 提出孩子常见但可能不好意思问的问题。
- 给出典型错误理解或错误答案。
- 在老师讲解过快时请求换一种说法。
- 帮助孩子看到“别人也会不懂”，降低提问压力。

AI 同学不等待孩子触发，也不在第一版进行实时自由对话。

### 正式测验与课内检查分离

课件中的轻量检查只用于保持注意力和提供即时反馈，可以跳过，不直接更新 L1–L4。

完成课件后，孩子进入现有会话式正式测验。正式测验继续采用一题一答，并负责：

- 记录作答证据。
- 生成错题卡。
- 更新知识点掌握等级。
- 生成每课输出和家长反馈。

### 语音是必需能力

文字脚本和语音全部完成后，课件才能进入可播放状态。没有可用语音配置时不生成纯文字降级课件，也不使用浏览器 Web Speech API 兜底。

图片模型是可选能力。图片失败不阻断语音课件完成，可以之后单独重试。

## 信息架构

### 外层与孩子工作台

外层继续负责学生管理、账户级 AI 服务和全局设置。进入某个孩子后，使用 StudentWorkspaceLayout：

- 左侧是孩子功能菜单。
- 右侧是当前功能工作区。
- 顶部不再重复全站主导航。
- 左侧底部提供“AI 服务”和“返回学生列表”。

孩子菜单按任务分组：

学习：

- 今日学习
- AI 辅导
- 语音课件

巩固：

- 正式测验
- 错题复习

档案：

- 知识掌握
- 学习档案

现有辅导、自学、错题和学生详情能力必须保留；改版只改变承载方式和入口层级，不删除已有功能。

### 自学主流程

    选择或确认今日知识点
        → 生成语音互动课件
        → 后台生成，用户可以离开
        → 播放老师与 AI 同学参与的课程
        → 完成轻量课内检查
        → 返回现有会话进行正式一题一答测验
        → 更新错题、知识点和学习档案

## 视觉与交互设计

采用已选择的“课程对话时间线”方向。

### 桌面布局

- 左侧导航宽度约 224–240 像素，深黑板绿色背景。
- 右侧使用暖纸白底色和清晰的纵向课程时间线。
- 时间线片段区分“老师讲解”“AI 同学提问”“老师换一种说法”“课内小检查”和“总结”。
- 当前播放片段用浅绿色背景、语音状态和时间线节点共同强调。
- 底部固定播放器，不随着正文滚动离开视野。

### 播放器

播放器提供：

- 上一段。
- 播放或暂停。
- 下一段。
- 当前时间与总时长。
- 进度拖动。
- 播放速度。
- 重播本句。
- “我没听懂”。
- “继续学习”。

“我没听懂”只播放该知识点预先生成的备用讲法，不触发临时模型请求。

浏览器禁止自动播放时，页面显示明显的“开始上课”按钮。孩子首次点击后才能连续播放后续片段。

### 页面状态

同一个语音课件区域覆盖四种主要状态：

1. 未生成：显示知识点、预计时长、模型配置状态和“生成语音课件”。
2. 后台生成中：显示脚本、老师语音、AI 同学语音、配图等阶段和总体进度，明确提示“可以离开，后台会继续”。
3. 已完成：显示课程时间线和固定播放器。
4. 失败：显示规范化错误、已完成片段、可否重试以及前往 AI 服务设置的入口。

### 响应式与无障碍

- 平板端左侧菜单可收起，底部播放器保留。
- 手机端左侧菜单变为抽屉，课程时间线单列显示。
- 正文使用 14–16 像素基准字号，孩子关键操作使用更大的点击区域。
- 当前语音同步高亮对应台词。
- 控件具备键盘焦点和可理解的 aria 标签。
- 遵循 prefers-reduced-motion，减少非必要动画。
- 不只依赖颜色表达成功、失败和当前状态。

## 课件内容模型

课件脚本使用带版本的结构化 JSON，而不是任意 HTML。

概念结构如下：

    interface CoursewareScript {
      schemaVersion: 1;
      title: string;
      subject: string;
      grade: string;
      topic: string;
      learningObjectives: string[];
      estimatedMinutes: number;
      segments: CoursewareScriptSegment[];
    }

    type SegmentKind =
      | 'teacher_intro'
      | 'teacher_explanation'
      | 'student_question'
      | 'student_misconception'
      | 'teacher_reframe'
      | 'checkpoint'
      | 'summary';

    interface CoursewareScriptSegment {
      segmentKey: string;
      kind: SegmentKind;
      speaker: 'teacher' | 'student' | 'system';
      title: string;
      displayMarkdown: string;
      speechText: string;
      alternateExplanation?: {
        displayMarkdown: string;
        speechText: string;
      };
      visual?: {
        mode: 'formula' | 'generated_image' | 'none';
        prompt?: string;
        altText?: string;
      };
      checkpoint?: {
        prompt: string;
        options?: string[];
        correctAnswer: string;
        explanation: string;
      };
    }

displayMarkdown 只允许现有安全 Markdown 与 KaTeX 能力。speechText 是专门为朗读准备的文本，例如把复杂公式转换为自然中文，不直接照读 LaTeX 标记。

服务端使用严格 schema 校验模型输出。未知字段、过长内容、空语音、无效片段顺序和不兼容的 visual/checkpoint 组合均拒绝入库，并进入可重试失败状态。

## 可配置模型体系

### 目标

课件业务只依赖“能力”，不依赖具体厂商或模型名称：

- structured_text：生成结构化课件脚本。
- speech_synthesis：生成老师、AI 同学和备用讲法语音。
- image_generation：生成可选教学配图。

模型 ID、服务地址、协议、音色、格式和默认选择来自数据库配置。

### 服务商与模型目录

新增以下配置实体：

ai_providers：

- 服务商标识和展示名称。
- 协议适配器类型。
- 管理员维护的固定 Base URL。
- 能力范围。
- 启用状态。
- 非敏感协议参数。

ai_models：

- 所属服务商。
- 模型 ID 和展示名称。
- 能力类型。
- 支持的输入、输出和格式参数。
- 可用音色和音色元数据。
- 是否推荐、是否启用和展示顺序。

使用已支持协议的新模型时，管理员只需新增或修改目录数据，不需要修改课件业务代码。完全不同的新协议仍需要新增适配器。

### 用户凭据与偏好

user_ai_credentials：

- 按 user_id 和 provider_id 保存用户自己的服务商密钥。
- 使用现有 AES-256-GCM 主密钥加密。
- AAD 绑定用户和服务商，防止跨用户或跨服务商替换密文。
- 前端只返回是否已设置和尾号掩码。

user_model_preferences：

- 课件脚本模型。
- 课件图片模型，可为空。
- 老师语音模型与音色。
- AI 同学语音模型与音色。
- 音频格式、采样率和允许的通用参数。

普通家长可以：

- 从管理员启用的服务商和模型中选择。
- 填写个人密钥。
- 在适配器明确允许时填写自定义模型 ID；第一版只对 OpenAI 兼容文本能力开放，语音和图片仍要求管理员先登记模型参数。
- 选择老师和 AI 同学音色。
- 执行连接测试、试听和图片测试。

普通家长不能填写 Base URL。服务商地址、协议适配器和安全边界由管理员维护。

### 适配器

    interface TextGenerationAdapter {
      generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationResult>;
    }

    interface SpeechSynthesisAdapter {
      synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
    }

    interface ImageGenerationAdapter {
      generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
    }

第一批适配器覆盖：

- OpenAI 兼容文本生成。
- 项目现有 DeepSeek 文本能力的兼容接入。
- 百炼 Token Plan 语音合成。
- 百炼 Token Plan 图片生成。

初始目录可以预置当前可用的千问文本、语音和图片模型，但预置项也是迁移数据，不是业务代码常量。管理员可以停用、替换或追加。

初始推荐项可以包含 qwen-audio-3.0-tts-plus，并把 longanlingxin 设为老师推荐音色、longanlufeng 设为 AI 同学推荐音色；这些只是可修改的种子数据，不是强制选择。

### 配置快照

每份课件保存实际使用的：

- 服务商 ID。
- 模型 ID。
- 音色 ID。
- 适配器版本。
- 提示词版本。
- 课件 schema 版本。

用户之后修改默认模型只影响新课件，不改变旧课件的内容和播放。

### 与现有 AI 设置的关系

现有 DeepSeek 和视觉配置继续服务普通聊天、图片识题、错题提取、自学处理和画像提炼。第一版不强制把这些旧流程全部迁移到新目录。

课件模块优先使用新的服务商凭据和课件偏好。若用户选择现有 DeepSeek 作为课件脚本模型，解析层可以复用当前用户已经配置的个人 DeepSeek Key。课件的文本、语音和图片生成都执行严格 BYOK，不得静默使用站点共享 Key。

## 数据模型

### coursewares

保存课件及后台任务的主状态：

- id。
- student_id。
- source_conversation_id，可为空。
- assessment_conversation_id，可为空，用于关联课后正式测验。
- subject、grade、topic、title。
- status：queued、generating、ready、failed。
- generation_stage：scripting、speech、images、finalizing。
- progress_percent。
- current_segment_position。
- script_schema_version。
- prompt_version。
- text_provider/model 快照。
- image_provider/model 快照，可为空。
- teacher_tts_provider/model/voice 快照。
- student_tts_provider/model/voice 快照。
- text_input_tokens、text_output_tokens、tts_character_count、image_count。
- error_code、error_message、retryable。
- lease_token、lease_expires_at。
- created_at、updated_at、completed_at。

所有权通过 student_id 关联现有 students.user_id；任何读取、重试、删除和播放都必须先验证所属账户。

### courseware_segments

保存逐段脚本与生成产物：

- id、courseware_id、position、segment_key。
- kind、speaker、title。
- display_markdown、speech_text。
- alternate_display_markdown、alternate_speech_text。
- visual_mode、visual_prompt、visual_alt_text。
- checkpoint_json。
- generation_status。
- audio_object_key、audio_duration_ms。
- alternate_audio_object_key、alternate_audio_duration_ms。
- image_object_key。
- error_code、error_message、retry_count。
- created_at、updated_at。

courseware_id 与 position 唯一，courseware_id 与 segment_key 唯一。Queue 重试通过这些唯一键和生成状态实现幂等。

### AI 配置表

新增：

- ai_providers。
- ai_models。
- user_ai_credentials。
- user_model_preferences。

现有 user_ai_settings 保留，避免扩大普通聊天配置迁移范围。

## R2 存储

新增私有 R2 binding。对象键按所有权和课件分层：

    courseware/{userId}/{studentId}/{coursewareId}/audio/{segmentId}.mp3
    courseware/{userId}/{studentId}/{coursewareId}/audio/{segmentId}-alternate.mp3
    courseware/{userId}/{studentId}/{coursewareId}/images/{segmentId}.webp

浏览器不接收可枚举的 R2 内部键。音频和图片通过鉴权后的 Worker 路由读取，或由 Worker 生成短期受控访问地址。无论采用哪种方式，服务端先校验当前账户拥有对应学生。

音频读取路由必须支持 HTTP Range 请求和正确的 Content-Type、Content-Length、Accept-Ranges 响应，保证拖动进度、断点读取和移动端播放正常。图片路由返回正确内容类型和受控缓存头。

第一版使用 R2 Standard 存储类型。用户可以显式删除课件以释放空间；自动过期和跨存储层归档不在第一版范围内。

## 后台生成架构

### 创建任务

前端提交知识点、来源会话和可选课件参数。Worker 依次：

1. 从会话用户校验学生所有权。
2. 校验学习画像和输入范围。
3. 解析文本、语音和可选图片模型偏好。
4. 确认必需凭据存在，但不把密钥写入任务消息。
5. 创建 coursewares 记录，状态为 queued。
6. 向 Queue 发送仅包含 coursewareId 的小消息。
7. 立即返回课件 ID 和查询状态地址。

### Queue 消费

消费者按课程 ID 加载所有权、配置和加密凭据，并使用 D1 条件更新获取短租约。已有 operation lease 模式可以复用其并发控制思路。

单次消费只处理有限工作：

- 脚本尚未生成时，完成一次结构化脚本生成和校验。
- 脚本已生成后，每次选择 3–5 个未完成的语音或图片产物。
- 批次完成后更新进度；仍有工作则重新投递同一个 coursewareId。
- 所有必需语音完成后进入 finalizing。
- 校验完整性通过后状态改为 ready。

这样可以控制 Workers 免费套餐的 CPU 和外部请求压力，也能在网络失败、队列重试和部署切换后续跑。

### 幂等

- Queue 消息不代表“重新生成全部”，只代表“推进该课件到下一状态”。
- 消费前检查 courseware 和 segment 状态。
- 已有 R2 对象和已完成数据库状态的片段直接跳过。
- 对象键固定，同一片段不会产生无限新对象。
- D1 租约防止两个消费者同时生成同一课件。
- 成功写入 R2 后再以条件更新提交 segment 完成状态。

极端情况下，外部模型已经计费但 Worker 在保存状态前中断，仍可能发生一次重复外部调用；日志和模型请求 ID 需要保留以便分析，不能承诺跨供应商绝对 exactly-once。

## 生成流程

### 输入上下文

脚本生成使用：

- 学生年级和学科。
- 当前知识点和学习目标。
- 孩子学习画像中与本课相关的偏好、困难反应和禁忌。
- 已掌握或需保温的关联知识点。
- 来源自学会话的任务确认结果。
- 课件时长和难度约束。

不得把无关的完整历史会话、其他学生数据或服务商密钥放入提示词。

### 脚本生成

模型必须返回结构化 JSON。提示词要求：

- 语言符合孩子年龄。
- 老师讲解短句化、适合朗读。
- AI 同学至少提出一个有效问题和一个典型误解。
- 每个核心难点提供备用讲法。
- 课内检查轻量、可跳过。
- 不把检查结果描述为正式掌握结论。
- 配图提示词不包含个人身份信息。

### 语音生成

老师、AI 同学和备用讲法分别根据配置快照选择服务商、模型和音色。模型与音色必须来自同一兼容目录；保存设置和创建任务时都要校验兼容性。

输出优先使用浏览器兼容的压缩格式，并保存时长和内容类型。不同供应商返回临时 URL 或直接音频二进制时，由适配器统一转成可上传 R2 的结果，不能长期依赖供应商临时地址。

### 图片生成

只有 visual.mode 为 generated_image 且用户配置图片模型时才生成配图。

- 图片不包含孩子真实姓名、头像或其他个人信息。
- 适配器统一输出可保存的图片二进制。
- 生成后转换或规范化为浏览器友好格式和合理尺寸。
- 图片失败记录在片段上，但不阻止语音课件 ready。
- 页面使用 visual_alt_text 提供无障碍替代文本。

## API 设计

接口名称可在实施阶段按现有 Hono 组织微调，但职责固定。

### 课件

- GET /api/students/:studentId/coursewares：列出课件与生成状态。
- POST /api/students/:studentId/coursewares：创建后台生成任务。
- GET /api/coursewares/:coursewareId：读取课件、片段、进度和错误。
- POST /api/coursewares/:coursewareId/retry：从未完成状态继续。
- PATCH /api/coursewares/:coursewareId/progress：保存当前播放位置和课内检查进度。
- DELETE /api/coursewares/:coursewareId：删除课件元数据和 R2 产物。
- GET /api/coursewares/:coursewareId/segments/:segmentId/audio：读取主音频。
- GET /api/coursewares/:coursewareId/segments/:segmentId/alternate-audio：读取备用讲法。
- GET /api/coursewares/:coursewareId/segments/:segmentId/image：读取配图。

所有 courseware 接口都必须从会话用户解析所有权，不接受 body 或 query 中的 userId 作为授权依据。

### 模型目录与个人设置

- GET /api/ai-catalog：返回当前启用的服务商、模型、能力和音色，不返回任何密钥。
- GET /api/courseware-ai-settings：返回当前账户配置状态、密钥尾号和模型偏好。
- PUT /api/courseware-ai-settings/credentials/:providerId：保存、替换或清除个人密钥。
- PUT /api/courseware-ai-settings/preferences：保存文本、图片、老师语音和学生语音选择。
- POST /api/courseware-ai-settings/test/text：测试文本模型。
- POST /api/courseware-ai-settings/test/speech：生成短试听。
- POST /api/courseware-ai-settings/test/image：生成小尺寸测试图。

测试接口必须有短输入、超时、频率和每日次数限制，防止被当作通用模型代理。

### 管理员目录

- 管理员查看、创建、更新和停用服务商。
- 管理员查看、创建、更新和停用模型及音色。
- Base URL 和适配器类型只允许管理员修改。
- 删除已被历史课件引用的模型目录项时采用停用而不是物理删除。

## 播放与学习状态

播放器在前端维护当前段、播放位置、倍速和已完成段，并周期性保存：

- 不对每秒播放进度都写 D1。
- 暂停、切段、离开页面和固定间隔时合并保存。
- 页面重新打开后恢复到最近片段和大致位置。

点击“我没听懂”：

1. 暂停当前主音频。
2. 播放当前概念绑定的 alternate audio。
3. 显示备用 display Markdown。
4. 播放完成后允许重听或回到主时间线。
5. 不发送新模型请求。

完成课件后，页面提供“开始正式测验”。新建或继续 selflearn-daily 会话，并记录来源课件 ID，避免同一课件反复创建无关测验会话。

## 错误处理

适配器将供应商错误归一化：

- missing_credential：未配置凭据，禁止创建。
- invalid_credential：密钥无效，停止任务，不自动重试。
- quota_exhausted：套餐额度耗尽，停止任务，不自动重试。
- model_unavailable：模型不存在、停用或暂时不可用。
- incompatible_voice：模型与音色不兼容。
- rate_limited：短暂限流，按 Retry-After 或指数退避。
- provider_timeout：供应商超时，可自动重试。
- invalid_model_output：脚本不符合 schema，可带修复提示重试有限次数。
- storage_failed：R2 写入失败，可重试。
- internal_error：未知内部错误，隐藏敏感细节。

规则：

- 文本或必需语音失败，课件状态为 failed。
- 可重试错误最多自动重试三次，之后等待用户手动继续。
- 图片失败只产生警告和单项重试。
- 重试从未完成片段继续。
- 前端展示用户可行动的文案，不显示供应商原始响应、密钥、密文、内部对象键或堆栈。

## 安全与隐私

- 家长密钥只发送到本项目 Worker，并使用 HTTPS。
- 完整密钥只在保存和后台调用时短暂存在于 Worker 内存。
- D1 只保存 AES-GCM 密文、IV、尾号和版本。
- Queue 消息、日志和错误响应不包含密钥或密文。
- 普通用户不能控制 Base URL，避免 SSRF 和密钥外传。
- 管理员 Base URL 只允许 HTTPS，并通过协议适配器白名单校验。
- R2 保持私有，所有读取先做学生所有权检查。
- 模型输出不执行 HTML、脚本或任意代码。
- Markdown 使用现有安全渲染路径。
- 图片提示词不发送孩子真实身份信息。
- 第一版不采集孩子原始语音。

## 成本与配额

模型费用由家长自己的服务商套餐承担。课件记录保存文本 token、TTS 字符数、图片数量和供应商请求 ID，以支持家长理解用量和排查失败。

Cloudflare 免费额度的设计约束：

- Queue 消息保持小于 64 KB，仅放课件 ID。
- 一个消息批次处理有限片段。
- R2 使用 Standard 存储。
- D1 查询必须通过 courseware_id、student_id、provider_id 等索引避免全表扫描。
- 课件列表分页，播放进度合并写入。
- 提供显式删除旧课件的能力，不在第一版自动删除。

达到 Cloudflare 免费额度时按平台错误返回服务不可用，不静默切换到其他账户或模型。

## 可观测性

日志使用结构化字段：

- courseware_id。
- student_id。
- user_id。
- generation_stage。
- adapter_type。
- provider_id 和 model_id。
- segment_id。
- attempt。
- normalized_error_code。
- supplier_request_id。
- elapsed_ms。

日志绝不包含密钥、密文、完整提示词、孩子画像全文或模型生成的完整课件正文。

课程详情保留可展示的阶段时间和用量汇总。管理员可以查看失败数量和错误分类，但普通管理员界面不展示孩子的完整私密学习内容，除非已有明确权限和产品需求。

## 测试设计

### 结构化脚本

- 合法的老师、学生、备用讲法、检查题和视觉片段通过校验。
- 缺少必需字段、未知 kind、空 speechText、超长脚本和非法组合被拒绝。
- speechText 不包含原始 LaTeX 控制串。
- AI 同学提问和典型误解满足最低数量。

### 模型目录与凭据

- 普通用户只能读取启用目录，不能修改 Base URL。
- 两个账户的凭据和偏好完全隔离。
- 响应只包含尾号，不包含密文、IV 或完整密钥。
- 模型与音色不兼容时保存失败。
- 停用模型不能用于新课件，但旧课件快照仍可展示。
- 新增使用现有协议的模型后，无需修改课件业务即可选择。

### Queue 与幂等

- 创建任务后即使关闭页面，消费者仍继续。
- 两个重复 Queue 消息不能并发生成同一片段。
- 中途失败后只处理未完成片段。
- 已完成 R2 对象不会因普通重试生成新对象。
- 配额耗尽停止必需生成；网络超时自动重试。
- 图片失败不阻止 ready。

### 所有权

- 用户 A 不能列出、读取、播放、重试或删除用户 B 的课件。
- 只修改路径中的 studentId/coursewareId 不能绕过所有权。
- Queue 消费从课件关系解析用户，不信任消息中的 userId。
- 删除学生后的课件元数据和 R2 清理策略一致，不留下可访问对象。

### 播放器

- 首次点击后按时间线连续播放。
- 暂停、上一段、下一段、倍速、拖动和重播本句正确。
- “我没听懂”只播放备用音频，不调用模型接口。
- 页面恢复最近播放位置。
- 音频失败有明确重试，不跳到其他用户资源。
- 键盘、焦点、减少动画和移动端布局得到覆盖。

### 正式测验分离

- 课内检查保存轻量进度但不更新 L1–L4。
- 完成课件后可以创建或继续正式测验会话。
- 正式测验继续产生知识点证据、错题卡和每课输出。
- 同一课件重复点击不会创建无穷重复会话。

### 完整验证

- 单元测试、Worker 集成测试和 D1 真实迁移测试。
- Queue consumer 本地或测试环境验证。
- R2 上传、鉴权读取和删除验证。
- TypeScript 类型检查。
- Vite 生产构建。
- Wrangler dry-run。
- 前端桌面、平板、手机关键视口验证。

## 发布策略

1. 先部署向后兼容的 D1 迁移、R2 binding、Queue binding 和消费者。
2. 种子写入默认服务商与模型目录，但保持功能入口关闭。
3. 管理员配置并测试服务商目录。
4. 使用测试账户完成文本、语音、图片和完整课件冒烟。
5. 对少量账户开放功能开关。
6. 观察任务成功率、重复生成、D1/R2/Queue 用量和供应商错误。
7. 再逐步扩大开放范围。

旧自学会话和 OpenMAIC 提示词流程在灰度期间保留，确认新流程稳定后再移除外跳入口。数据库迁移只新增表和字段，旧 Worker 可以忽略，因此支持先迁移后部署。

## 验收标准

1. 进入孩子后显示左侧功能菜单和右侧工作区，现有辅导、自学、错题和档案功能仍可访问。
2. 家长可以配置管理员批准的文本、语音和图片服务商、模型与音色；业务代码不固定具体模型 ID。
3. 普通用户不能配置 Base URL，密钥不出现在任何读取响应、Queue 消息或日志中。
4. 创建课件后关闭页面，后台仍能生成完成。
5. 课程时间线包含老师讲解、AI 同学主动提问、典型误解、备用讲法、轻量检查和总结。
6. 所有必需语音完成后才能播放；浏览器语音不参与兜底。
7. 图片配置可选，图片失败不阻止语音课件完成。
8. “我没听懂”只播放预生成备用讲法。
9. 百炼或其他服务额度耗尽时禁止新生成，旧课件仍可播放。
10. 更换默认模型不改变旧课件。
11. Queue 重试不会重新生成已经完成的片段。
12. 课内检查不更新 L1–L4；课后正式一题一答继续负责掌握证据。
13. 用户只能访问自己孩子的课件、音频、图片和生成状态。
