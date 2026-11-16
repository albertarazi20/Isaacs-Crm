import { redirect } from "next/navigation";

/** The lender list lives on its own page; Settings just points there. */
export default function LendersSettingsPage() {
  redirect("/funders");
}
