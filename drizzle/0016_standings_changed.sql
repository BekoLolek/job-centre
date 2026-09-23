-- R-193: a member can be told when the standings move after an event they
-- played in. Every kind is also a preference, and a preference for a string
-- nobody declared is a switch nobody can find, so the kind is a real enum
-- value rather than free text.
--
-- Added at the end rather than with a `BEFORE`: the order of this enum is the
-- order nothing depends on — `NOTIFICATION_KINDS` in `src/lib/notify-policy.ts`
-- is what the preferences screen lists, and it lists them in its own order.
ALTER TYPE "public"."notification_kind" ADD VALUE 'standings_changed';
