import { num } from '../lib/fmt';

export function Tile({ label, value, sub, tone, progress, small }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''} ${small ? 'sm' : ''}`}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {typeof progress === 'number' && (
        <div className="bar">
          <i style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}
    </div>
  );
}

export function Meter({ label, value, max, caption }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <span>{label}</span>
      <span className="track"><i style={{ width: `${pct}%` }} /></span>
      <span className="val">{caption ?? `${num(value)} / ${num(max)}`}</span>
    </div>
  );
}

// A stacked bar per month, drawn with divs. Two series only (money in, money
// out), which is all the reports page needs and keeps this dependency-free.
export function Bars({ data }) {
  const peak = Math.max(1, ...data.map((d) => Math.max(d.a, d.b)));

  return (
    <>
      <div className="bars">
        {data.map((d) => (
          <div className="col" key={d.label}>
            <div className="stack" title={`${d.label}: ${num(d.a)} / ${num(d.b)}`}>
              <div className="seg rev" style={{ height: `${(d.a / peak) * 100}%` }} />
              <div className="seg exp" style={{ height: `${(d.b / peak) * 100}%` }} />
            </div>
            <div className="cap">{d.label}</div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span><i className="sw" style={{ background: 'var(--accent)' }} />محصل</span>
        <span><i className="sw" style={{ background: 'color-mix(in srgb, var(--bad) 70%, transparent)' }} />مصروفات</span>
      </div>
    </>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}
