import { cache } from "react";
import { db } from "../db";
import { dueCount, userContext } from "./queries";

/**
 * What every page header needs: the user's calendar day, who they are, how many follow-ups are due, how many
 * alerts are unread, and whether they have accepted the policy yet.
 * `cache()` makes the layout and each page's generateMetadata share ONE query per request.
 */
export const loadShell = cache(async (userId: string) =>
  db.withUser(userId, async (q) => {
    const ctx = await userContext(q);
    const { rows } = await q.query<{
      name: string;
      email: string;
      policy_accepted_at: string | null;
    }>(
      "select name, email, policy_accepted_at::text as policy_accepted_at from app_users where id = app.current_user_id()",
    );
    // the starred merchants ("always on top"): a few ids, so every page can show a star without its own query
    const hot = await q.query<{ id: string }>("select id from clients where hot");
    const shop = await q.query<{ n: number }>(
      "select max_lenders_per_deal as n from shop_settings",
    );
    const alerts = await q.query<{ n: number }>(
      "select count(*)::int as n from user_alerts where user_id = app.current_user_id() and read_at is null",
    );
    return {
      ctx,
      user: rows[0],
      due: await dueCount(q, ctx.today),
      hotIds: hot.rows.map((r) => r.id),
      maxLendersPerDeal: shop.rows[0]?.n ?? 6,
      unreadAlerts: alerts.rows[0]?.n ?? 0,
    };
  }),
);
