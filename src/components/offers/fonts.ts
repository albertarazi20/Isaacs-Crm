import { Source_Serif_4 } from "next/font/google";

/** The serif the offer page sets its headings and money in: it reads like a term sheet from a bank. */
export const offerSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-offer-serif",
  display: "swap",
});
