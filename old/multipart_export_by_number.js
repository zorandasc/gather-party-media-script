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

async function processChunk(chunk, partNumber) {
  //IME ZIP FAJLA PRVOOG CHUNKA
  const zipFileName = `all_media_part_${partNumber}.zip`;

  console.log(
    `📦 Creating ZIP part ${partNumber} with ${chunk.length} files...`,
  );

  //KREIRAJ WRITABLESTRERAM OD TOG IMENA
  const output = fs.createWriteStream(zipFileName);
  //KREIRAJ ARHIVER OBJEKAT
  const archive = archiver("zip", { zlib: { level: 9 } });
  //PAJPUJ STREAM U ARHIVER
  //output JE TARGET U KOJU CE ICI FAJLOVI
  archive.pipe(output);

  for (const media of chunk) {
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
    try {
      const res = await fetch(fileUrl);
      if (!res.ok) {
        console.warn(`⚠️  Skipping ${fileName}, fetch failed: ${res.status}`);
        continue;
      }
      // Stream network response directly into ZIP
      archive.append(res.body, { name: fileName });
    } catch (error) {
      console.error(`❌ Error fetching/adding ${fileName}:`, error);
    }
  } //UNUTRASNJA MEDIA PETLJA ZVRSENA

  // Finalize archive and wait for it to complete
  await new Promise((resolve, reject) => {
    output.on("close", () => {
      console.log(
        `✅ ZIP part ${partNumber} complete (${archive.pointer()} bytes).`,
      );
      resolve();
    });
    output.on("error", reject);
    archive.finalize();
  });

  // === Upload to R2  ===
  const uploadKey = `exports/${zipFileName}`;
  const fileStream = fs.createReadStream(zipFileName);

  try {
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
  } catch (error) {
    console.error(`❌ Upload failed for ${zipFileName}:`, error);
    // decide whether to continue or exit — here we continue to next part
  } finally {
    //DELETE LOCALY CREATED ZIPFILE
    try {
      fs.unlinkSync(zipFileName);
      console.log("🧹 Done, local ZIP deleted.");
    } catch (error) {
      console.warn("Could not delete local zip:", error);
    }
  }
}

// === MAIN ===
async function exportMediaZip() {
  console.log("📦 Starting export...");

  //CONNECT TO MONGODB
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);

  //GET ALL OBJECT FROM MONGODB
  // Fetch all media documents
  const CHUNK_SIZE = 20;
  let chunk = [];
  let partNumber = 1;
  let foundAny = false;
  for await (const media of db.collection("media").find({})) {
    foundAny = true;
    chunk.push(media);
    if (chunk.length === CHUNK_SIZE) {
      await processChunk(chunk, partNumber);
      partNumber++;
      chunk = [];
    }
  }

  if (chunk.length) {
    await processChunk(chunk, partNumber);
  }

  if (!foundAny) {
    console.log("No media found");
  }

  // cleanup
  //CLOSE MONGODB CONNECTION
  await mongoClient.close();
  console.log("🎉 Export complete.");
}

exportMediaZip().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
