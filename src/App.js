2; // App.js
import React, { useMemo, useState, useEffect } from "react";
import Papa from "papaparse";
import JSZip from "jszip";
import * as RC from "recharts";
import { createDrafts } from "./graph";
/* ---------------- Date helpers for aging ---------------- */
function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
// Canonical keys mapper (keep whatever you already have)
const K = {
  customer: "__customer",
  email: "__email",
  invoice: "__invoice",
  amount: "__amount",
  dueDate: "__dueDate",
};
// Formats numbers like 1,209,927.14
const money = (n) =>
  `$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// Read a value from a row regardless of whether it's canonical or raw header based
function pick(row, map, key) {
  if (!row) return undefined; // ✅ guard: row may be undefined
  const canonKey = K?.[key];
  if (canonKey && Object.prototype.hasOwnProperty.call(row, canonKey)) {
    return row[canonKey];
  }
  const mappedKey = map?.[key];
  if (mappedKey && Object.prototype.hasOwnProperty.call(row, mappedKey)) {
    return row[mappedKey];
  }
  return undefined;
}

// Keep only the columns we actually use in state
function slimRow(r, map) {
  return {
    [map.customer]: r[map.customer],
    [map.email]: r[map.email],
    [map.invoice]: r[map.invoice],
    [map.amount]: r[map.amount],
    [map.dueDate]: r[map.dueDate],
  };
}

function daysOverdue(due, base = new Date()) {
  const d = toDate(due);
  if (!d) return 0;
  return Math.floor((base - d) / (1000 * 60 * 60 * 24));
}

/* ---------------- Templates (plain strings!) ---------------- */
const TEMPLATES = {
  Friendly: `Dear {{Customer}},

The following invoices are currently overdue:

{{InvoiceLines}}

Total overdue:  {{TotalOverdue}}
{{CreditsSection}}

If you've already paid, please ignore this. Otherwise, could you let us know the expected date of payment?

Kind regards,
Accounts Receivable`,

  Firm: `Hello {{Customer}},

Despite previous reminders, the following invoices remain overdue:

{{InvoiceLines}}

Total overdue:  {{TotalOverdue}}
{{CreditsSection}}

Please arrange payment today or reply with your remittance advice and pay date.

Regards,
Accounts Receivable`,

  "Final Notice": `FINAL NOTICE – {{Customer}}

Your account is on hold due to the overdue balance below:

{{InvoiceLines}}

Total overdue:  {{TotalOverdue}}
{{CreditsSection}}

Unless full payment is received within 3 business days, we may suspend further supply.

Accounts Receivable`,
};

/* ---------------- CSV helpers ---------------- */
const PRESETS = {
  customer: [
    "customer",
    "customer name",
    "account name",
    "client",
    "client name",
    "trading name",
  ],
  email: ["email", "e-mail", "email address", "contact email"],
  invoice: [
    "invoice",
    "invoice number",
    "invoice #",
    "inv#",
    "doc",
    "document",
    "invoice id",
    "invoiceid",
    "inv id",
  ],
  amount: [
    "amount",
    "total",
    "debit",
    "balance",
    "amount due",
    "outstanding",
    "total overdue", // <-- add these
    "overdue total",
    "total_overdue",
  ],
  dueDate: ["duedate", "due date", "due", "terms date"],
};

function cleanNumber(v) {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  const s = String(v)
    .replace(/[^0-9.,-]/g, "")
    // keep thousands commas that are followed by 3 digits; remove others
    .replace(/,(?=\d{3}(\D|$))/g, "");
  const normalized = s.includes(".") ? s : s.replace(/,/g, ".");
  const n = Number(normalized || 0);
  return Number.isFinite(n) ? n : 0;
}

function autoMap(headers) {
  const hLow = headers.map((h) => String(h).toLowerCase());

  // exact match first, then contains
  const pick = (list) => {
    for (const want of list) {
      const i = hLow.indexOf(want);
      if (i !== -1) return headers[i];
    }
    for (const want of list) {
      const i = hLow.findIndex((h) => h.includes(want));
      if (i !== -1) return headers[i];
    }
    return "";
  };

  return {
    customer: pick(PRESETS.customer),
    email: pick(PRESETS.email),
    invoice: pick(PRESETS.invoice),
    amount: pick(PRESETS.amount),
    dueDate: pick(PRESETS.dueDate),
  };
}

function buildEmlFile(to, subject, body) {
  const headers = [
    "MIME-Version: 1.0",
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ].join("\r\n");
  return `${headers}\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n`;
}

/* ---------------- Main App ---------------- */
export default function App() {
  useEffect(() => {
    document.title = "Overdue Invoice Reminder Generator — by Chloe Hodgson";
  }, []);
  // CSV + mapping
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [map, setMap] = useState({
    customer: "",
    invoice: "",
    amount: "",
    dueDate: "",
    email: "",
  });

  // templates
  const [tplKey, setTplKey] = useState("Friendly");
  const [customTpl, setCustomTpl] = useState(TEMPLATES.Friendly);

  // dashboard action stats
  const [dash, setDash] = useState({
    mailOpened: 0,
    emlCreated: 0,
    missingEmail: 0,
  });

  // selection for bulk actions
  const [selected, setSelected] = useState(() => new Set());
  const toggleOne = (name) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  const selectAll = (list) => setSelected(new Set(list));
  const clearAll = () => setSelected(new Set());

  // CSV upload
  function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const buffer = [];
    let headersSet = false;
    let guessed = null;

    Papa.parse(file, {
      header: true,
      worker: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      chunkSize: 1024 * 256, // ~256KB
      chunk: ({ data, meta }) => {
        if (!headersSet) {
          const hdrs = meta?.fields || Object.keys(data[0] || {});
          setHeaders(hdrs);
          guessed = autoMap(hdrs);
          setMap(guessed);
          headersSet = true;
        }

        for (const r of data) {
          const name = (r[guessed.customer] ?? "").toString().trim();
          if (!name) continue;
          const amt = cleanNumber(r[guessed.amount]);
          if (!amt) continue; // drop empty/zero early

          // Save **canonical** keys so later mapping changes won't break anything
          buffer.push({
            [K.customer]: r[guessed.customer],
            [K.email]: r[guessed.email],
            [K.invoice]: r[guessed.invoice],
            [K.amount]: r[guessed.amount],
            [K.dueDate]: r[guessed.dueDate],
          });
        }
      },
      complete: () => {
        setRows(buffer); // one state update
        clearAll();
      },
      error: (err) => {
        console.error(err);
        alert("CSV parse error: " + (err?.message || err));
      },
    });
  }

  // unique customers
  const customers = useMemo(() => {
    if (!rows.length) return [];
    const set = new Set();
    for (const r of rows) {
      const name = (pick(r, map, "customer") ?? "").toString().trim();
      if (name) set.add(name);
    }
    return [...set];
  }, [rows, map.customer]); // dependency can stay as-is

  // helper: total overdue (positive) amount for a given customer
  const overdueTotalFor = (name) =>
    rows.reduce((sum, r) => {
      const isCust =
        (pick(r, map, "customer") ?? "").toString().trim() === name;
      if (!isCust) return sum;
      const amt = cleanNumber(pick(r, map, "amount"));
      return amt > 0 ? sum + amt : sum;
    }, 0);

  // only customers with overdue > 0 are shown/emailable
  const emailableCustomers = useMemo(
    () => customers.filter((n) => overdueTotalFor(n) > 0),
    [customers, rows, map]
  );

  // keep selection in sync with the filtered list
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(emailableCustomers);
      return new Set([...prev].filter((n) => allowed.has(n)));
    });
  }, [emailableCustomers]);

  // dashboard data (aggregates + charts) — uses ALL rows/customers
  const dashboard = useMemo(() => {
    // ✅ Create the map here
    const per = new Map(); // customer -> { total, count, oldestDue, oldestDays }

    // Build map of totals
    for (const r of rows) {
      const name = (pick(r, map, "customer") ?? "").toString().trim();
      if (!name) continue;

      const amt = cleanNumber(pick(r, map, "amount"));
      const due = pick(r, map, "dueDate") ?? "";
      const d = daysOverdue(due);

      const cur = per.get(name) || {
        total: 0,
        count: 0,
        oldestDue: due,
        oldestDays: d,
      };
      cur.total += amt || 0;
      cur.count += 1;

      if (d > (cur.oldestDays ?? 0)) {
        cur.oldestDays = d;
        cur.oldestDue = due;
      }

      per.set(name, cur);
    }

    // Totals and email count
    let totalOverdueAll = 0;
    let withEmail = 0;

    for (const name of customers) {
      const agg = per.get(name);
      if (agg) totalOverdueAll += Math.max(0, agg.total);

      const hasEmail = rows.some(
        (r) =>
          (pick(r, map, "customer") ?? "").toString().trim() === name &&
          (pick(r, map, "email") ?? "").toString().trim()
      );
      if (hasEmail) withEmail += 1;
    }

    // Aging buckets
    const buckets = { "0–30": 0, "31–60": 0, "61+": 0 };
    for (const [, agg] of per) {
      const d = agg.oldestDays || 0;
      if (d <= 30) buckets["0–30"] += Math.max(0, agg.total);
      else if (d <= 60) buckets["31–60"] += Math.max(0, agg.total);
      else buckets["61+"] += Math.max(0, agg.total);
    }

    const pie = Object.entries(buckets).map(([name, value]) => ({
      name,
      value: Number(value.toFixed(2)),
    }));

    const top = [...per.entries()]
      .map(([name, agg]) => ({
        name,
        total: Number(Math.max(0, agg.total).toFixed(2)),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // ✅ Final return for useMemo
    return {
      totals: {
        customers: customers.length,
        withEmail,
        selected: selected.size,
        totalOverdueAll: Number(totalOverdueAll.toFixed(2)),
      },
      pie,
      top,
    };
  }, [rows, map, customers, selected.size]); // <-- dependency array closes it here

  const allSelected =
    selected.size === emailableCustomers.length &&
    emailableCustomers.length > 0;

  // email content

  function generateEmail(customerName) {
    const custRows = rows.filter(
      (r) => (pick(r, map, "customer") ?? "").toString().trim() === customerName
    );

    const overdueRows = custRows.filter(
      (r) => cleanNumber(pick(r, map, "amount")) > 0
    );
    const creditRows = custRows.filter(
      (r) => cleanNumber(pick(r, map, "amount")) < 0
    );
    const overdueLines = overdueRows.map((r) => {
      const inv = pick(r, map, "invoice") ?? "";
      const due = pick(r, map, "dueDate") ?? "";
      const amt = cleanNumber(pick(r, map, "amount"));
      return `- Invoice ${inv} — ${money(amt)} due ${due}`;
    });

    const creditLines = creditRows.map((r) => {
      const ref = pick(r, map, "invoice") ?? "";
      const date = pick(r, map, "dueDate") ?? "";
      const amt = cleanNumber(pick(r, map, "amount")); // negative
      return `- Credit ${ref} — ${money(amt)} dated ${date}`;
    });

    const totalOverdue = overdueRows.reduce(
      (s, r) => s + cleanNumber(pick(r, map, "amount")),
      0
    );
    const totalCredits = creditRows.reduce(
      (s, r) => s + Math.abs(cleanNumber(pick(r, map, "amount"))),
      0
    );
    const netPayable = totalOverdue - totalCredits;

    // Find the first row with a non-empty email for this customer (may not exist)
    const firstWithEmail = custRows.find((r) =>
      (pick(r, map, "email") ?? "").toString().trim()
    );
    const contact = (
      (firstWithEmail && pick(firstWithEmail, map, "email")) ||
      ""
    )
      .toString()
      .trim();

    // Use your preferred subject
    const subject = `Paramount Liquor Overdue Invoices - ${customerName}`;

    const chosen =
      tplKey === "Custom" ? customTpl : TEMPLATES[tplKey] || TEMPLATES.Friendly;
    const creditsSection =
      creditRows.length > 0
        ? `
    Unapplied credits (available to offset):
    ${creditLines.join("\n")}
    
    Total credits: ${money(totalCredits)}

    Net amount now due: ${money(netPayable)}
    
    `
        : "";

    const body = chosen
      .replaceAll("{{Customer}}", customerName)
      .replaceAll("{{InvoiceLines}}", overdueLines.join("\n") || "(none)")
      .replaceAll("{{TotalOverdue}}", money(totalOverdue))

      .replaceAll("{{CreditsSection}}", creditsSection);

    return { contact, subject, body };
  }
async function handleCreateOutlookDrafts(selectedRows) {
  const STAFF_REPLY_TO = {
    "Chloe Hodgson": "chloe.hodgson@paramountliquor.com.au",
    "Nina": "nina.padilla@paramountliquor.com.au",
    "Merry": "merry.adriano@paramountliquor.com.au",
    "Mildred": "mildred.malalis@paramountliquor.com.au",
    "Reynaldo": "reynaldo.gaspar@paramountliquor.com.au",
    "Angel": "angelika.gabriel@paramountliquor.com.au",
    "Charmaine": "charmaine.romero@paramountliquor.com.au"
    "Toa": "toa.nansen@paramountliquor.com.au"
  
    // …etc
  };

  const messages = selectedRows.map(row => {
    const subject = row.__subject;      // your generated subject
    const htmlBody = row.__html;        // your generated email body
    const to = row.__email;             // customer email
    const owner = row.__ownerName;      // staff name from your data
    const replyTo = STAFF_REPLY_TO[owner] || "accounts@yourcompany.com";
    return { to, subject, htmlBody, replyTo };
  });

  try {
    const created = await createDrafts(messages);
    alert(`Created ${created.length} Outlook drafts.\nCheck your Outlook Drafts folder.`);
  } catch (e) {
    console.error(e);
    alert(`Failed: ${e.message}`);
  }
}

  // bulk mailto
  async function openSelectedMailto() {
    const list = Array.from(selected);
    if (!list.length) return;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    for (const name of list) {
      const { contact, subject, body } = generateEmail(name);
      if (!contact) {
        setDash((d) => ({ ...d, missingEmail: d.missingEmail + 1 }));
        continue;
      }
      window.open(
        `mailto:${encodeURIComponent(contact)}?subject=${encodeURIComponent(
          subject
        )}&body=${encodeURIComponent(body)}`,
        "_blank"
      );
      setDash((d) => ({ ...d, mailOpened: d.mailOpened + 1 }));
      await delay(300);
    }
  }

  // bulk ZIP
  async function downloadSelectedAsZip() {
    if (!selected.size) return;
    const zip = new JSZip();

    for (const name of selected) {
      const { contact, subject, body } = generateEmail(name);
      const eml = buildEmlFile(contact || "", subject, body);
      const filename = `${name.replace(/[^a-z0-9]/gi, "_")}.eml`;
      // Storing without compression = lower CPU/memory for many small files
      zip.file(filename, eml, { compression: "STORE" });
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "overdue_emails_selected.zip";
    a.click();
    URL.revokeObjectURL(url);
    setDash((d) => ({ ...d, emlCreated: d.emlCreated + selected.size }));
  }

  return (
    <div style={{ padding: 20, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1>Overdue Invoice Reminder Generator</h1>

      <input type="file" accept=".csv" onChange={handleUpload} />

      {/* Mapping panel */}
      {headers.length > 0 && (
        <div
          style={{
            marginTop: 16,
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Map your CSV columns
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {[
              ["customer", "Customer (required)"],
              ["email", "Email (optional)"],
              ["invoice", "Invoice # (required)"],
              ["amount", "Amount (required)"],
              ["dueDate", "Due Date (required)"],
            ].map(([key, label]) => (
              <label
                key={key}
                style={{ display: "grid", gap: 6, fontSize: 12 }}
              >
                <span>{label}</span>
                <select
                  value={map[key]}
                  onChange={(e) =>
                    setMap((m) => ({ ...m, [key]: e.target.value }))
                  }
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #ddd",
                  }}
                >
                  <option value="">— choose a header —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {/* Template selector */}
          <div style={{ marginTop: 12 }}>
            <label>
              Template:&nbsp;
              <select
                value={tplKey}
                onChange={(e) => setTplKey(e.target.value)}
              >
                {Object.keys(TEMPLATES).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="Custom">Custom…</option>
              </select>
            </label>
          </div>

          {tplKey === "Custom" && (
            <textarea
              value={customTpl}
              onChange={(e) => setCustomTpl(e.target.value)}
              placeholder="Use {{Customer}}, {{InvoiceLines}}, {{TotalOverdue}}, {{CreditsSection}}"
              rows={6}
              style={{
                width: "100%",
                marginTop: 8,
                padding: 10,
                borderRadius: 8,
                border: "1px solid #ddd",
                fontFamily: "inherit",
              }}
            />
          )}
        </div>
      )}

      {/* Bulk toolbar */}
      {emailableCustomers.length > 0 && (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                e.target.checked ? selectAll(emailableCustomers) : clearAll()
              }
            />{" "}
            Select all
          </label>
          <button onClick={() => selectAll(emailableCustomers)}>
            Select all
          </button>
          <button onClick={clearAll} disabled={!selected.size}>
            Clear
          </button>
          <button
            onClick={openSelectedMailto}
            disabled={!selected.size}
            style={{
              background: "#1a73e8",
              color: "#fff",
              padding: "6px 12px",
              borderRadius: 6,
            }}
          >
            Open Mailto ({selected.size})
          </button>
          <button
            onClick={downloadSelectedAsZip}
            disabled={!selected.size}
            style={{
              background: "#16a34a",
              color: "#fff",
              padding: "6px 12px",
              borderRadius: 6,
            }}
<div className="button-row">
  <button onClick={handleOpenMailto}>Open Mailto ({selected.length})</button>
  <button onClick={handleDownloadEml}>Download .eml (ZIP)</button>
  <button onClick={() => handleCreateOutlookDrafts(selected)}>
    Create Outlook Drafts (Graph)
  </button>
</div>
          >
            Download .eml (ZIP)
          </button>
        </div>
      )}

      {/* DASHBOARD */}
      {customers.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2>Dashboard</h2>

          {/* KPI cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            {[
              ["Total customers", dashboard.totals.customers],
              ["With email", dashboard.totals.withEmail],
              ["Selected", dashboard.totals.selected],
              [
                "Total overdue (all)",
                `$${dashboard.totals.totalOverdueAll.toLocaleString()}`,
              ],
              ["Mailto opened", dash.mailOpened],
              ["EML files created", dash.emlCreated],
              ["Missing email (skipped)", dash.missingEmail],
            ].map(([label, value]) => (
              <div
                key={label}
                style={{
                  border: "1px solid #eee",
                  borderRadius: 12,
                  padding: 12,
                }}
              >
                <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Charts */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginTop: 16,
            }}
          >
            <div
              style={{
                height: 280,
                border: "1px solid #eee",
                borderRadius: 12,
                padding: 8,
              }}
            >
              <div style={{ fontWeight: 600, margin: "4px 8px" }}>
                Amount by Aging Bucket
              </div>
              <RC.ResponsiveContainer width="100%" height="90%">
                <RC.PieChart>
                  <RC.Pie
                    data={dashboard.pie}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={80}
                    label
                  />
                  <RC.Tooltip />
                  <RC.Legend />
                  {dashboard.pie.map((_, i) => (
                    <RC.Cell key={i} />
                  ))}
                </RC.PieChart>
              </RC.ResponsiveContainer>
            </div>

            <div
              style={{
                height: 280,
                border: "1px solid #eee",
                borderRadius: 12,
                padding: 8,
              }}
            >
              <div style={{ fontWeight: 600, margin: "4px 8px" }}>
                Top 10 Customers by Overdue
              </div>
              <RC.ResponsiveContainer width="100%" height="90%">
                <RC.BarChart data={dashboard.top}>
                  <RC.CartesianGrid strokeDasharray="3 3" />
                  <RC.XAxis dataKey="name" hide />
                  <RC.YAxis />
                  <RC.Tooltip />
                  <RC.Bar dataKey="total">
                    {dashboard.top.map((_, i) => (
                      <RC.Cell key={i} />
                    ))}
                  </RC.Bar>
                </RC.BarChart>
              </RC.ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Customer list (ONLY with overdue) */}
      {emailableCustomers.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2>Generated Emails</h2>
          {emailableCustomers.map((cust) => {
            const { contact, subject, body } = generateEmail(cust);
            return (
              <div
                key={cust}
                style={{
                  border: "1px solid #e5e5e5",
                  padding: 12,
                  borderRadius: 12,
                  marginTop: 12,
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <div>
                    <input
                      type="checkbox"
                      checked={selected.has(cust)}
                      onChange={() => toggleOne(cust)}
                    />{" "}
                    <strong>{cust}</strong>{" "}
                    {contact && <span>({contact})</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {contact && (
                      <a
                        href={`mailto:${encodeURIComponent(
                          contact
                        )}?subject=${encodeURIComponent(
                          subject
                        )}&body=${encodeURIComponent(body)}`}
                        style={{
                          background: "#007bff",
                          color: "white",
                          padding: "6px 12px",
                          borderRadius: 6,
                          textDecoration: "none",
                          fontSize: 14,
                        }}
                      >
                        Open Email
                      </a>
                    )}
                    <button
                      onClick={() => {
                        const eml = buildEmlFile(contact || "", subject, body);
                        const blob = new Blob([eml], {
                          type: "message/rfc822",
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${cust.replace(/[^a-z0-9]/gi, "_")}.eml`;
                        a.click();
                        URL.revokeObjectURL(url);
                        setDash((d) => ({
                          ...d,
                          emlCreated: d.emlCreated + 1,
                        }));
                      }}
                      style={{
                        background: "#28a745",
                        color: "white",
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontSize: 14,
                        border: "none",
                      }}
                    >
                      Download .eml
                    </button>
                  </div>
                </div>

                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    background: "#fafafa",
                    borderRadius: 8,
                    padding: 8,
                    marginTop: 10,
                  }}
                >{`Subject: ${subject}\n\n${body}`}</pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
