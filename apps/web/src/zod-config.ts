import { z } from 'zod'

// zod compiles object parsers with `new Function` and probes for it when the first object
// schema is built. The server's Content-Security-Policy allows no 'unsafe-eval', so the
// probe is refused and zod falls back, but the browser reports a securitypolicyviolation
// on every load. main.tsx imports this module first, before the contracts build their schemas.
z.config({ jitless: true })
