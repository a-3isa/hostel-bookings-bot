import BookingForm from '../../../components/BookingForm';
import { createBooking } from '../../actions';
import { q } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export default async function NewBooking() {
  const rooms = await q(
    `select r.id, r.number, a.name as apartment
       from rooms r join apartments a on a.id = r.apartment_id
      where r.active and a.active
      order by a.name, r.number`,
  );

  return (
    <div className="panel">
      <h2>حجز جديد</h2>
      <div className="banner">
        هذا الحجز يُنشأ في Postgres فقط ولن يكون له صف في الشيت، فسيظهر في تقرير
        المطابقة على أنه ناقص من الشيت حتى يُضاف هناك.
      </div>
      <BookingForm action={createBooking} rooms={rooms} submitLabel="إنشاء" />
    </div>
  );
}
