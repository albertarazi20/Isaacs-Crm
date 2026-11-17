import { redirect } from "next/navigation";

/** Adding a lead has no page of its own any more: this old address opens the New lead sheet over the overview. */
export default function LeadIntakePage() {
  redirect("/?new-lead=1");
}
