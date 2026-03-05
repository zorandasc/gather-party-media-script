# 1. Koristimo samo multipart_export_by_size.js

Key upgrades included:

Cursor-based Mongo processing (for await ...) to avoid loading all media in memory.

```js
const cursor = db
      .collection("media")
      .find({}, { projection: { mediaId: 1, name: 1, contentType: 1 } });

  for await (const media of cursor) {
      foundAny = true;
      const { mediaId, name, contentType } = media;

```

Required env-var validation at startup.

```js
const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
}
```

Safer ZIP creation/upload flow with cleanup in finally.

File name sanitization + duplicate name handling inside ZIP.

```js
function sanitizeFileName(name, fallback) {}
```

Manifest includes processedCount, totalParts, totalSizeBytes, and maxZipSizeBytes.

Syntax check passed (node --check multipart_export_by_size.js).

```bash
npm run export
```

# 2. send_export_email.js , use signed manifesturl inside ""

```bash

npm run send-email -- "PASTE_SIGNED_URL"

```

# 3. Ako nemas manifesturl, generisi privremeni signed url za vec postojeci manifest

```bash
npm run manifest-url -- "exports/manifest_1234567890.json"

npm run manifest-url -- "manifest_1234567890.json"
```

Optional custom expiry seconds (default 86400):

```bash
npm run manifest-url -- "exports/manifest_1234567890.json" 3600
```

# UNSPLASH IMAGES FOR EMAIL

https://plus.unsplash.com/premium_vector-1743827788693-85c895c418b3?q=80&w=1025&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D

https://plus.unsplash.com/premium_vector-1744118032844-361799bdeb40?q=80&w=1112&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D

https://plus.unsplash.com/premium_vector-1744118032844-361799bdeb40?q=80&w=1112&auto=format&fit=crop

https://plus.unsplash.com/premium_vector-1744223040301-97f46f268adc?q=80&w=1332&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D
