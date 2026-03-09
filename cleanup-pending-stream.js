// cleanup-pending-stream.js
import dotenv from "dotenv";

dotenv.config();

const { CF_ACCOUNT_ID, CF_STREAM_TOKEN } = process.env;

async function listVideos() {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream`,
      {
        headers: {
          Authorization: `Bearer ${CF_STREAM_TOKEN}`,
        },
      },
    );

    if (!res.ok) {
      throw new Error(`Cloudflare API error: ${res.status}`);
    }

    const data = await res.json();
    return data.result || [];
  } catch (err) {
    console.error("❌ Failed to fetch video list:", err.message);
    return [];
  }
}

async function deletePendingVideo(uid) {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream/${uid}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${CF_STREAM_TOKEN}`,
        },
      },
    );

    if (!res.ok) {
      throw new Error(`Delete failed (${res.status})`);
    }

    console.log("✅ Deleted:", uid);
  } catch (err) {
    console.error(`❌ Failed deleting ${uid}:`, err.message);
  }
}

async function cleanup() {
  try {
    const videos = await listVideos();

    console.log(`Found ${videos.length} videos`);

    for (const video of videos) {
      try {
        console.log("video.status?.state ", video.status?.state);
        if (video.status?.state === "pendingupload") {
          console.log("Deleting pending:", video.uid);
          await deletePendingVideo(video.uid);
        }
      } catch (err) {
        console.error("Error processing video:", video.uid, err.message);
      }
    }

    console.log("✔ Cleanup finished");
  } catch (err) {
    console.error("❌ Cleanup script failed:", err.message);
  }
}

cleanup();
