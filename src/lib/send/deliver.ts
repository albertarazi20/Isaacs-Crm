import { env } from "../env";
import { sendViaResend } from "../email/resend";
import { sendEmailAsUser } from "../system/gmail";
import type { Deliverer } from "./worker";

/** The real senders. The worker never imports these directly so a test can hand it fakes. */
export function productionDeliverer(): Deliverer {
  return {
    async gmail(userId, m) {
      const r = await sendEmailAsUser(userId, m);
      return r.id;
    },
    async resend(m) {
      const e = env();
      if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
      const from = (await import("../db").then((x) => x.db)).withSystem(
        async (q) =>
          (await q.query<{ automation_from: string }>("select automation_from from shop_settings"))
            .rows[0]?.automation_from,
      );
      const sender = (await from) || e.RESEND_FROM;
      if (!sender)
        throw new Error(
          "No automation sender configured (shop_settings.automation_from or RESEND_FROM)",
        );
      return sendViaResend({ apiKey: e.RESEND_API_KEY, from: sender }, m);
    },
  };
}
