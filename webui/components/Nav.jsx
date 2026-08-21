'use client';

import { usePathname } from 'next/navigation';

const LINKS = [
  ['/', 'نظرة عامة'],
  ['/dashboard', 'الداشبورد'],
  ['/bookings', 'الحجوزات'],
  ['/expenses', 'المصروفات'],
  ['/deposits', 'الإيداعات'],
  ['/reports', 'التقارير'],
  ['/reconcile', 'المطابقة'],
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav>
      {LINKS.map(([href, label]) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <a key={href} href={href} aria-current={active ? 'page' : undefined}>
            {label}
          </a>
        );
      })}
    </nav>
  );
}
