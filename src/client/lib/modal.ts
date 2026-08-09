import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function nextDialogFocusIndex(currentIndex: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return backwards ? count - 1 : 0;
  return backwards ? (currentIndex - 1 + count) % count : (currentIndex + 1) % count;
}

export function shouldCloseDialog(key: string): boolean {
  return key === 'Escape';
}

export function matchesStudentName(expected: string, typed: string): boolean {
  return typed.trim() === expected;
}

export function useDialogFocus<T extends HTMLElement>(onClose: () => void): RefObject<T> {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (focusables()[0] ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldCloseDialog(event.key)) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusables();
      const currentIndex = elements.indexOf(document.activeElement as HTMLElement);
      const nextIndex = nextDialogFocusIndex(currentIndex, elements.length, event.shiftKey);
      if (nextIndex < 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const atBoundary = currentIndex < 0 || (event.shiftKey ? currentIndex === 0 : currentIndex === elements.length - 1);
      if (atBoundary) {
        event.preventDefault();
        elements[nextIndex]?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return dialogRef;
}
