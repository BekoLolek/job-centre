-- Plant the Marvel Rivals hero roster (R-214 / UC-40).
--
-- The same 54 rows src/db/seed.ts plants, generated from that file so the two
-- cannot disagree. Season 10.5, checked against the live game on 2026-10-23:
-- 14 Vanguard + 27 Duelist + 12 Strategist, plus Deadpool in all three, which
-- is why the drawable pools are 15 / 28 / 13 rather than 14 / 27 / 12.
--
-- Safe to run more than once. `on conflict do nothing` on (game_id, name) is
-- the same bargain the seed makes: rows are inserted only when missing, never
-- overwritten, so a hero whose roles an admin has corrected after a rework
-- keeps the correction. Re-running reports 0 inserted.
--
-- It refuses rather than guessing if the Rivals game row is absent: without it
-- every row below would carry a null game_id and the insert would fail halfway
-- with a constraint error instead of a sentence.

begin;

do $$
begin
  if not exists (select 1 from games where key = 'rivals') then
    raise exception 'No game with key ''rivals''. Run the games seed first, or check you are connected to the right database.';
  end if;
end $$;

insert into heroes (game_id, name, roles)
values
  ((select id from games where key = 'rivals'), 'Adam Warlock', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Angela', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Black Cat', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Black Panther', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Black Widow', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Blade', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Captain America', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Cloak & Dagger', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Cyclops', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Daredevil', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Deadpool', ARRAY['Vanguard', 'Duelist', 'Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Devil Dinosaur', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Doctor Strange', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Elsa Bloodstone', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Emma Frost', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Gambit', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Gorr', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Groot', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Hawkeye', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Hela', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Hulk', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Human Torch', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Invisible Woman', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Iron Fist', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Iron Man', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Jeff The Land Shark', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Jubilee', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Loki', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Luna Snow', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Magik', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Magneto', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Mantis', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Mister Fantastic', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Moon Knight', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Namor', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Peni Parker', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Phoenix', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Psylocke', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Rocket Raccoon', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Rogue', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Scarlet Witch', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Spider-Man', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Squirrel Girl', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Star-Lord', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Storm', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'The Hood', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'The Punisher', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'The Thing', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Thor', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Ultron', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Venom', ARRAY['Vanguard']::hero_role[]),
  ((select id from games where key = 'rivals'), 'White Fox', ARRAY['Strategist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Winter Soldier', ARRAY['Duelist']::hero_role[]),
  ((select id from games where key = 'rivals'), 'Wolverine', ARRAY['Duelist']::hero_role[])
on conflict (game_id, name) do nothing;

-- What landed. Expect 54 the first time and the same 54 on any re-run.
select
  (select count(*) from heroes h join games g on g.id = h.game_id where g.key = 'rivals') as heroes_total,
  (select count(*) from heroes h join games g on g.id = h.game_id
     where g.key = 'rivals' and 'Vanguard' = any(h.roles) and h.retired_at is null) as vanguard_drawable,
  (select count(*) from heroes h join games g on g.id = h.game_id
     where g.key = 'rivals' and 'Duelist' = any(h.roles) and h.retired_at is null) as duelist_drawable,
  (select count(*) from heroes h join games g on g.id = h.game_id
     where g.key = 'rivals' and 'Strategist' = any(h.roles) and h.retired_at is null) as strategist_drawable;

commit;
