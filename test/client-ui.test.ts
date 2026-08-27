import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function clientSource(relativePath: string): string {
  return readFileSync(new URL(`../src/client/${relativePath}`, import.meta.url), 'utf8');
}

describe('客户端关键交互结构', () => {
  it('登录和注册页默认聚焦邮箱输入框', () => {
    for (const page of ['pages/LoginPage.tsx', 'pages/RegisterPage.tsx']) {
      const source = clientSource(page);
      const emailInput = source.match(/<input[\s\S]*?type="email"[\s\S]*?\/>/)?.[0];
      expect(emailInput).toContain('autoFocus');
    }
  });

  it('聊天消息传稳定保存回调和消息 ID，且不再读取 keyCode', () => {
    const chat = clientSource('pages/ChatPage.tsx');
    const bubble = clientSource('components/MessageBubble.tsx');

    expect(chat).not.toContain('keyCode');
    expect(chat).toContain('onSaveMistake={canSaveMistake ? saveMistake : undefined}');
    expect(chat).toContain('messageId={canSaveMistake ? m.id : undefined}');
    expect(bubble).toContain('onSaveMistake(messageId)');
  });

  it('删除学生使用站内确认对话框而非浏览器 prompt', () => {
    const students = clientSource('pages/StudentsPage.tsx');

    expect(students).not.toContain('window.prompt');
    expect(students).toContain('<StudentDeleteModal');
  });

  it('设置页的邀请码启停与限额保存按钮暴露逐项 pending 状态', () => {
    const settings = clientSource('pages/SettingsPage.tsx');

    expect(settings).toContain('pendingInviteIds.has(inv.id)');
    expect(settings).toContain('pendingLimitIds.has(u.id)');
  });

  it('AI 设置页挂载独立的语音课件模型工作区', () => {
    const aiSettingsSource = clientSource('pages/AISettingsPage.tsx');
    const coursewareSettingsSource = clientSource('components/CoursewareAISettingsCard.tsx');

    expect(aiSettingsSource).toContain('CoursewareAISettingsCard');
    expect(coursewareSettingsSource).toContain('课件脚本模型');
    expect(coursewareSettingsSource).toContain('老师语音');
    expect(coursewareSettingsSource).toContain('AI 同学语音');
    expect(coursewareSettingsSource).toContain('配图模型（可选）');
    expect(coursewareSettingsSource).toContain('试听');
    expect(coursewareSettingsSource).toContain('URL.revokeObjectURL');
    expect(coursewareSettingsSource).toContain('autoComplete="new-password"');
    expect(coursewareSettingsSource).not.toContain('baseUrl');
  });

  it('设置页只为管理员挂载课件目录与开关管理', () => {
    const settingsSource = clientSource('pages/SettingsPage.tsx');
    const adminCatalogSource = clientSource('components/ModelCatalogAdminCard.tsx');

    expect(settingsSource).toContain('ModelCatalogAdminCard');
    expect(adminCatalogSource).toContain('课件功能开关');
    expect(adminCatalogSource).toContain('服务商与模型目录');
    expect(adminCatalogSource).toContain('Base URL');
    expect(adminCatalogSource).toContain('停用');
    expect(adminCatalogSource).toContain('lifecycleRef.current.activate()');
    expect(adminCatalogSource).toContain('lifecycleRef.current.cleanup()');
    expect(adminCatalogSource).toContain('disabled={pending || modelDraft.id !== null}');
    expect(adminCatalogSource).toContain('编辑已有模型时，端点不可更改');
  });

  it('课件设置逐项管理异步请求、预览和错误关联', () => {
    const source = clientSource('components/CoursewareAISettingsCard.tsx');

    expect(source).toContain('pendingProviderIds.has(providerId)');
    expect(source).toContain('AbortController');
    expect(source).toContain('signal: controller.signal');
    expect(source).toContain('audioUrls.teacher_tts');
    expect(source).toContain('audioUrls.student_tts');
    expect(source).toContain('aria-invalid');
    expect(source).toContain('aria-describedby');
    expect(source).toContain('settingsReadEpochRef.current.begin()');
    expect(source).toContain('settingsReadEpochRef.current.isCurrent');
    expect(source).toContain('savingPreferencesRef.current');
    expect(source).toContain('完成后会自动同步');
  });

  it('孩子工作台提供分组导航与移动端抽屉控制', () => {
    const app = clientSource('App.tsx');
    const workspace = clientSource('components/StudentWorkspaceLayout.tsx');
    const workspaceCss = clientSource('styles/workspace.css');

    expect(app).toContain('StudentWorkspaceLayout');
    expect(workspace).toContain('aria-label="孩子学习功能"');
    expect(workspace).toContain('AI 服务');
    expect(workspace).toContain('返回学生列表');
    expect(workspace).toContain('aria-label="打开孩子学习菜单"');
    expect(workspace).toContain('aria-expanded={drawerOpen}');
    expect(workspace).toContain('document.body.style.overflow = previousBodyOverflow');
    expect(workspace).toContain('shouldCloseDrawerForBreakpointChange');
    expect(workspace).toContain("toggleAttribute('inert', drawerOpen)");
    expect(workspace).toContain('aria-label="关闭菜单"');
    expect(workspace).not.toContain('<button className="workspace-backdrop"');
    expect(workspaceCss).toContain('visibility: hidden');
    expect(workspaceCss).not.toContain('.workspace-content .chat-page { min-height: 100dvh; height: 100%; }');
    expect(workspaceCss).not.toContain('.workspace-content .chat-page { display: block; }');
    expect(workspaceCss).not.toContain('.workspace-content .chat-main { min-height: calc(100dvh - 56px); }');
  });

  it('课件库明确后台生成、个人套餐和 AI 服务配置入口', () => {
    const createPanel = clientSource('components/CoursewareCreatePanel.tsx');
    const status = clientSource('components/CoursewareGenerationStatus.tsx');
    const page = clientSource('pages/CoursewaresPage.tsx');

    expect(createPanel).toContain('额度耗尽后不会切换到平台账号');
    expect(createPanel).toContain('to="/ai-settings"');
    expect(status).toContain('可以离开，后台会继续');
    expect(page).toContain('CoursewareDeleteModal');
    expect(page).not.toContain('window.confirm');
    expect(page).toContain('CoursewareItemsCoordinator');
    expect(page).toContain('commitItems(updateCoursewareList(itemsRef.current, next))');
  });

  it('语音课件播放页复用安全 Markdown 并提供可识别的时间线状态', () => {
    const app = clientSource('App.tsx');
    const page = clientSource('pages/CoursewarePlayerPage.tsx');
    const timeline = clientSource('components/CoursewareTimeline.tsx');

    expect(app).toContain('CoursewarePlayerPage');
    expect(page).toContain('CoursewareGenerationStatus');
    expect(timeline).toContain('MarkdownContent');
    expect(timeline).toContain('aria-current');
    expect(timeline).toContain('visual.altText');
    expect(timeline).not.toContain('dangerouslySetInnerHTML');
  });
});
