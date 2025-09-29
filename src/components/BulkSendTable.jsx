import React from "react";
import { bulkSend } from "../apiClient";

export default function BulkSendTable({ rows, currentUser }) {
  const [selectedIds, setSelectedIds] = React.useState(new Set());
  const [statusById, setStatusById] = React.useState({});
  const [sending, setSending] = React.useState(false);

  const allIds = rows.map((r) => r.id);
  const allSelected = selectedIds.size === rows.length && rows.length > 0;
  const anySelected = selectedIds.size > 0;

  function toggleOne(id, checked) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked) {
    setSelectedIds(checked ? new Set(allIds) : new Set());
  }

  async function sendSelected() {
    if (!anySelected || sending) return;
    setSending(true);
    const ids = Array.from(selectedIds);

    setStatusById((prev) => {
      const next = { ...prev };
      ids.forEach((id) => (next[id] = "queued"));
      return next;
    });

    const messages = rows
      .filter((r) => selectedIds.has(r.id))
      .map((r) => ({
        rowId: r.id,
        to: r.email,
        subject: `Overdue reminder: ${r.customer}`,
        html: r.renderedHtml,
        text: r.renderedText || "",
      }));

    try {
      const results = await bulkSend({
        senderUserId: currentUser.id,
        provider: currentUser.provider,
        messages,
      });
      setStatusById((prev) => {
        const next = { ...prev };
        results.forEach(
          (r) =>
            (next[r.rowId] = r.ok ? "sent" : `failed: ${r.error || "error"}`)
        );
        return next;
      });
    } catch (e) {
      setStatusById((prev) => {
        const next = { ...prev };
        ids.forEach((id) => (next[id] = `failed: ${e.message}`));
        return next;
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ padding: 12 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(e) => toggleAll(e.target.checked)}
        />
        <span>{selectedIds.size} selected</span>
        <button disabled={!anySelected || sending} onClick={sendSelected}>
          {sending
            ? "Sending…"
            : `Send ${selectedIds.size} email${
                selectedIds.size === 1 ? "" : "s"
              }`}
        </button>
      </div>
      <table
        width="100%"
        cellPadding="8"
        style={{ borderCollapse: "collapse" }}
      >
        <thead>
          <tr>
            <th></th>
            <th>Customer</th>
            <th>Email</th>
            <th>Total Overdue</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #eee" }}>
              <td>
                <input
                  type="checkbox"
                  checked={selectedIds.has(r.id)}
                  onChange={(e) => toggleOne(r.id, e.target.checked)}
                />
              </td>
              <td>{r.customer}</td>
              <td>{r.email}</td>
              <td>{r.totalOverdue}</td>
              <td>{statusById[r.id] || "idle"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
