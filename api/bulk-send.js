// /api/bulk-send.js
// Vercel/Next.js Serverless Function (Node runtime)
// Expects POST body: { user: { provider: "microsoft"|"google", accessToken: "..." }, messages: [{to, subject, text, replyTo?}] }

const CONCURRENCY = 5;

/* ---------- Gmail helpers ---------- */
function toBase64Url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawRfc822({ to, subject, text, replyTo }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    "Content-Type: text/plain; charset=UTF-8",
  ].join("\r\n");
  return `${headers}\r\n\r\n${text}\r\n`;
}

/* ---------- Providers ---------- */
async function sendViaMicrosoftGraph(accessToken, m) {
  const payload = {
    message: {
      subject: m.subject,
      body: { contentType: "Text", content: m.text },
      toRecipients: [{ emailAddress: { address: m.to } }],
      ...(m.replyTo
        ? { replyTo: [{ emailAddress: { address: m.replyTo } }] }
        : {}),
    },
    saveToSentItems: true,
  };

  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph sendMail failed (${res.status}): ${text}`);
  }
}

async function sendViaGmail(accessToken, m) {
  const raw = toBase64Url(buildRawRfc822(m));
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail send failed (${res.status}): ${text}`);
  }
}

/* ---------- Concurrency helper ---------- */
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          await fn(items[idx]);
          results[idx] = { index: idx, ok: true };
        } catch (e) {
          results[idx] = {
            index: idx,
            ok: false,
            error: String(e.message || e),
          };
        }
      }
    });
  await Promise.all(workers);
  return results;
}

/* ---------- Single default export (handler) ---------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const { user, messages } = req.body || {};
    if (
      !user ||
      !user.provider ||
      !user.accessToken ||
      !Array.isArray(messages) ||
      messages.length === 0
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "Missing user/provider/accessToken or messages",
        });
    }

    const sendOne =
      user.provider === "microsoft"
        ? (m) => sendViaMicrosoftGraph(user.accessToken, m)
        : user.provider === "google"
        ? (m) => sendViaGmail(user.accessToken, m)
        : null;

    if (!sendOne) {
      return res.status(400).json({ ok: false, error: "Unsupported provider" });
    }

    const results = await mapWithLimit(messages, CONCURRENCY, sendOne);
    const ok = results.every((r) => r?.ok);
    return res.status(ok ? 200 : 207).json({ ok, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
