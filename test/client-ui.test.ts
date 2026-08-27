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
});
