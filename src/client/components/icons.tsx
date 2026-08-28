import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 课本（品牌） */
export function IconBook(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 6C10.4 4.5 8.4 4 5.5 4c-1 0-2 .13-3 .4V19.6c1-.27 2-.4 3-.4 2.9 0 4.9.5 6.5 1.9 1.6-1.4 3.6-1.9 6.5-1.9 1 0 2 .13 3 .4V4.4c-1-.27-2-.4-3-.4-2.9 0-4.9.5-6.5 2z" />
      <path d="M12 6v15" />
    </Svg>
  );
}

/** 靶心（自学陪伴） */
export function IconTarget(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="4.6" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 台灯（解题辅导） */
export function IconLamp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 18.5h5" />
      <path d="M10.5 21h3" />
      <path d="M12 3.5a6 6 0 0 1 3.7 10.7c-.75.6-1.2 1.3-1.2 2.3h-5c0-1-.45-1.7-1.2-2.3A6 6 0 0 1 12 3.5z" />
    </Svg>
  );
}

/** 错题本 */
export function IconNotebook(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <path d="M9 3.5v17" />
      <path d="M12.5 8.5H16" />
      <path d="M12.5 12H16" />
    </Svg>
  );
}

/** 相机（拍照识题） */
export function IconCamera(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8.6A1.6 1.6 0 0 1 5.6 7h2.1l1.2-2.1h6.2L16.3 7h2.1A1.6 1.6 0 0 1 20 8.6v8.8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.4z" />
      <circle cx="12" cy="13" r="3.1" />
    </Svg>
  );
}

/** 开始 */
export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 5.5v13l10-6.5z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 暂停 */
export function IconPause(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5.5v13M16 5.5v13" strokeWidth={2.5} />
    </Svg>
  );
}

/** 上一段 */
export function IconPrevious(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 5.5v13M17.5 6.5 9 12l8.5 5.5z" />
    </Svg>
  );
}

/** 下一段 */
export function IconNext(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17.5 5.5v13M6.5 6.5 15 12l-8.5 5.5z" />
    </Svg>
  );
}

/** 菜单 */
export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Svg>
  );
}

/** 返回 */
export function IconBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Svg>
  );
}

/** 思考（深度思考过程） */
export function IconSpark(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4l1.7 4.8L18.5 10.5l-4.8 1.7L12 17l-1.7-4.8L5.5 10.5l4.8-1.7z" />
      <path d="M18 16.5l.7 2 .8.7-2 .7-.7 2-.7-2-2-.7 2-.7z" strokeWidth={1.2} />
    </Svg>
  );
}

/** 加号 */
export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

/** 日历（今日学习） */
export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
      <path d="M8 14h.01M12 14h.01M16 14h.01" strokeWidth={2.4} />
    </Svg>
  );
}

/** 耳机（语音课件） */
export function IconHeadphones(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <path d="M4 14h3v5H5.5A1.5 1.5 0 0 1 4 17.5zM20 14h-3v5h1.5a1.5 1.5 0 0 0 1.5-1.5z" />
    </Svg>
  );
}

/** 图表（知识掌握） */
export function IconChart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19.5h16" />
      <path d="M7 17v-4M12 17V8M17 17v-7" strokeWidth={2.2} />
    </Svg>
  );
}

/** 档案盒（学习档案） */
export function IconArchive(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8.5h16v11H4zM3.5 4.5h17v4h-17z" />
      <path d="M9 13h6" />
    </Svg>
  );
}
