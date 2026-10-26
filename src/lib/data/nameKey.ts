/**
 * "Mike's Pizza, LLC" and "mikes pizza llc" are the same business. ASCII letters and digits only, on purpose: the
 * same rule is written in SQL in findDuplicates (`regexp_replace(lower(name), '[^a-z0-9]+', '', 'g')`), and a
 * Unicode rule would depend on the database's locale, so the two sides could disagree. A name with no ASCII letter
 * or digit has no key and is matched by phone only.
 */
export const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The same key as SQL, for a column or parameter expression. Keep in step with nameKey above. */
export const NAME_KEY_SQL = (expr: string): string =>
  `regexp_replace(lower(${expr}), '[^a-z0-9]+', '', 'g')`;
