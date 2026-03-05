import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const { SMTP_USER, SMTP_PASS, MAIL_FROM = SMTP_USER, MAIL_TO } = process.env;

function formatBytes(bytes = 0) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

//BUILD HTML BODY OF MAIL
function buildHtml(manifestData) {
  const rows = (manifestData.files || [])
    .map(
      (f) => `
      <tr>
        <td style="padding:12px; border-bottom:1px solid #eee; font-size:14px;">Part ${f.partNumber}</td>
        <td style="padding:12px; border-bottom:1px solid #eee; font-size:14px; color:#666;">${f.fileCount} items</td>
        <td style="padding:12px; border-bottom:1px solid #eee; font-size:14px; color:#666;">${f.partSizeMB ?? formatBytes(f.partSizeBytes)}</td>
        <td style="padding:12px; border-bottom:1px solid #eee; text-align:right;">
          <a href="${f.downloadUrl}" style="background-color:#b59a7b; color:#ffffff; padding:8px 16px; text-decoration:none; border-radius:4px; font-size:12px; display:inline-block;">Preuzmi ZIP</a>
        </td>
      </tr>`,
    )
    .join("");

  return `
<div style="background-color:#f9f7f5; padding:40px 10px; font-family:'Segoe UI', Helvetica, Arial, sans-serif;">
      <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 4px 10px rgba(0,0,0,0.05);">
        <tr>
          <td align="center" valign="top" bgcolor="#eaddd1" style="background-image: url('https://plus.unsplash.com/premium_vector-1744118032844-361799bdeb40?q=80&w=1112&auto=format&fit=crop'); background-size: cover; background-position: center; padding: 60px 40px; border-radius: 8px 8px 0 0;">
            <div>
              <h1 style="margin:0; color:#4a4a4a; font-size:28px; font-family:'Georgia', serif; font-weight:300; letter-spacing:2px; text-shadow: 1px 1px 2px rgba(255,255,255,0.8);">
                Vaše uspomene sa venčanja
              </h1>
              <p style="color:#666; margin-top:0px; font-size:16px; font-style: italic;">Vaše uspomene su spremne za preuzimanje</p>
            </div>
            </td>
        </tr>
        <tr>
          <td style="padding:30px;">
            <table width="100%" style="margin-bottom:20px; font-size:14px; color:#444;">
              <tr>
                <td><strong>Kreirano:</strong> ${manifestData.createdAt}</td>
                <td style="text-align:right;"><strong>Ukupna veličina:</strong> ${formatBytes(manifestData.totalSizeBytes)}</td>
              </tr>
            </table>

            <table width="100%" style="border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; border-bottom:2px solid #f4f0ed;">
                  <th style="padding:12px; color:#b59a7b; font-size:12px; text-transform:uppercase;">Paket</th>
                  <th style="padding:12px; color:#b59a7b; font-size:12px; text-transform:uppercase;">Fajlovi</th>
                  <th style="padding:12px; color:#b59a7b; font-size:12px; text-transform:uppercase;">Veličina</th>
                  <th style="padding:12px; text-align:right; color:#b59a7b; font-size:12px; text-transform:uppercase;">Akcija</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            
            <p style="margin-top:30px; font-size:12px; color:#999; text-align:center;">
              <strong>Linkovi će biti aktivni 7 dana.</strong>  Ukoliko imate bilo kakvih pitanja, slobodno odgovorite na ovaj mejl.
            </p>
          </td>
        </tr>
      </table>
    </div>
`;
}

async function main() {
  const manifestUrl = process.argv[2];
  const recipient = process.argv[3] || MAIL_TO;

  if (!manifestUrl)
    throw new Error(
      "Usage: node send_export_email.js <manifestUrl> [recipient]",
    );
  if (!recipient)
    throw new Error("Missing recipient (arg #2 or MAIL_TO env var).");
  if (!SMTP_USER || !SMTP_PASS)
    throw new Error("Missing SMTP_USER/SMTP_PASS env vars.");

  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
  const manifestData = await res.json();

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const subject = `Vaše uspomene sa venčanja su spremne ✨`;
  const html = buildHtml(manifestData);

  await transporter.sendMail({
    from: MAIL_FROM,
    to: recipient,
    subject,
    html,
  });

  console.log(`Email sent to ${recipient}`);
}

main().catch((err) => {
  console.error("Send email failed:", err.message);
  process.exit(1);
});
