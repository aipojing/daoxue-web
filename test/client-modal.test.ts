import { describe, expect, it } from 'vitest';

interface ModalHelpers {
  nextDialogFocusIndex(currentIndex: number, count: number, backwards: boolean): number;
  shouldCloseDialog(key: string): boolean;
  matchesStudentName(expected: string, typed: string): boolean;
}

async function loadHelpers(): Promise<ModalHelpers | null> {
  const modulePath = '../src/client/lib/modal';
  return import(modulePath).catch(() => null) as Promise<ModalHelpers | null>;
}

describe('模态框键盘交互', () => {
  it('Tab 和 Shift+Tab 在首尾之间循环', async () => {
    const helpers = await loadHelpers();

    expect(helpers).not.toBeNull();
    expect(helpers?.nextDialogFocusIndex(2, 3, false)).toBe(0);
    expect(helpers?.nextDialogFocusIndex(0, 3, true)).toBe(2);
    expect(helpers?.nextDialogFocusIndex(1, 3, false)).toBe(2);
  });

  it('仅 Escape 触发关闭语义', async () => {
    const helpers = await loadHelpers();

    expect(helpers).not.toBeNull();
    expect(helpers?.shouldCloseDialog('Escape')).toBe(true);
    expect(helpers?.shouldCloseDialog('Enter')).toBe(false);
  });

  it('删除学生时仅接受去除首尾空白后的完整姓名', async () => {
    const helpers = await loadHelpers();

    expect(helpers?.matchesStudentName('小明', ' 小明 ')).toBe(true);
    expect(helpers?.matchesStudentName('小明', '小')).toBe(false);
    expect(helpers?.matchesStudentName('小明', '')).toBe(false);
  });
});
