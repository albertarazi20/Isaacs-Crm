import pg from "pg";

// bigint cents are safe as JS numbers (< $90 trillion); numeric(5,3) factor rates are plain floats;
// `date` stays the literal "YYYY-MM-DD" string so no timezone can shift it.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export default pg;
