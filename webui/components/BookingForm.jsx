import { dateInput } from '../lib/fmt';

export const PAYMENT_METHODS = ['كاش', 'انستاباي', 'فودافون كاش', 'دولار', 'غير مدفوع'];

export default function BookingForm({ action, rooms, booking = {}, submitLabel }) {
  const b = booking ?? {};

  return (
    <form action={action}>
      <div className="grid">
        <label className="field">
          اسم الضيف
          <input name="guest_name" defaultValue={b.guest_name ?? ''} />
        </label>
        <label className="field">
          التليفون
          <input name="phone" defaultValue={b.phone ?? ''} />
        </label>
        <label className="field">
          ID الضيف
          <input name="guest_ref" defaultValue={b.guest_ref ?? ''} />
        </label>
        <label className="field">
          بوكنج ID
          <input name="booking_ref" defaultValue={b.booking_ref ?? ''} />
        </label>
        <label className="field">
          نوع الحجز
          <select name="booking_type" defaultValue={b.booking_type ?? ''}>
            <option value="">—</option>
            <option value="خارجي">خارجي</option>
            <option value="بوكينج">بوكينج</option>
          </select>
        </label>

        <label className="field">
          الشقة / الغرفة
          <select name="room_id" defaultValue={b.room_id ?? ''}>
            <option value="">— بدون —</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.apartment} / {r.number}</option>
            ))}
          </select>
        </label>

        <label className="field">
          تاريخ الوصول
          <input type="date" name="arrival" defaultValue={dateInput(b.arrival)} />
        </label>
        <label className="field">
          عدد الليالي
          <input type="number" name="nights" min="0" defaultValue={b.nights ?? ''} />
        </label>
        <label className="field" style={{ justifyContent: 'flex-end' }}>
          <span className="row">
            <input type="checkbox" name="open_ended" defaultChecked={Boolean(b.open_ended)} />
            إقامة مفتوحة (بدون تاريخ مغادرة)
          </span>
        </label>

        <label className="field">
          سعر الليلة
          <input name="nightly_rate" inputMode="decimal" defaultValue={b.nightly_rate ?? ''} />
        </label>
        <label className="field">
          إجمالي سعر الحجز
          <input name="total" inputMode="decimal" defaultValue={b.total ?? ''} />
        </label>
        <label className="field">
          إجمالي ما تم دفعه
          <input name="paid" inputMode="decimal" defaultValue={b.paid ?? ''} />
        </label>
        <label className="field">
          طريقة الدفع
          <select name="payment_method" defaultValue={b.payment_method ?? ''}>
            <option value="">—</option>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <label className="field full">
          ملاحظات
          <textarea name="notes" defaultValue={b.notes ?? ''} />
        </label>
      </div>

      <p className="row" style={{ marginTop: 14 }}>
        <button type="submit">{submitLabel}</button>
        <a className="btn ghost" href="/bookings">إلغاء</a>
      </p>
    </form>
  );
}
