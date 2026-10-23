import { z } from "zod";

/**
 * Zod speeds up object parsing by compiling it with `new Function`. Our production CSP forbids eval, so the
 * browser reports a violation (harmless — zod catches it — but it floods the console and any CSP report
 * endpoint). `jitless` makes zod skip the attempt. It must run BEFORE any schema is built: zod decides when
 * a schema is constructed. Import this first in every module that defines schemas the browser also loads.
 */
z.config({ jitless: true });
