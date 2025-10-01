// src/graph.js
import { PublicClientApplication, InteractionRequiredAuthError } from "@azure/msal-browser";

const msalConfig = {
  auth: {
    clientId: "0357faa9-f2d4-41bd-9415-3fb08efc7e6d",          // TODO: replace
    authority: "https://login.microsoftonline.com/f82fa673-3d3a-4903-a61f-3cc1fd9b468a", // TODO: replace
    redirectUri: window.location.origin,    // your app origin
  },
  cache: { cacheLocation: "localStorage", storeAuthStateInCookie: false },
};

const SCOPES = ["Mail.ReadWrite", "Mail.Send"]; // Send optional

export const msal = new PublicClientApplication(msalConfig);

async function getToken() {
  const accounts = msal.getAllAccounts();
  const account = accounts[0] || (await msal.loginPopup({ scopes: SCOPES })).account;
  try {
    const res = await msal.acquireTokenSilent({ account, scopes: SCOPES });
    return res.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      const res = await msal.acquireTokenPopup({ account, scopes: SCOPES });
      return res.accessToken;
    }
    throw e;
  }
}

async function graphFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph ${options.method || "GET"} ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Create Outlook drafts in batches (Graph $batch supports 20 per request).
 * messages: array of { to, subject, htmlBody, replyTo? }
 * returns: array of { id, to, subject }
 */
export async function createDrafts(messages) {
  const chunk = (arr, n) => arr.reduce((a, _, i) => (i % n ? a : [...a, arr.slice(i, i + n)]), []);
  const batches = chunk(messages, 20);
  const created = [];

  for (const batch of batches) {
    // Build batch body
    const body = {
      requests: batch.map((m, i) => ({
        id: String(i + 1),
        method: "POST",
        url: "/me/messages",
        headers: { "Content-Type": "application/json" },
        body: {
          subject: m.subject,
          toRecipients: [{ emailAddress: { address: m.to } }],
          replyTo: (m.replyTo ? [{ emailAddress: { address: m.replyTo } }] : []),
          body: { contentType: "HTML", content: m.htmlBody || "" },
        },
      })),
    };

    const result = await graphFetch("/$batch", {
      method: "POST",
      body: JSON.stringify(body),
    });

    for (const r of result.responses) {
      if (r.status >= 200 && r.status < 300) {
        created.push({
          id: r.body.id,
          subject: r.body.subject,
          to: r.body.toRecipients?.[0]?.emailAddress?.address,
        });
      } else {
        console.warn("Draft failed", r.status, r.body);
      }
    }
  }

  return created;
}

/**
 * Optional: send a message by id
 */
export async function sendDraft(messageId) {
  await graphFetch(`/me/messages/${messageId}/send`, { method: "POST" });
}
