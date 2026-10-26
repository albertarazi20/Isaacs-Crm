import { cache } from "react";
import { db } from "../db";
import { dueCount, userContext } from "./queries";

/**
 * What every page header needs: the user's calendar day, who they are, and how many follow-ups are due.
 * `cache()` makes the layout and each page's generateMetadata share ONE query per request.
 */
export const loadShell = cache(async (userId: string) =>
  db.withUser(userId, async (q) => {
    const ctx = await userContext(q);
    const { rows } = await q.query<{ name: string; email: string }>(
      "select name, email from app_users where id = app.current_user_id()",
    );
    // the starred merchants ("always on top"): a few ids, so every page can show a star without its own query
    const hot = await q.query<{ id: string }>("select id from clients where hot");
    return {
      ctx,
      user: rows[0],
      due: await dueCount(q, ctx.today),
      hotIds: hot.rows.map((r) => r.id),
    };
  }),
);
