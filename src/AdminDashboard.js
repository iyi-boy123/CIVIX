import React, { useState, useEffect, useCallback } from "react";

/* ======================================================================
   CIVIX Admin Dashboard
   A standalone component: password-only login (POST /api/admin/login),
   then one tab per database table with a list and add / edit / delete
   forms. Every request after login sends the token in an
   "x-admin-token" header.

   Needs the CIVIX API (server.js) running — see API_BASE below.
====================================================================== */

const API_BASE = "http://localhost:4000/api";
const SESSION_KEY = "civix_admin_session";

/* ---------------------------------------------------------------- */
/* API helpers                                                       */
/* ---------------------------------------------------------------- */
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["x-admin-token"] = token;

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach the CIVIX server. Is it running at " + API_BASE + "?", 0);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* response had no JSON body */
  }
  if (!res.ok) {
    throw new ApiError((json && json.error) || `Request failed (${res.status}).`, res.status);
  }
  return json;
}

// The API returns at most 500 rows per request, so page through until done.
async function fetchAllRows(table, token) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await request(`/${table}?limit=500&offset=${offset}`, { token });
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (s && s.token && new Date(s.expires_at) > new Date()) return s;
  } catch {
    /* ignore */
  }
  return null;
}

function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable — the session just won't survive a refresh */
  }
}

/* ---------------------------------------------------------------- */
/* Date helpers (MySQL DATETIME <-> <input type="datetime-local">)   */
/* ---------------------------------------------------------------- */
const pad = (n) => String(n).padStart(2, "0");

function toInputDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fromInputDateTime(value) {
  const v = value.replace("T", " ");
  return v.length === 16 ? v + ":00" : v; // add seconds if the browser left them off
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/* ---------------------------------------------------------------- */
/* Table definitions — mirror schema.sql and the server's routes     */
/*   list   : columns shown in the table                             */
/*   fields : every column except the id; create/update say whether  */
/*            the server accepts it on POST / PUT                    */
/* ---------------------------------------------------------------- */
const TABLES = {
  users: {
    label: "Users",
    singular: "user",
    pk: ["id"],
    list: ["id", "full_name", "email", "phone", "created_at"],
    fields: [
      { name: "full_name", label: "Full name", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone" },
      {
        name: "password",
        label: "Password",
        type: "password",
        required: true,
        hint: "At least 8 characters. When editing, leave blank to keep the current password.",
      },
      { name: "created_at", label: "Created", type: "datetime", create: false, update: false },
    ],
  },
  departments: {
    label: "Departments",
    singular: "department",
    pk: ["id"],
    list: ["id", "name", "short_name", "chip_label"],
    fields: [
      { name: "name", label: "Name", required: true, hint: 'e.g. "Roads & Infrastructure"' },
      { name: "short_name", label: "Short name", required: true, hint: 'Used in tables, e.g. "Roads & Infra."' },
      { name: "chip_label", label: "Chip label", required: true, hint: 'Sidebar chip, e.g. "Roads"' },
    ],
  },
  categories: {
    label: "Categories",
    singular: "category",
    pk: ["id"],
    list: ["id", "icon", "label", "slug", "department_id"],
    fields: [
      { name: "slug", label: "Slug", required: true, hint: 'Short code, e.g. "pothole"' },
      { name: "label", label: "Label", required: true },
      { name: "icon", label: "Icon", required: true, hint: "One emoji" },
      {
        name: "department_id",
        label: "Routed to department",
        type: "ref",
        ref: "departments",
        hint: "Leave empty for categories that need manual triage.",
      },
    ],
  },
  priorities: {
    label: "Priorities",
    singular: "priority",
    pk: ["id"],
    list: ["id", "label", "sort_order"],
    fields: [
      { name: "label", label: "Label", required: true },
      { name: "sort_order", label: "Sort order", type: "number", required: true, hint: "1 = most urgent" },
    ],
  },
  statuses: {
    label: "Statuses",
    singular: "status",
    pk: ["id"],
    list: ["id", "label", "sort_order"],
    fields: [
      { name: "label", label: "Label", required: true },
      { name: "sort_order", label: "Sort order", type: "number", required: true },
    ],
  },
  officers: {
    label: "Officers",
    singular: "officer",
    pk: ["id"],
    list: ["id", "user_id", "role", "department_id"],
    fields: [
      { name: "user_id", label: "User", type: "ref", ref: "users", required: true },
      { name: "role", label: "Role", required: true, hint: 'e.g. "Admin" or "Field officer"' },
      {
        name: "department_id",
        label: "Department",
        type: "ref",
        ref: "departments",
        hint: "Leave empty for staff who work across all departments.",
      },
    ],
  },
  issues: {
    label: "Issues",
    singular: "issue",
    pk: ["id"],
    list: [
      "id", "public_code", "category_id", "location_label", "description",
      "priority_id", "status_id", "department_id", "assigned_officer_id", "created_at",
    ],
    fields: [
      {
        name: "public_code",
        label: "Issue code",
        requiredOnEdit: true,
        hint: "Leave blank when adding to auto-number (CX-1043, ...).",
      },
      { name: "reporter_id", label: "Reported by", type: "ref", ref: "users", required: true },
      { name: "category_id", label: "Category", type: "ref", ref: "categories", required: true },
      { name: "description", label: "Description", type: "textarea", required: true },
      { name: "location_label", label: "Location", required: true, hint: 'e.g. "Elm St. & 4th Ave"' },
      { name: "latitude", label: "Latitude", type: "decimal" },
      { name: "longitude", label: "Longitude", type: "decimal" },
      { name: "priority_id", label: "Priority", type: "ref", ref: "priorities", required: true },
      { name: "status_id", label: "Status", type: "ref", ref: "statuses", required: true },
      {
        name: "department_id",
        label: "Department",
        type: "ref",
        ref: "departments",
        hint: "Leave blank when adding to route by category.",
      },
      { name: "assigned_officer_id", label: "Assigned officer", type: "ref", ref: "officers" },
      { name: "resolved_at", label: "Resolved at", type: "datetime" },
      { name: "created_at", label: "Reported", type: "datetime", create: false, update: false },
      { name: "updated_at", label: "Last updated", type: "datetime", create: false, update: false },
    ],
  },
  issue_photos: {
    label: "Issue photos",
    singular: "photo",
    pk: ["id"],
    list: ["id", "issue_id", "photo_url", "uploaded_at"],
    fields: [
      { name: "issue_id", label: "Issue", type: "ref", ref: "issues", required: true },
      { name: "photo_url", label: "Photo URL", required: true },
      { name: "uploaded_at", label: "Uploaded", type: "datetime", create: false, update: false },
    ],
  },
  issue_upvotes: {
    label: "Upvotes",
    singular: "upvote",
    pk: ["issue_id", "user_id"],
    list: ["issue_id", "user_id", "created_at"],
    fields: [
      { name: "issue_id", label: "Issue", type: "ref", ref: "issues", required: true, update: false },
      { name: "user_id", label: "User", type: "ref", ref: "users", required: true, update: false },
      { name: "created_at", label: "Voted at", type: "datetime", required: true, create: false },
    ],
  },
  notifications: {
    label: "Notifications",
    singular: "notification",
    pk: ["id"],
    list: ["id", "user_id", "issue_id", "message", "is_read", "created_at"],
    fields: [
      { name: "user_id", label: "Send to", type: "ref", ref: "users", required: true },
      { name: "issue_id", label: "About issue", type: "ref", ref: "issues" },
      { name: "message", label: "Message", type: "textarea", required: true },
      { name: "is_read", label: "Already read", type: "boolean" },
      { name: "created_at", label: "Sent", type: "datetime", create: false, update: false },
    ],
  },
  issue_status_history: {
    label: "Status history",
    singular: "status change",
    pk: ["id"],
    list: ["id", "issue_id", "from_status_id", "to_status_id", "changed_by", "note", "changed_at"],
    fields: [
      { name: "issue_id", label: "Issue", type: "ref", ref: "issues", required: true },
      {
        name: "from_status_id",
        label: "From status",
        type: "ref",
        ref: "statuses",
        hint: "Leave empty for an issue's first entry.",
      },
      { name: "to_status_id", label: "To status", type: "ref", ref: "statuses", required: true },
      { name: "changed_by", label: "Changed by", type: "ref", ref: "users" },
      { name: "note", label: "Note" },
      { name: "changed_at", label: "Changed at", type: "datetime", create: false, update: false },
    ],
  },
};

// How a row of each referenced table is described inside dropdowns and lists.
const REF_LABEL = {
  users: (r) => `${r.full_name} (#${r.id})`,
  departments: (r) => r.name,
  categories: (r) => `${r.icon} ${r.label}`,
  priorities: (r) => r.label,
  statuses: (r) => r.label,
  officers: (r, refData) => {
    const u = (refData.users || []).find((x) => x.id === r.user_id);
    return `${u ? u.full_name : "User #" + r.user_id} · ${r.role}`;
  },
  issues: (r) => `${r.public_code} — ${r.location_label}`,
};

function refTablesFor(cfg) {
  const set = new Set(cfg.fields.filter((f) => f.type === "ref").map((f) => f.ref));
  if (set.has("officers")) set.add("users"); // officer labels show the user's name
  return [...set];
}

const activeFields = (cfg, mode) =>
  cfg.fields.filter((f) => (mode === "create" ? f.create !== false : f.update !== false));

const getDef = (cfg, name) =>
  cfg.fields.find((f) => f.name === name) || { name, label: name === "id" ? "ID" : name };

const pkPath = (cfg, row) => cfg.pk.map((k) => encodeURIComponent(row[k])).join("/");

function cellText(def, value, refData) {
  if (value === null || value === undefined || value === "") return "";
  switch (def.type) {
    case "ref": {
      const row = (refData[def.ref] || []).find((r) => r.id === value);
      return row ? REF_LABEL[def.ref](row, refData) : `#${value}`;
    }
    case "boolean":
      return value ? "Yes" : "No";
    case "datetime":
      return formatDateTime(value);
    default:
      return String(value);
  }
}

/* ---------------------------------------------------------------- */
/* Form helpers                                                      */
/* ---------------------------------------------------------------- */
function initialValues(cfg, mode, row) {
  const values = {};
  for (const f of activeFields(cfg, mode)) {
    const raw = mode === "edit" ? row[f.name] : undefined;
    if (f.type === "boolean") values[f.name] = raw == null ? false : Boolean(raw);
    else if (f.type === "datetime") values[f.name] = toInputDateTime(raw);
    else if (f.type === "password") values[f.name] = "";
    else values[f.name] = raw == null ? "" : String(raw);
  }
  return values;
}

// Turns the form's text values into the JSON the API expects.
function buildPayload(cfg, mode, values) {
  const payload = {};
  const errors = [];
  for (const f of activeFields(cfg, mode)) {
    const v = values[f.name];

    if (f.type === "boolean") {
      payload[f.name] = Boolean(v);
      continue;
    }

    if (v === "" || v == null) {
      const needed = f.required || (mode === "edit" && f.requiredOnEdit);
      if (f.type === "password" && mode === "edit") continue; // blank = keep current password
      if (needed) errors.push(`${f.label} is required.`);
      else if (mode === "edit") payload[f.name] = null; // clears the value
      continue; // when adding, blank optional fields are simply left out
    }

    if (f.type === "number" || f.type === "ref") {
      const n = Number(v);
      if (!Number.isInteger(n)) errors.push(`${f.label} must be a whole number.`);
      else payload[f.name] = n;
    } else if (f.type === "decimal") {
      const n = Number(v);
      if (!Number.isFinite(n)) errors.push(`${f.label} must be a number.`);
      else payload[f.name] = n;
    } else if (f.type === "datetime") {
      payload[f.name] = fromInputDateTime(v);
    } else {
      payload[f.name] = f.type === "password" ? v : v.trim();
    }
  }
  return { payload, errors };
}

/* ================================================================ */
/* Login                                                              */
/* ================================================================ */
function AdminLogin({ onLogin, notice }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      setError("Enter the admin password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { token, expires_at } = await request("/admin/login", {
        method: "POST",
        body: { password },
      });
      setPassword("");
      onLogin({ token, expires_at });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ad-login-wrap">
      <form className="ad-login" onSubmit={submit}>
        <div className="ad-wordmark">
          <span className="ad-dot"></span>CIVIX
        </div>
        <h1>Admin sign in</h1>
        <p className="ad-muted">Enter the admin password to manage CIVIX data.</p>

        {notice && <div className="ad-banner ad-banner-warn">{notice}</div>}

        <label className="ad-label" htmlFor="ad-password">
          Password
        </label>
        <input
          id="ad-password"
          className="ad-input"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <div className="ad-banner ad-banner-error">{error}</div>}

        <button className="ad-btn ad-btn-primary ad-btn-block" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/* ================================================================ */
/* Add / edit form                                                    */
/* ================================================================ */
function RecordForm({ cfg, mode, row, refData, busy, error, onSubmit, onCancel }) {
  const [values, setValues] = useState(() => initialValues(cfg, mode, row));
  const [localErrors, setLocalErrors] = useState([]);
  const fields = activeFields(cfg, mode);
  const set = (name, value) => setValues((v) => ({ ...v, [name]: value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const { payload, errors } = buildPayload(cfg, mode, values);
    setLocalErrors(errors);
    if (!errors.length) onSubmit(payload);
  };

  const identity =
    mode === "edit" ? cfg.pk.map((k) => `${k.replace(/_/g, " ")} ${row[k]}`).join(", ") : "";

  return (
    <form className="ad-card ad-form" onSubmit={handleSubmit}>
      <div className="ad-form-head">
        <h3>
          {mode === "create" ? `Add ${cfg.singular}` : `Edit ${cfg.singular}`}
          {identity && <span className="ad-muted"> · {identity}</span>}
        </h3>
        <button type="button" className="ad-btn ad-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className="ad-form-grid">
        {fields.map((f) => {
          const id = `ad-f-${f.name}`;
          const required = f.required || (mode === "edit" && f.requiredOnEdit);
          const wide = f.type === "textarea";
          return (
            <div className={"ad-field" + (wide ? " wide" : "")} key={f.name}>
              {f.type === "boolean" ? (
                <label className="ad-check" htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={Boolean(values[f.name])}
                    onChange={(e) => set(f.name, e.target.checked)}
                  />
                  {f.label}
                </label>
              ) : (
                <>
                  <label className="ad-label" htmlFor={id}>
                    {f.label}
                    {required && !(f.type === "password" && mode === "edit") ? " *" : ""}
                  </label>
                  {f.type === "ref" ? (
                    <select
                      id={id}
                      className="ad-input"
                      value={values[f.name]}
                      onChange={(e) => set(f.name, e.target.value)}
                    >
                      <option value="">{required ? "— select —" : "— none —"}</option>
                      {(refData[f.ref] || []).map((r) => (
                        <option key={r.id} value={String(r.id)}>
                          {REF_LABEL[f.ref](r, refData)}
                        </option>
                      ))}
                    </select>
                  ) : f.type === "textarea" ? (
                    <textarea
                      id={id}
                      className="ad-input"
                      rows={3}
                      value={values[f.name]}
                      onChange={(e) => set(f.name, e.target.value)}
                    />
                  ) : (
                    <input
                      id={id}
                      className="ad-input"
                      type={
                        f.type === "number" || f.type === "decimal"
                          ? "number"
                          : f.type === "datetime"
                          ? "datetime-local"
                          : f.type === "email"
                          ? "email"
                          : f.type === "password"
                          ? "password"
                          : "text"
                      }
                      step={f.type === "decimal" ? "any" : f.type === "datetime" ? 1 : undefined}
                      autoComplete={f.type === "password" ? "new-password" : "off"}
                      value={values[f.name]}
                      onChange={(e) => set(f.name, e.target.value)}
                    />
                  )}
                </>
              )}
              {f.hint && <div className="ad-hint">{f.hint}</div>}
            </div>
          );
        })}
      </div>

      {localErrors.length > 0 && (
        <div className="ad-banner ad-banner-error">
          {localErrors.map((m) => (
            <div key={m}>{m}</div>
          ))}
        </div>
      )}
      {error && <div className="ad-banner ad-banner-error">{error}</div>}

      <div className="ad-form-actions">
        <button className="ad-btn ad-btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? `Add ${cfg.singular}` : "Save changes"}
        </button>
        <button type="button" className="ad-btn ad-btn-outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ================================================================ */
/* One tab: list + add / edit / delete for a single table             */
/* ================================================================ */
function TablePanel({ table, token, onExpired }) {
  const cfg = TABLES[table];
  const [rows, setRows] = useState(null); // null while loading
  const [refData, setRefData] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(null); // null | { mode: "create" } | { mode: "edit", row }
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmKey, setConfirmKey] = useState(null);
  const [search, setSearch] = useState("");

  const handleError = useCallback(
    (err, show) => {
      if (err.status === 401) onExpired();
      else show(err.message);
    },
    [onExpired]
  );

  const load = useCallback(async () => {
    setError("");
    try {
      const refTables = refTablesFor(cfg);
      const [list, ...refs] = await Promise.all([
        fetchAllRows(table, token),
        ...refTables.map((t) => fetchAllRows(t, token)),
      ]);
      setRows(list);
      setRefData(Object.fromEntries(refTables.map((t, i) => [t, refs[i]])));
    } catch (err) {
      setRows((prev) => prev || []);
      handleError(err, setError);
    }
  }, [cfg, table, token, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  const rowKey = (row) => cfg.pk.map((k) => row[k]).join("-");

  const submit = async (payload) => {
    const mode = form.mode;
    const row = form.row;
    setBusy(true);
    setFormError("");
    try {
      if (mode === "create") {
        await request(`/${table}`, { token, method: "POST", body: payload });
      } else {
        await request(`/${table}/${pkPath(cfg, row)}`, { token, method: "PUT", body: payload });
      }
      setForm(null);
      setNotice(mode === "create" ? `Added ${cfg.singular}.` : "Changes saved.");
      await load();
    } catch (err) {
      handleError(err, setFormError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/${table}/${pkPath(cfg, row)}`, { token, method: "DELETE" });
      setConfirmKey(null);
      setNotice(`Deleted ${cfg.singular}.`);
      await load();
    } catch (err) {
      setConfirmKey(null);
      handleError(err, setError);
    } finally {
      setBusy(false);
    }
  };

  const openForm = (next) => {
    setNotice("");
    setFormError("");
    setConfirmKey(null);
    setForm(next);
  };

  const needle = search.trim().toLowerCase();
  const visible = (rows || []).filter(
    (row) =>
      !needle ||
      cfg.list.some((name) =>
        cellText(getDef(cfg, name), row[name], refData).toLowerCase().includes(needle)
      )
  );

  return (
    <div>
      <div className="ad-page-head">
        <div>
          <h2>{cfg.label}</h2>
          <p className="ad-muted">
            {rows === null ? "Loading…" : `${rows.length} record${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="ad-page-tools">
          <input
            className="ad-input ad-search"
            type="search"
            placeholder="Search this list"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="ad-btn ad-btn-primary" onClick={() => openForm({ mode: "create" })}>
            ＋ Add {cfg.singular}
          </button>
        </div>
      </div>

      {notice && <div className="ad-banner ad-banner-ok">{notice}</div>}
      {error && (
        <div className="ad-banner ad-banner-error">
          {error}{" "}
          <button className="ad-link" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {form && (
        <RecordForm
          key={form.mode + (form.row ? rowKey(form.row) : "")}
          cfg={cfg}
          mode={form.mode}
          row={form.row}
          refData={refData}
          busy={busy}
          error={formError}
          onSubmit={submit}
          onCancel={() => setForm(null)}
        />
      )}

      <div className="ad-card ad-table-card">
        <div className="ad-table-scroll">
          <table className="ad-table">
            <thead>
              <tr>
                {cfg.list.map((name) => (
                  <th key={name}>{getDef(cfg, name).label}</th>
                ))}
                <th className="ad-actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr>
                  <td colSpan={cfg.list.length + 1} className="ad-empty">
                    Loading…
                  </td>
                </tr>
              )}
              {rows !== null && visible.length === 0 && (
                <tr>
                  <td colSpan={cfg.list.length + 1} className="ad-empty">
                    {needle ? "Nothing matches your search." : `No ${cfg.label.toLowerCase()} yet.`}
                  </td>
                </tr>
              )}
              {visible.map((row) => {
                const key = rowKey(row);
                return (
                  <tr key={key}>
                    {cfg.list.map((name) => {
                      const text = cellText(getDef(cfg, name), row[name], refData);
                      return (
                        <td key={name} title={text} className="ad-cell">
                          {text || <span className="ad-muted">—</span>}
                        </td>
                      );
                    })}
                    <td className="ad-actions-col">
                      {confirmKey === key ? (
                        <span className="ad-confirm">
                          Delete?{" "}
                          <button
                            className="ad-btn ad-btn-danger ad-btn-sm"
                            disabled={busy}
                            onClick={() => remove(row)}
                          >
                            Yes, delete
                          </button>{" "}
                          <button
                            className="ad-btn ad-btn-outline ad-btn-sm"
                            onClick={() => setConfirmKey(null)}
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <>
                          <button
                            className="ad-btn ad-btn-outline ad-btn-sm"
                            onClick={() => openForm({ mode: "edit", row })}
                          >
                            Edit
                          </button>{" "}
                          <button
                            className="ad-btn ad-btn-outline-danger ad-btn-sm"
                            onClick={() => {
                              setNotice("");
                              setConfirmKey(key);
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================================================================ */
/* Root of the admin area                                             */
/* ================================================================ */
export default function AdminDashboard() {
  const [session, setSession] = useState(loadSession);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("issues");

  useEffect(() => {
    const previous = document.title;
    document.title = "CIVIX Admin";
    return () => {
      document.title = previous;
    };
  }, []);

  const handleLogin = (s) => {
    saveSession(s);
    setNotice("");
    setSession(s);
  };

  const handleLogout = async () => {
    if (session) {
      try {
        await request("/admin/logout", { token: session.token, method: "POST" });
      } catch {
        /* the token is discarded locally either way */
      }
    }
    saveSession(null);
    setNotice("");
    setSession(null);
  };

  const handleExpired = useCallback(() => {
    saveSession(null);
    setNotice("Your admin session expired. Please sign in again.");
    setSession(null);
  }, []);

  return (
    <div className="ad-root">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <style>{ADMIN_STYLES}</style>

      {!session ? (
        <AdminLogin onLogin={handleLogin} notice={notice} />
      ) : (
        <div className="ad-shell">
          <aside className="ad-side">
            <div className="ad-wordmark ad-wordmark-light">
              <span className="ad-dot"></span>CIVIX <span className="ad-tag">admin</span>
            </div>
            <nav className="ad-nav">
              {Object.entries(TABLES).map(([name, cfg]) => (
                <button
                  key={name}
                  className={"ad-nav-btn" + (tab === name ? " active" : "")}
                  onClick={() => setTab(name)}
                >
                  {cfg.label}
                </button>
              ))}
            </nav>
            <button className="ad-btn ad-btn-outline-light ad-signout" onClick={handleLogout}>
              Sign out
            </button>
          </aside>

          <main className="ad-main">
            <TablePanel key={tab} table={tab} token={session.token} onExpired={handleExpired} />
          </main>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Styles — same palette and fonts as the CIVIX app                  */
/* ---------------------------------------------------------------- */
const ADMIN_STYLES = `
  html,body{margin:0;padding:0;background:#F4F0E6;}
  .ad-root{
    --ink:#182A3A; --ink-2:#22384C; --paper:#F4F0E6; --paper-2:#EAE3D2;
    --signal:#E7A33B; --signal-dark:#B87A1F; --moss:#3F7A5B; --brick:#C1502E;
    --line:#D9D1BE; --muted:#5E6A72; --white:#FFFFFF;
    min-height:100vh;background:var(--paper);color:var(--ink);
    font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased;
    font-size:14px;
  }
  .ad-root *{box-sizing:border-box;}
  .ad-root h1,.ad-root h2,.ad-root h3{font-family:'Fraunces',serif;font-weight:600;letter-spacing:-0.01em;margin:0;}
  .ad-root p{margin:0;}
  .ad-root button{font-family:inherit;cursor:pointer;}
  .ad-muted{color:var(--muted);}

  .ad-wordmark{font-family:'Fraunces',serif;font-weight:700;font-size:22px;display:flex;align-items:center;gap:8px;}
  .ad-wordmark-light{color:var(--white);}
  .ad-dot{width:12px;height:12px;border-radius:50%;background:var(--signal);display:inline-block;}
  .ad-tag{font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--signal);margin-left:2px;}

  /* login */
  .ad-login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .ad-login{width:100%;max-width:380px;background:var(--white);border:1px solid var(--line);border-radius:10px;padding:32px 28px;display:flex;flex-direction:column;gap:6px;}
  .ad-login h1{font-size:26px;margin-top:18px;}
  .ad-login .ad-label{margin-top:16px;}
  .ad-login .ad-btn{margin-top:18px;}

  /* layout */
  .ad-shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh;}
  .ad-side{background:var(--ink);padding:22px 14px;display:flex;flex-direction:column;gap:18px;position:sticky;top:0;height:100vh;overflow-y:auto;}
  .ad-nav{display:flex;flex-direction:column;gap:2px;flex:1;}
  .ad-nav-btn{background:none;border:none;text-align:left;color:#C9D2DC;padding:9px 12px;border-radius:6px;font-size:14px;font-weight:500;}
  .ad-nav-btn:hover{background:var(--ink-2);color:var(--white);}
  .ad-nav-btn.active{background:var(--signal);color:var(--ink);font-weight:600;}
  .ad-main{padding:28px 32px 48px;min-width:0;}

  .ad-page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:18px;}
  .ad-page-head h2{font-size:28px;}
  .ad-page-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
  .ad-search{width:220px;}

  /* cards + tables */
  .ad-card{background:var(--white);border:1px solid var(--line);border-radius:10px;}
  .ad-table-card{overflow:hidden;}
  .ad-table-scroll{overflow-x:auto;}
  .ad-table{width:100%;border-collapse:collapse;font-size:13.5px;}
  .ad-table th{text-align:left;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:12px 14px;background:var(--paper-2);border-bottom:1px solid var(--line);white-space:nowrap;}
  .ad-table td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle;}
  .ad-table tbody tr:last-child td{border-bottom:none;}
  .ad-table tbody tr:hover{background:#FBF9F3;}
  .ad-cell{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .ad-actions-col{white-space:nowrap;text-align:right;}
  .ad-empty{text-align:center;color:var(--muted);padding:28px 14px !important;}
  .ad-confirm{font-size:13px;color:var(--brick);font-weight:600;}

  /* forms */
  .ad-form{padding:20px 22px;margin-bottom:18px;}
  .ad-form-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
  .ad-form-head h3{font-size:20px;}
  .ad-form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px 18px;}
  .ad-field.wide{grid-column:1 / -1;}
  .ad-label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;}
  .ad-input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:4px;background:var(--white);font-family:inherit;font-size:14px;color:var(--ink);}
  .ad-input:focus{outline:2px solid var(--signal);outline-offset:1px;border-color:var(--signal);}
  textarea.ad-input{resize:vertical;}
  .ad-hint{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.4;}
  .ad-check{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;padding-top:24px;}
  .ad-form-actions{display:flex;gap:10px;margin-top:20px;}

  /* buttons */
  .ad-btn{display:inline-flex;align-items:center;justify-content:center;border:1.5px solid transparent;border-radius:4px;padding:10px 16px;font-size:14px;font-weight:600;line-height:1.2;}
  .ad-btn:disabled{opacity:.6;cursor:default;}
  .ad-btn-block{width:100%;}
  .ad-btn-sm{padding:6px 11px;font-size:12.5px;}
  .ad-btn-primary{background:var(--signal);color:var(--ink);}
  .ad-btn-primary:hover:not(:disabled){background:var(--signal-dark);}
  .ad-btn-outline{border-color:var(--ink);color:var(--ink);background:transparent;}
  .ad-btn-outline:hover{background:var(--ink);color:var(--white);}
  .ad-btn-outline-danger{border-color:var(--brick);color:var(--brick);background:transparent;}
  .ad-btn-outline-danger:hover{background:var(--brick);color:var(--white);}
  .ad-btn-danger{background:var(--brick);color:var(--white);}
  .ad-btn-outline-light{border-color:rgba(255,255,255,.4);color:var(--white);background:transparent;}
  .ad-btn-outline-light:hover{background:rgba(255,255,255,.12);}
  .ad-btn-ghost{background:none;color:var(--muted);padding:6px 10px;}
  .ad-btn-ghost:hover{color:var(--ink);}
  .ad-link{background:none;border:none;padding:0;font:inherit;font-weight:600;color:inherit;text-decoration:underline;}

  /* banners */
  .ad-banner{padding:11px 14px;border-radius:4px;font-size:13px;margin:0 0 14px;line-height:1.45;}
  .ad-form .ad-banner{margin:16px 0 0;}
  .ad-banner-ok{background:#DDEBE2;border:1px solid #B7D3C2;color:#2E5C44;}
  .ad-banner-error{background:#F3DAD1;border:1px solid #EBB5A4;color:#8C3A22;}
  .ad-banner-warn{background:#F7E8C8;border:1px solid #E7CD93;color:#7A5410;margin-top:14px;}
  .ad-login .ad-banner{margin:14px 0 0;}

  @media (max-width:820px){
    .ad-shell{grid-template-columns:1fr;}
    .ad-side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;padding:14px;}
    .ad-nav{flex-direction:row;flex-wrap:wrap;flex:1 1 100%;order:3;}
    .ad-nav-btn{padding:7px 10px;font-size:13px;}
    .ad-signout{margin-left:auto;}
    .ad-main{padding:20px 14px 40px;}
    .ad-search{width:100%;}
  }
`;
