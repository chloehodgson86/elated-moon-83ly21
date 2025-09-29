export async function bulkSend({ senderUserId, provider, messages }) {
  // In CodeSandbox, we fake success so you can see the UI flow.
  const hostname =
    (typeof window !== "undefined" && window.location.hostname) || "";
  const inSandbox = /(?:csb\.app|codesandbox\.io)$/.test(hostname);

  if (inSandbox) {
    await new Promise((r) => setTimeout(r, 400)); // pretend work
    return messages.map((m) => ({ rowId: m.rowId, ok: true }));
  }

  // After deploy to Vercel, this path will really call your API.
  const res = await fetch("/api/bulk-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderUserId, provider, messages }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
