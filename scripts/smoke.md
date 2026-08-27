# 手工冒烟清单

每次语音课件发布前在非生产 preview 或完整本地环境逐项执行。只使用专门的测试家长账号和测试 provider Key；不要在截图、工单、终端历史或报告中记录完整 Key、孩子真实资料、prompt 或生成正文。记录测试日期、Worker Version、commit、环境和操作者。

## 0. 前置条件与关闭态

- [ ] `npm test`、`npm run typecheck`、`npm run build`、`npm run deploy:dry-run` 全部通过。
- [ ] D1 已按顺序应用所有待执行 additive migrations `0012`–`0016`，没有修改旧 migration。
- [ ] `wrangler.jsonc` 绑定私有 `daoxue-courseware-media` / `daoxue-courseware-media-preview`、`daoxue-courseware-generation` 和 `daoxue-courseware-generation-dlq`。
- [ ] `AI_SETTINGS_ENCRYPTION_KEY` 已设置；没有为课件配置任何平台共享 provider Key。
- [ ] 准备 Parent A、Parent B 两个普通测试账号，每个账号至少一个学生；另有一个管理员账号。A/B 不使用同一 provider Key。
- [ ] 初始 `courseware_enabled = 0`；Parent A/B 都不能创建新课件，原聊天/OpenMAIC 流程不变。
- [ ] 如果环境已有 `ready` fixture，关闭 flag 时它仍能打开、播放、保存进度并开始正式测验。

## 1. 原有产品基线

- [ ] 未登录访问工作区跳转登录；注册、邀请码、登录、退出正常。
- [ ] 添加、编辑、删除测试学生正常；聊天 SSE、深度思考、公式、错题卡、自学画像和每日输出没有回归。
- [ ] Parent A 看不到或修改不了 Parent B 的学生、会话、错题和自学记录。

## 2. Capability catalog 与严格 BYOK

- [ ] 管理员目录能维护 provider → endpoint → model；endpoint capability/adapter 匹配，base URL 必须为 HTTPS，TTS voice 来自模型声明。
- [ ] 管理员停用 provider/endpoint/model 后，它不再供新选择；目录页面不保存或回显用户 Key。
- [ ] Parent A 在「AI 服务」保存个人课件 provider Key，只看到尾号；分别选择脚本、老师 TTS、AI 同学 TTS 和可选图片模型/音色。
- [ ] 文本、语音、图片连接测试分别成功，错误信息不包含 Key、Authorization、provider 原始 body 或完整请求 URL 参数。
- [ ] 空个人 Key 阻止新生成；管理员即使配置/开启原聊天共享兜底也不会让课件生成继续。
- [ ] 错误/过期个人 Key 被归一化为 invalid 并阻止新生成，不跨 provider fallback。
- [ ] quota exhausted 个人 Key 被归一化并阻止新生成；更换 Key 后旧请求迟到的成功/401/quota 不改变新 Key 的健康状态。
- [ ] 缺少/错误 `AI_SETTINGS_ENCRYPTION_KEY` 按服务配置错误 fail closed，不把用户 Key 标成 invalid，也不回退平台 Key。

## 3. 后台生成、恢复与幂等

- [ ] 在 preview/local 管理员 UI 临时开启 `courseware_enabled`；`selflearn-profiling` 不显示课件卡、不截断 marker，只有 `selflearn-daily` 可产生严格站内任务卡。
- [ ] Parent A 从任务卡创建含图片课件；Queue body 仅为 `{ "coursewareId": <正整数> }`，不含用户、Key、provider、prompt 或正文。
- [ ] 页面依次显示 `queued → scripting → speech → images → finalizing → ready`；外层状态与进度百分比一致，没有倒退或无限重排。
- [ ] 生成开始后立即离开课件路由；Queue consumer 继续运行。完成后返回课件库，轮询恢复且同一课件变为 `ready`。
- [ ] 同一 `{ coursewareId }` 重复/延迟投递至少两次：已持久化且 R2 存在的脚本/主语音/备用语音/图片被跳过，provider 调用数与费用不再增加，课件仍只有一套权威 artifact。
- [ ] 在 provider 调用期间模拟 lease 过期、删除或新 attempt：stale worker 不写 R2、不覆盖 D1 赢家，也不删除赢家对象。
- [ ] timeout/rate limit/provider unavailable 有界重试；invalid credential/quota/不兼容模型立即安全失败。Queue 一个失败消息不影响其他课件。
- [ ] 模拟图片 provider 失败直到重试耗尽：全部必需语音完成后课件仍进入 `ready`，详情和播放器显示可理解的配图 warning；图片可单独重试。
- [ ] 模拟脚本失败或任一必需主/备用语音最终失败：课件不能进入 `ready`，完整 retry 从正确阶段恢复。
- [ ] 模拟 R2 `head` 前两次暂时失败、第三次恢复；不会重复付费。达到持久化上限后安全失败，不无限 re-enqueue。
- [ ] 删除/替换旧 attempt object 失败会留下 D1 cleanup tombstone；后续 drain 精确删除旧 key，不碰当前赢家。

## 4. Parent A/B API 所有权矩阵

先由 Parent A 创建一份 `ready` 课件并记录 courseware/segment ID。每项都用 A 验证成功，再用 B 的 cookie 和 A 的 ID 验证拒绝（403/404 等安全状态，不返回 A 的标题、正文、状态、对象 key 或其他存在性细节）：

- [ ] 列表：`GET /api/students/:studentId/coursewares`。
- [ ] 详情：`GET /api/coursewares/:coursewareId`。
- [ ] 主音频与备用音频：`GET /api/coursewares/:coursewareId/segments/:segmentId/audio|alternate-audio`。
- [ ] 图片：`GET /api/coursewares/:coursewareId/segments/:segmentId/image`。
- [ ] 完整重试：`POST /api/coursewares/:coursewareId/retry`。
- [ ] 图片重试：`POST /api/coursewares/:coursewareId/images/retry`。
- [ ] 进度读取/写入：`GET|PATCH /api/coursewares/:coursewareId/progress`。
- [ ] 正式测验：`POST /api/coursewares/:coursewareId/assessment`。
- [ ] 删除：`DELETE /api/coursewares/:coursewareId`；B 的尝试不能让 A 的课件进入 deleting，也不能清理 A 的 R2。

## 5. 私有媒体、Range 与播放进度

- [ ] R2 Bucket 没有 public development URL/公开域名；详情只返回 authenticated same-origin media URL，不返回 R2 object key。
- [ ] 不带登录 cookie 请求任一媒体 URL 被拒；Parent B 请求 Parent A 媒体被拒。
- [ ] 主音频完整请求返回 200、正确 `Content-Type`、`Accept-Ranges: bytes`、private cache 和 ETag。
- [ ] `Range: bytes=0-99` 返回 206、100 bytes 和正确 `Content-Range`；拖动播放器时浏览器 Network 出现 206。
- [ ] suffix/open-ended Range 正常；multi-range/越界返回 416 和 `Content-Range: bytes */<size>`；匹配 ETag 的 `If-None-Match` 返回 304。
- [ ] 播放/暂停、上一段、下一段、倍速、拖动、重播本句和老师/AI 同学切换正常；全程只有一个 `<audio>`，没有 browser speech fallback。
- [ ] “我没听懂”直接播放预生成备用解释；Network 无模型生成请求，provider 用量不增加。
- [ ] 回答 checkpoint 后刷新，位置、时间和答案恢复；延迟的低 revision PATCH 不能覆盖较新的 `pagehide`/卸载最终快照。

## 6. 已保存课件与正式测验边界

- [ ] 对一份 `ready` 课件依次移除个人 Key、停用快照对应目录模型、关闭 `courseware_enabled`；每一步后主/备用语音、图片、seek、进度和正式测验仍可用。
- [ ] 关闭 flag 后创建新课件被阻止，但列表/详情/媒体/进度/assessment 不被错误阻止。
- [ ] checkpoint 只更新课件进度，不新增或改变 L1–L4 knowledge point，也不直接生成错题卡。
- [ ] “开始正式测验”只对当前账户拥有的 `ready` 课件可用；未完成、他人或已删除课件被拒。
- [ ] 来源是同一学生/账户的 `selflearn-daily` 时复用它；profiling、其他学生或其他账户会话不复用。
- [ ] 快速双击、返回重进和网络重试只得到同一 assessment conversation 和固定 request ID；开场问题只发送一次。
- [ ] 正式回答继续走每日自学一题一答，能够正常沉淀 L1–L4 证据与错题卡。

## 7. 响应式与无障碍

分别在 desktop `1440×900`、tablet `834×1194`、mobile `390×844` 完成课件库、生成状态、播放器、warning、checkpoint、删除和正式测验流程：

- [ ] 页面无水平滚动、遮挡或内容跳出；固定播放器不会覆盖最后一段内容，并处理移动端 safe area。
- [ ] desktop/tablet/mobile 的时间线、当前段、播放状态、warning 和失败状态不只依赖颜色表达。
- [ ] 只用键盘按视觉顺序遍历导航、时间线、播放器、checkpoint、重试、删除和 assessment；焦点环清晰且没有 focus trap 泄漏。
- [ ] 抽屉/模态框打开后焦点进入，`Escape` 关闭，焦点恢复到触发按钮；背景不可误操作。
- [ ] 系统启用 reduced motion 时无非必要动画，进度更新不造成闪烁或强制滚动。
- [ ] 屏幕阅读器能读出面包屑、生成阶段、当前段、播放/暂停、倍速、图片 alt、warning、checkpoint、loading/error 和按钮忙碌状态。
- [ ] 三种宽度均无 console error；Network 没有跨域 R2/provider 请求。

## 8. 敏感数据、日志与用量

- [ ] 检查 AI 设置、目录、列表、状态、错误、重试、删除、assessment 和媒体响应：不出现完整 Key、Authorization、密文、IV、主密钥、R2 object key、完整 prompt 或孩子 profile text。
- [ ] 除所有者鉴权后的 `ready` 详情为播放器返回必要的段落 DTO 外，其他 API 不返回 generated lesson body；任何普通/错误/Queue/provider 日志都不记录生成正文。
- [ ] Worker 日志不记录 Queue 原始非法 body；安全错误只含归一化 code/message，不含 provider 原始响应、请求正文或 base URL query。
- [ ] D1 可观察 `status/stage/warnings/usage/retry`，但 API 不暴露内部 lease/enqueue token、artifact request ID、credential revision 或 tombstone key。
- [ ] Cloudflare 指标中核对 Worker 错误、Queue backlog/retry/DLQ、D1 read/write、R2 Class A/B/storage 和 provider 用量；数值与本轮课件数量大致相符。

## 9. 收尾

- [ ] 记录所有失败项、截图和无敏感信息的请求/状态证据；任何未解释失败都阻止发布。
- [ ] preview/local `courseware_enabled` 重新设为 `0`；生产始终保持 `0`，直到负责人基于完整 smoke 单独批准开启。
- [ ] 不删除测试所覆盖的 additive migration、Queue、DLQ 或 Bucket 作为“清理”；测试课件按正常删除流程清理，确认 tombstone 最终收敛。
