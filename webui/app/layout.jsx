import './globals.css';
import Nav from '../components/Nav';
import { signedIn } from '../lib/auth';
import { logout } from './actions';

export const metadata = {
  title: 'لوحة الحجوزات',
  description: 'Read/write dashboard over the bookings database.',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }) {
  const authed = await signedIn();

  return (
    <html lang="ar" dir="rtl">
      <body>
        <div className="wrap">
          {authed && (
            <header className="top">
              <a className="brand" href="/">
                <span className="dot" />
                <span>لوحة الحجوزات</span>
              </a>
              <Nav />
              <div className="right">
                <a className="btn sm" href="/bookings/new">+ حجز</a>
                <form action={logout}>
                  <button className="ghost sm" type="submit">خروج</button>
                </form>
              </div>
            </header>
          )}
          {children}
        </div>
      </body>
    </html>
  );
}
