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

const imageDownloadUrl = (mediaId) => {
  return `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${mediaId}/w=0`;
};

//ALL VIDEO ON UPLOAD IS ENABLED FOR DOWNLOAD
const videoDownloadUrl = (mediaId) =>
  `https://${CF_CUSTOMER_SUBDOMAIN}.cloudflarestream.com/${mediaId}/downloads/default.mp4`;

async function generateSignedUrl(bucketName, objectKey) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
  });

  // expiresIn = seconds (e.g. 86400 = 1 day)
  const signedUrl = await getSignedUrl(s3, command, { expiresIn: 86400 });

  return signedUrl;
}

// === SETUP DB & R2 CLIENT ===
const mongoClient = new MongoClient(MONGODB_URI, {});
const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// === MAIN ===
async function exportMediaZip() {
  console.log("📦 Starting export...");

  // === Create ZIP archive ===
  const zipFile = "all_media.zip";
  const output = fs.createWriteStream(zipFile);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);

  //==== CONNECT TO MONGODB ====
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);

  //GET ALL OBJECT FROM MONGODB
  // Fetch all media documents
  const cursor = db.collection("media").find({});
  let foundAny = false;
  let processed = 0;

  // Process each media item
  for await (const media of cursor) {
    foundAny = true;
    processed++;
    try {
      const { mediaId, name, contentType } = media;
      let fileUrl;
      if (contentType === "video") {
        fileUrl = videoDownloadUrl(mediaId);
      } else {
        fileUrl = imageDownloadUrl(mediaId);
      }
      let fileName = `${name || mediaId}`;
      console.log(`➡️  Adding ${fileName}`);

      //FETCH CONTENT FROM CLOUDFLARE
      const res = await fetch(fileUrl);
      if (!res.ok) {
        console.warn(`⚠️  Skipping ${fileName}, fetch failed: ${res.status}`);
        continue;
      }
      // Stream network response directly into ZIP
      archive.append(res.body, { name: fileName });
    } catch (err) {
      console.error("Error processing item:", err);
    }
  }
  
  if (!foundAny) {
    console.log("No media found");
    return;
  } else {
    console.log(`Processed ${processed} media items.`);
  }

  //3.await archive.finalize();
  await new Promise((resolve, reject) => {
    //2.lsitener for "close" event
    output.on("close", resolve);
    //define listener for error event
    output.on("error", reject);
    //1.this will eventually triggers the "close" event on output
    archive.finalize();
  });

  //ZIP JE KREIRAN U FOLDERU U KOJEM SE POKRECE OVAJ SCRIPT
  //I IMENUJE SE SA: const zipFile = "all_media.zip";
  console.log("✅ ZIP created locally.");

  // === Upload to Cloudflare R2 ===
  //ime exportovanog fajla
  const uploadKey = `exports/all_media_${Date.now()}.zip`;

  //PRETVORI FAJLOVE KOJI SU ZIPOVANI U zipFile U
  //REDABLE STREAM
  const fileStream = fs.createReadStream(zipFile);

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: uploadKey,
      Body: fileStream,
      ContentType: "application/zip",
    }),
  );

  console.log(`🚀 Uploaded to R2: ${uploadKey}`);

  //CREATE DOWNLOADABLE LINK
  const url = await generateSignedUrl(R2_BUCKET, uploadKey);
  console.log(`🔗 Public link  valid for 24h: ${url}`);

  // cleanup
  //CLOSE MONGODB CONNECTION
  await mongoClient.close();

  //DELETE LOCALY CREATED ZIPFILE
  fs.unlinkSync(zipFile);
  console.log("🧹 Done, local ZIP deleted.");
}

exportMediaZip()
  .then(() => console.log("Export complete"))
  .catch((err) => console.error("Export failed:", err));
