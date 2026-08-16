import { db } from "./src/db/index.js";
import { settings, games } from "./src/db/schema.js";
import { eq } from "drizzle-orm";

const snowflake = "1234567890123456789"; // a real-shaped Discord id, 19 digits
await db.insert(settings).values({ key: "check.guildId", value: snowflake })
  .onConflictDoUpdate({ target: settings.key, set: { value: snowflake } });
const [row] = await db.select().from(settings).where(eq(settings.key, "check.guildId"));
console.log("stored :", snowflake);
console.log("read   :", row.value);
console.log("type   :", typeof row.value);
console.log("intact :", row.value === snowflake);

const [rivals] = await db.select().from(games).where(eq(games.key, "rivals"));
const ladder = rivals.rankLadder as string[];
console.log("ladder :", ladder.length, "ranks,", ladder[0], "->", ladder[ladder.length - 1]);
await db.delete(settings).where(eq(settings.key, "check.guildId"));
