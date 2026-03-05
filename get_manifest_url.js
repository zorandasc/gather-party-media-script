import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

dotenv.config();

const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } =
  process.env;

const REQUIRED_ENV_VARS = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT",
];

const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function normalizeManifestKey(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("exports/")) return trimmed;
  if (trimmed.startsWith("manifest_")) return `exports/${trimmed}`;
  return trimmed;
}

const SIGNED_URL_EXPIRY_SECONDS = 86400; // 24h

async function main() {
  const rawKey = process.argv[2];
  const expiresIn = Number(process.argv[3]) || SIGNED_URL_EXPIRY_SECONDS;

  if (!rawKey) {
    throw new Error(
      "Usage: node get_manifest_url.js <manifestKey|manifestFileName> [expiresInSeconds]",
    );
  }

  const objectKey = normalizeManifestKey(rawKey);
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: objectKey,
  });

  const signedUrl = await getSignedUrl(s3, command, { expiresIn });
  console.log(`Manifest key: ${objectKey}`);
  console.log(`Signed URL (${expiresIn}s):`);
  console.log(signedUrl);
}

main().catch((err) => {
  console.error("Failed to generate manifest URL:", err.message);
  process.exit(1);
});
