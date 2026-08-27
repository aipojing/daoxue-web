export type StudentWorkspaceIcon =
  | 'calendar'
  | 'lamp'
  | 'headphones'
  | 'target'
  | 'notebook'
  | 'chart'
  | 'archive';

export interface StudentWorkspaceItem {
  label: string;
  path: (studentId: number | string) => string;
  icon: StudentWorkspaceIcon;
}

export interface StudentWorkspaceGroup {
  label: string;
  items: StudentWorkspaceItem[];
}

export const studentWorkspaceGroups: StudentWorkspaceGroup[] = [
  {
    label: '学习',
    items: [
      { label: '今日学习', path: (id) => `/students/${id}/today`, icon: 'calendar' },
      { label: 'AI 辅导', path: (id) => `/students/${id}/tutoring`, icon: 'lamp' },
      { label: '语音课件', path: (id) => `/students/${id}/coursewares`, icon: 'headphones' },
    ],
  },
  {
    label: '巩固',
    items: [
      { label: '正式测验', path: (id) => `/students/${id}/selflearn`, icon: 'target' },
      { label: '错题复习', path: (id) => `/students/${id}/mistakes`, icon: 'notebook' },
    ],
  },
  {
    label: '档案',
    items: [
      { label: '知识掌握', path: (id) => `/students/${id}/mastery`, icon: 'chart' },
      { label: '学习档案', path: (id) => `/students/${id}/profile`, icon: 'archive' },
    ],
  },
];

export function isStudentWorkspacePathActive(destination: string, pathname: string): boolean {
  return pathname === destination || pathname.startsWith(`${destination}/`);
}

export function getNextWorkspaceFocusIndex(
  currentIndex: number,
  itemCount: number,
  direction: 'next' | 'previous',
): number {
  if (itemCount < 1) return -1;
  if (direction === 'next') return (currentIndex + 1) % itemCount;
  return (currentIndex - 1 + itemCount) % itemCount;
}

export function shouldRestoreWorkspaceMenuFocus(drawerWasOpen: boolean): boolean {
  return drawerWasOpen;
}

export function shouldCloseDrawerForBreakpointChange(
  wasCompact: boolean,
  nextCompact: boolean,
  drawerOpen: boolean,
): boolean {
  return wasCompact && !nextCompact && drawerOpen;
}
