'use client';

import { useRouter } from 'next/navigation';

// The whole row is a link to the edit page. Anything interactive inside it —
// the ⋯ button, its menu, the confirm dialog — must not drag the row along with
// it, so a click that started on one of those is left alone.
export default function BookingRow({ id, className, children }) {
  const router = useRouter();

  const open = (event) => {
    if (event.target.closest('a, button, input, select, dialog, .menu-pop')) return;
    // Ctrl/Cmd/middle click keeps the browser's own "open elsewhere" meaning.
    if (event.metaKey || event.ctrlKey || event.button !== 0) return;
    router.push(`/bookings/${id}`);
  };

  const keyed = (event) => {
    if (event.key === 'Enter') router.push(`/bookings/${id}`);
  };

  return (
    <tr
      className={`${className ?? ''} clickable`}
      onClick={open}
      onKeyDown={keyed}
      tabIndex={0}
      role="link"
      aria-label="فتح الحجز"
    >
      {children}
    </tr>
  );
}
