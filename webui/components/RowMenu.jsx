'use client';

import { useEffect, useRef, useState } from 'react';

// The ⋯ menu on a booking row: edit, or delete behind a modal confirmation.
//
// The popup is position: fixed and placed from the button's own rect, because
// the table lives inside an `overflow-x: auto` scroller — an absolutely
// positioned menu would be clipped by it.
export default function RowMenu({ id, name, guestRef, sheetRow }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const buttonRef = useRef(null);
  const popRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    // The popup counts as "inside": mousedown lands before click, so closing on
    // a mousedown anywhere but the button would unmount the menu item before
    // its own click could fire.
    const close = (event) => {
      const inside = buttonRef.current?.contains(event.target)
        || popRef.current?.contains(event.target);
      if (!inside) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    // A menu pinned to the viewport has to go away when the page moves under it.
    window.addEventListener('scroll', () => setOpen(false), { once: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const rect = buttonRef.current.getBoundingClientRect();
    setAt({ top: rect.bottom + 4, left: rect.left });
    setOpen((was) => !was);
  };

  const askDelete = () => {
    setOpen(false);
    dialogRef.current?.showModal();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ghost sm menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="خيارات"
        onClick={toggle}
      >
        ⋯
      </button>

      {open && (
        <div ref={popRef} className="menu-pop" role="menu" style={{ top: at.top, left: at.left }}>
          <a role="menuitem" href={`/bookings/${id}`}>تعديل</a>
          <button role="menuitem" type="button" className="danger-item" onClick={askDelete}>
            حذف
          </button>
        </div>
      )}

      <dialog ref={dialogRef} className="modal">
        <h3>حذف الحجز؟</h3>
        <p className="muted">
          <strong>{name || 'بدون اسم'}</strong>
          {guestRef ? ` · ID ${guestRef}` : ''}
          {sheetRow ? ` · صف الشيت ${sheetRow}` : ' · بدون صف في الشيت'}
        </p>
        <p className="muted">
          سيُحذف من قاعدة البيانات <strong>ومن الشيت</strong>، ومعه دفعاته وسجل
          تعديلاته. إن لم يكن له صف في الشيت — أو كان الصف يخص حجزًا آخر — فسيُحذف
          من قاعدة البيانات فقط ولن يُمس أي صف. لا يمكن التراجع.
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <button type="button" className="ghost" onClick={() => dialogRef.current.close()}>
            إلغاء
          </button>
          <form method="post" action={`/bookings/${id}/delete/confirm`}>
            <button className="danger" type="submit">تأكيد الحذف</button>
          </form>
          <span className="spacer" />
          <a className="muted" href={`/bookings/${id}/delete`}>تفاصيل أكثر قبل الحذف</a>
        </div>
      </dialog>
    </>
  );
}
