import { describe, expect, it } from 'vitest';
import {
  getNextWorkspaceFocusIndex,
  isStudentWorkspacePathActive,
  studentWorkspaceGroups,
} from '../src/client/lib/student-workspace';
import {
  getLatestDailyConversation,
  parseSelfLearnProfileForm,
  getSelfLearnOverviewPath,
} from '../src/client/hooks/useSelfLearnOverview';

describe('student workspace navigation', () => {
  it('contains the approved grouped destinations in order', () => {
    expect(studentWorkspaceGroups.map((group) => [group.label, group.items.map((item) => item.label)]))
      .toEqual([
        ['学习', ['今日学习', 'AI 辅导', '语音课件']],
        ['巩固', ['正式测验', '错题复习']],
        ['档案', ['知识掌握', '学习档案']],
      ]);
  });

  it('builds every child route from the active student id', () => {
    const paths = studentWorkspaceGroups.flatMap((group) => group.items.map((item) => item.path(17)));
    expect(paths.every((path) => path.startsWith('/students/17/'))).toBe(true);
  });

  it('keeps exact workspace destinations active without treating nested chat as a menu item', () => {
    expect(isStudentWorkspacePathActive('/students/17/today', '/students/17/today')).toBe(true);
    expect(isStudentWorkspacePathActive('/students/17/coursewares', '/students/17/coursewares/8')).toBe(true);
    expect(isStudentWorkspacePathActive('/students/17/tutoring', '/students/17/chat/9')).toBe(false);
  });

  it('cycles focus within the mobile drawer', () => {
    expect(getNextWorkspaceFocusIndex(0, 4, 'previous')).toBe(3);
    expect(getNextWorkspaceFocusIndex(3, 4, 'next')).toBe(0);
    expect(getNextWorkspaceFocusIndex(1, 4, 'next')).toBe(2);
  });
});

describe('self learn overview extraction', () => {
  it('builds the child-scoped overview path and selects the newest daily session', () => {
    expect(getSelfLearnOverviewPath('17')).toBe('/api/students/17/selflearn');
    expect(getLatestDailyConversation([
      { id: 1, mode: 'selflearn-profiling', updated_at: '2026-08-20T10:00:00.000Z' },
      { id: 2, mode: 'selflearn-daily', updated_at: '2026-08-21T10:00:00.000Z' },
      { id: 3, mode: 'selflearn-daily', updated_at: '2026-08-22T10:00:00.000Z' },
    ])).toMatchObject({ id: 3 });
  });

  it('keeps a saved profile form intact when an archive page opens the editor', () => {
    expect(parseSelfLearnProfileForm('{"goal":"完成阅读计划","directions":["语文"]}')).toMatchObject({
      goal: '完成阅读计划',
      directions: ['语文'],
      forbidden: [],
    });
  });
});
