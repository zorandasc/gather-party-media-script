import fetch from "node-fetch";
import { MongoClient } from "mongodb";
import archiver from "archiver";
import fs from "fs";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

dotenv.config();

const {
  MONGODB_URI,
  DB_NAME,
  CF_ACCOUNT_HASH,
  CF_CUSTOMER_SUBDOMAIN,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_ENDPOINT,
} = process.env;

const REQUIRED_ENV_VARS = [
  "MONGODB_URI",
  "DB_NAME",
  "CF_ACCOUNT_HASH",
  "CF_CUSTOMER_SUBDOMAIN",
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

const MAX_ZIP_SIZE = 500 * 1024 * 1024; // 500 MB
const SIGNED_URL_EXPIRY_SECONDS = 86400; // 24h . FOR 7D=604800

const mongoClient = new MongoClient(MONGODB_URI, {});
const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function imageDownloadUrl(mediaId) {
  return `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${mediaId}/w=0`;
}

function videoDownloadUrl(mediaId) {
  return `https://${CF_CUSTOMER_SUBDOMAIN}.cloudflarestream.com/${mediaId}/downloads/default.mp4`;
}

function buildMediaUrl(mediaId, contentType) {
  return contentType === "video"
    ? videoDownloadUrl(mediaId)
    : imageDownloadUrl(mediaId);
}

function sanitizeFileName(name, fallback) {
  const unsafe = (name || fallback || "unnamed").toString();
  const sanitized = unsafe
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback || "unnamed";
}

async function generateSignedUrl(bucketName, objectKey) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
  });
  return getSignedUrl(s3, command, { expiresIn: SIGNED_URL_EXPIRY_SECONDS });
}

//Estimate size using head request
async function estimateFileSize(fileUrl, mediaId) {
  try {
    const headRes = await fetch(fileUrl, { method: "HEAD" });
    if (!headRes.ok) {
      console.warn(
        `Skipping size estimate for ${mediaId}: HEAD returned ${headRes.status}`,
      );
      return 0;
    }
    return Number(headRes.headers.get("content-length")) || 0;
  } catch (error) {
    console.warn(`Failed to estimate size for ${mediaId}:`, error.message);
    return 0;
  }
}

//  1. CREATE ZIP FILE FOR PART OF files
//  2. UPLOAD ZIP PART TO CLOUDFLARE R2
//  3. RETURN METATADATA TO PUT IN MANIFEST
async function createAndUploadZip(files, partNumber) {
  //DEFINE NAME OF ZIPFILE
  const zipFileName = `all_media_part_${partNumber}.zip`;
  //DEFINE PATH OF UPLOADED FILE ON CLUDFLARE
  const uploadKey = `exports/${zipFileName}`;
  const output = fs.createWriteStream(zipFileName);
  const archive = archiver("zip", { zlib: { level: 9 } });
  const usedFileNames = new Set();

  archive.pipe(output);

  console.log(`Creating ZIP part ${partNumber} with ${files.length} files...`);

  for (const file of files) {
    const { fileUrl, name, mediaId } = file;
    let fileName = sanitizeFileName(name, mediaId);

    if (usedFileNames.has(fileName)) {
      fileName = `${mediaId}_${fileName}`;
    }
    usedFileNames.add(fileName);

    //GET CONTENT FROM CLUDFLARE
    try {
      const res = await fetch(fileUrl);
      if (!res.ok || !res.body) {
        console.warn(`Skipping ${fileName}, fetch failed: ${res.status}`);
        continue;
      }
      archive.append(res.body, { name: fileName });
    } catch (error) {
      console.error(`Error fetching/adding ${fileName}:`, error);
    }
  }

  //AWAIT WHEN ARCHIVER FINISHES
  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.finalize().catch(reject);
  });

  const partSizeBytes = fs.statSync(zipFileName).size;
  console.log(
    `ZIP part ${partNumber} complete (${(partSizeBytes / 1024 ** 2).toFixed(1)} MB).`,
  );

  //SEND ZIP TO CLOUDFLARE
  try {
    const fileStream = fs.createReadStream(zipFileName);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: uploadKey,
        Body: fileStream,
        ContentType: "application/zip",
      }),
    );
    console.log(`Uploaded to R2: ${uploadKey}`);

    const url = await generateSignedUrl(R2_BUCKET, uploadKey);
    console.log(`Signed download URL (24h): ${url}`);

    return {
      partNumber,
      fileCount: files.length,
      partSizeBytes,
      partSizeMB: Number((partSizeBytes / 1024 ** 2).toFixed(1)),
      zipFile: uploadKey,
      downloadUrl: url,
    };
  } finally {
    try {
      fs.unlinkSync(zipFileName);
      console.log(`Deleted local ZIP: ${zipFileName}`);
    } catch (error) {
      console.warn(`Could not delete local ZIP ${zipFileName}:`, error.message);
    }
  }
}

async function exportMediaZip() {
  console.log("Starting export...");
  await mongoClient.connect();

  try {
    //1. connect to mongodb
    const db = mongoClient.db(DB_NAME);

    //2. Cursor-based Mongo processing (for await ...)
    // to avoid loading all media in memory.
    const cursor = db
      .collection("media")
      .find({}, { projection: { mediaId: 1, name: 1, contentType: 1 } });

    let partNumber = 1;
    let currentZipSize = 0;
    let currentFiles = [];
    //BROJ PROCESIRANIH FAJLOVA
    let processedCount = 0;
    let foundAny = false;
    let totalSizeBytes = 0;
    //mainfest is just a list of metadatA about the number
    //and size of uploaded parts
    const manifest = [];

    for await (const media of cursor) {
      foundAny = true;
      const { mediaId, name, contentType } = media;

      if (!mediaId) {
        console.warn("Skipping media with missing mediaId");
        continue;
      }

      //3. GET URL FROM CLUDFLARE FOR IMAGE AND VIDEO TO DOWNLOAD
      const fileUrl = buildMediaUrl(mediaId, contentType);

      //GET SIZE OF EACH FILE FROM HTML HEAD REQUEST
      const contentLength = await estimateFileSize(fileUrl, mediaId);

      if (
        currentZipSize + contentLength > MAX_ZIP_SIZE &&
        currentFiles.length > 0
      ) {
        //IF MAX_SIZE REACHED
        //UPLAD ZIP PART TO CLOUDFLARE
        //AND RETURN METADATA INFO TO PUT INTO MANIFEST
        const partInfo = await createAndUploadZip(currentFiles, partNumber);

        manifest.push(partInfo);
        //INCREMENT TOTOAL SIZE SUM OF ALL PARTS
        totalSizeBytes += partInfo.partSizeBytes;
        //INCREMENT FOR NEXT PARTNUMBER
        partNumber += 1;
        //RESET TEMPORARY TRACKERS FOR NEXT ITERATION
        currentFiles = [];
        currentZipSize = 0;
      }
      //IF MAX_SIZE NOT REACHED CONTINUE TO PUSH FILES
      currentFiles.push({ mediaId, name, contentType, fileUrl });
      currentZipSize += contentLength;
      processedCount += 1;
    }

    if (!foundAny) {
      console.log("No media found.");
      return;
    }

    //LEFTOVERS
    if (currentFiles.length > 0) {
      const partInfo = await createAndUploadZip(currentFiles, partNumber);
      manifest.push(partInfo);
      totalSizeBytes += partInfo.partSizeBytes;
    }

    // manifestKey  NAME OF MANIFET FILE ON CLUDFLARE
    const manifestKey = `exports/manifest_${Date.now()}.json`;
    const manifestData = {
      createdAt: new Date().toISOString(),
      processedCount,
      totalParts: manifest.length,
      totalSizeBytes,
      maxZipSizeBytes: MAX_ZIP_SIZE,
      files: manifest,
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: manifestKey,
        Body: JSON.stringify(manifestData, null, 2),
        ContentType: "application/json",
      }),
    );

    const manifestUrl = await generateSignedUrl(R2_BUCKET, manifestKey);
    console.log(`Manifest uploaded: ${manifestKey}`);
    console.log(`Manifest signed URL (24h): ${manifestUrl}`);
    console.log(`Export done. Processed ${processedCount} media documents.`);
  } finally {
    await mongoClient.close();
  }
}

exportMediaZip().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
