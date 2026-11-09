import type { KeyboardEvent } from 'react';

export function handleDialogKey(event: KeyboardEvent<HTMLDivElement>, close: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])',
    ),
  ];
  if (controls.length === 0) return;
  const current = document.activeElement;
  if (event.shiftKey && (current === controls[0] || !controls.includes(current as HTMLElement))) {
    event.preventDefault();
    controls[controls.length - 1].focus();
  } else if (
    !event.shiftKey &&
    (current === controls[controls.length - 1] || !controls.includes(current as HTMLElement))
  ) {
    event.preventDefault();
    controls[0].focus();
  }
}
