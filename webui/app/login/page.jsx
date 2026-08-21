import { login } from '../actions';
import { authConfigured } from '../../lib/auth';
import { dbConfigured } from '../../lib/db';
import { safeNext } from '../../lib/nav';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const missing = [
    !authConfigured() && 'DASHBOARD_PASSWORD',
    !dbConfigured() && 'SUPABASE_TRANSACTION_URL',
  ].filter(Boolean);

  if (missing.length) {
    return (
      <div className="center">
        <div className="card">
          <h1>الإعداد غير مكتمل</h1>
          <p className="muted">
            هذه المتغيرات غير مضبوطة في Vercel، واللوحة مقفولة حتى تُضبط:
          </p>
          <ul className="muted">
            {missing.map((name) => (
              <li key={name}><code>{name}</code></li>
            ))}
          </ul>
          <p className="muted">
            Vercel → Project → Settings → Environment Variables، ثم أعد النشر
            (Redeploy).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <div className="card">
        <h1>لوحة الحجوزات</h1>
        <p className="muted">أدخل كلمة المرور للدخول.</p>
        <form action={login}>
          {/* Sanitised here as well as in the action: the raw query parameter is
              attacker-controlled and this is where it gets echoed back into the page. */}
          <input type="hidden" name="next" value={safeNext(params?.next)} />
          <label className="field">
            كلمة المرور
            <input type="password" name="password" autoFocus required />
          </label>
          {params?.error === 'throttled' ? (
            <p className="error">
              محاولات كثيرة فاشلة من هذا الجهاز. انتظر ربع ساعة ثم أعد المحاولة.
            </p>
          ) : params?.error ? (
            <p className="error">كلمة المرور غير صحيحة.</p>
          ) : null}
          <p><button type="submit">دخول</button></p>
        </form>
      </div>
    </div>
  );
}
