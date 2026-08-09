-- The apartment/room registry, seeded from the الإتاحة tab and verified equal
-- to it on 2026-08-09: 6 apartments, 26 rooms on both sides.
--
-- Aliases match the tab's own header row, so locationRegistry() reads this
-- exactly as it read the Sheets node. Rooms sort numerically rather than by
-- text, or room 10 would sit before room 2 on the keyboard.
select
  a.name   as "الشقة",
  r.number as "الغرفة"
from rooms r
join apartments a on a.id = r.apartment_id
where r.active and a.active
order by a.id, length(r.number), r.number;
