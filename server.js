// Little French House — menu editor server.
//
// This tool uses the Supabase SERVICE-ROLE key to read/write the menu tables.
// That key bypasses Row Level Security, so the server itself is the gatekeeper:
//   • Run it on your own machine and it stays open (no password) — convenient.
//   • Deploy it to a public host (e.g. Vercel) and you MUST set an EDITOR_PASSWORD
//     env var; the server then locks every request behind that password. Without
//     a password set, a public URL would be an open door to your database.
// The key stays in this Node process; the browser UI only ever talks to this
// server, never to Supabase directly.
//
// Secrets come from environment variables (how Vercel supplies them), falling
// back to the project's ../.env.local file for local development.
//
// Run:  npm run dev      (or node server.js / START.BAT)  →  http://localhost:4001

// These four lines pull in the tools we need:
//  - express: the tiny web-server framework that answers browser requests
//  - fs: lets us read files from disk (we use it to read ../.env.local)
//  - path: builds file paths that work on any OS (Windows/Mac/Linux)
//  - createClient: opens a connection to the Supabase database
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// --- load secrets (environment variables, with a local file fallback) ---
// On a hosted server like Vercel, secrets arrive as real environment variables
// (process.env). On your own machine they usually live in ../.env.local. This
// function returns a single object that prefers real env vars and fills any
// gaps from the file, so the SAME code works in both places.
function loadEnv() {
  const out = {};
  // 1) Start with the real environment variables (this is what Vercel sets).
  Object.assign(out, process.env);
  // 2) For local development, read ../.env.local too — but only fill in keys
  //    that aren't already set, so a real env var always wins.
  const file = path.join(__dirname, "..", ".env.local");
  if (fs.existsSync(file)) {
    // Walk through every line of the file. The regex picks out the part before
    // the "=" (the name) and the part after it (the value).
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && out[m[1]] === undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); // strip surrounding quotes
    }
  }
  return out;
}

// Read the secrets, then grab the values we care about: the database address,
// the all-powerful "service-role" key, and the optional public-deploy password.
const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const EDITOR_PASSWORD = env.EDITOR_PASSWORD; // when set, locks the whole editor (see auth below)

// If either secret is missing, there's no point continuing — stop with a hint.
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("\n  ✗ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (set them as env vars or in ../.env.local)\n");
  process.exit(1);
}

// Open the database connection. We use the service-role key, which can read and
// write everything (no login required) — fine here because this only runs on
// your own machine. persistSession:false means "don't try to remember a logged-in user."
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Create the web server and configure it:
const app = express();
app.use(express.json({ limit: "20mb" }));        // understand JSON request bodies (up to 20 MB, for big images)

// --- password lock (only active when EDITOR_PASSWORD is set) ---
// This is what makes the editor safe to put on a public URL. If EDITOR_PASSWORD
// is set (you'd set it on Vercel), every request must carry that password via
// the browser's built-in login popup (HTTP Basic Auth). The username is ignored;
// only the password is checked. If EDITOR_PASSWORD is NOT set (typical on your
// own machine), this whole block is skipped and the editor stays open as before.
if (EDITOR_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      // "Basic" auth sends "username:password" base64-encoded. Decode it and
      // take everything after the first ":" as the password.
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (password === EDITOR_PASSWORD) return next(); // correct password → let them through
    }
    // No/!wrong password → ask the browser to show its login popup.
    res.set("WWW-Authenticate", 'Basic realm="Menu editor"');
    res.status(401).send("Authentication required.");
  });
}

app.use(express.static(path.join(__dirname, "ui"))); // serve the browser UI files in the /ui folder

// Wrap async handlers so thrown errors become clean 500s instead of crashes.
// "wrap" is a safety net: it runs an endpoint, and if anything goes wrong it
// catches the error and sends back a tidy "500" error message instead of letting
// the whole server fall over. Every route below is wrapped in this.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error("API error:", e.message);
    res.status(500).json({ error: e.message });
  });

// Every Supabase reply comes back as { data, error }. "must" unwraps that:
// if there was an error it throws (so "wrap" above turns it into a 500),
// otherwise it hands back just the data we asked for.
const must = (r) => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

// --- read everything for the initial load ---
// This endpoint returns ALL the menu data the editor needs the moment it opens:
// dishes, categories, filters and the site settings — in a single response.
app.get("/api/all", wrap(async (_req, res) => {
  // Promise.all fires all four database reads at once and waits for them
  // together (faster than asking one at a time). Each ".from(table).select('*')"
  // means "give me every column from this table", ordered by sort_order.
  const [items, categories, filters, settings] = await Promise.all([
    supabase.from("menu_items").select("*").order("sort_order"),
    supabase.from("categories").select("*").order("sort_order"),
    supabase.from("filters").select("*").order("sort_order"),
    supabase.from("settings").select("*").eq("id", "site").maybeSingle(), // just the single "site" settings row
  ]);
  res.json({
    items: must(items),
    categories: must(categories),
    filters: must(filters),
    settings: must(settings) || { id: "site", bubbles_enabled: true, service_mode: false },
  });
}));

// --- read recent orders (service role bypasses the public-insert-only RLS) ---
app.get("/api/orders", wrap(async (_req, res) => {
  const data = must(
    await supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(200)
  );
  res.json(data);
}));

// --- advance an order's status (received -> preparing -> served, or cancelled) ---
// PATCH means "change part of an existing record". The browser tells us which
// order (the :id in the URL) and what to change (status, payment, archived).
const ORDER_STATUSES = ["received", "preparing", "served", "cancelled"];
app.patch("/api/orders/:id", wrap(async (req, res) => {
  const body = req.body || {};
  // "patch" collects only the fields the browser actually wants to change, so we
  // never accidentally overwrite anything it didn't mention.
  const patch = {};
  if (body.status !== undefined) {
    if (!ORDER_STATUSES.includes(body.status)) return res.status(400).json({ error: "invalid status" });
    patch.status = body.status;
  }
  if (body.payment_status !== undefined) {
    if (!["pending", "paid"].includes(body.payment_status)) return res.status(400).json({ error: "invalid payment_status" });
    patch.payment_status = body.payment_status;
  }
  if (body.archived !== undefined) patch.archived = body.archived === true;
  if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing to update" });
  const data = must(
    await supabase.from("orders").update(patch).eq("id", req.params.id).select()
  );
  res.json(data[0] || null);
}));

// --- delete orders (single, bulk, or clear-all) so the list doesn't grow forever ---
app.delete("/api/orders/:id", wrap(async (req, res) => {
  must(await supabase.from("orders").delete().eq("id", req.params.id));
  res.json({ ok: true });
}));
app.post("/api/orders/delete", wrap(async (req, res) => {
  const { ids, all } = req.body || {};
  if (all) {
    must(await supabase.from("orders").delete().neq("id", "00000000-0000-0000-0000-000000000000"));
  } else if (Array.isArray(ids) && ids.length) {
    must(await supabase.from("orders").delete().in("id", ids));
  } else {
    return res.status(400).json({ error: "no ids" });
  }
  res.json({ ok: true });
}));

// --- waiter calls: read recent, mark resolved, delete ---
app.get("/api/calls", wrap(async (_req, res) => {
  const data = must(
    await supabase.from("waiter_calls").select("*").order("created_at", { ascending: false }).limit(100)
  );
  res.json(data);
}));
app.patch("/api/calls/:id", wrap(async (req, res) => {
  const data = must(
    await supabase.from("waiter_calls").update({ resolved: req.body?.resolved === true }).eq("id", req.params.id).select()
  );
  res.json(data[0] || null);
}));
app.delete("/api/calls/:id", wrap(async (req, res) => {
  must(await supabase.from("waiter_calls").delete().eq("id", req.params.id));
  res.json({ ok: true });
}));

// ── v2 dining sessions: live board + staff actions ─────────────────────────
// These power the editor's Sessions tab. The service-role client bypasses RLS,
// so the editor can read/write the locked session tables directly (guests never
// touch them — they go through the lfh_* RPCs). Registered BEFORE the generic
// /api/:kind routes so single-segment paths like /api/blocklist resolve here and
// not to the catch-all.
const nowIso = () => new Date().toISOString();

// One payload for the whole board: active sessions + their members & items, the
// pending request queue, and the blocklist.
app.get("/api/sessions", wrap(async (_req, res) => {
  const sessions = must(
    await supabase.from("sessions").select("*").neq("status", "closed").order("last_activity_at", { ascending: false })
  );
  const ids = sessions.map((s) => s.id);
  const [members, items, requests, blocklist] = await Promise.all([
    ids.length ? supabase.from("session_members").select("*").in("session_id", ids).eq("removed", false).order("joined_at") : Promise.resolve({ data: [] }),
    ids.length ? supabase.from("order_items").select("*").in("session_id", ids).order("created_at") : Promise.resolve({ data: [] }),
    supabase.from("requests").select("*").eq("status", "pending").order("created_at"),
    supabase.from("blocklist").select("*").order("blocked_at", { ascending: false }),
  ]);
  res.json({
    sessions,
    members: must(members) || [],
    items: must(items) || [],
    requests: must(requests) || [],
    blocklist: must(blocklist) || [],
  });
}));

// Open (or re-open) a table's session.
app.post("/api/sessions/open", wrap(async (req, res) => {
  const table = String((req.body && req.body.table) || "").trim();
  if (!table) return res.status(400).json({ error: "table required" });
  // Reject tables outside 1..table_count (the floor only has that many).
  const num = Number(table);
  if (!/^\d+$/.test(table) || num < 1) return res.status(400).json({ error: "invalid table number" });
  const setRow = await supabase.from("settings").select("table_count").eq("id", "site").maybeSingle();
  const maxTables = setRow.data && setRow.data.table_count ? Number(setRow.data.table_count) : 0;
  if (maxTables > 0 && num > maxTables) return res.status(400).json({ error: `Table ${num} doesn't exist — tables are 1–${maxTables}.` });
  const existing = must(await supabase.from("sessions").select("*").eq("table_number", table).neq("status", "closed").limit(1));
  let row;
  if (existing.length) {
    row = must(await supabase.from("sessions").update({ status: "open", opened_by: "waiter", opened_at: existing[0].opened_at || nowIso(), last_activity_at: nowIso() }).eq("id", existing[0].id).select())[0];
  } else {
    row = must(await supabase.from("sessions").insert({ table_number: table, status: "open", opened_by: "waiter", opened_at: nowIso() }).select())[0];
  }
  // Opening the table answers any pending "let me in" requests for it, so the
  // floor tile stops flagging it.
  await supabase.from("requests").update({ status: "approved" }).eq("table_number", table).eq("status", "pending");
  res.json(row || null);
}));

// Close a session (end the meal).
app.post("/api/sessions/:id/close", wrap(async (req, res) => {
  const row = must(await supabase.from("sessions").update({ status: "closed", closed_at: nowIso() }).eq("id", req.params.id).select());
  res.json(row[0] || null);
}));

// Flip auto-approve for a session.
app.post("/api/sessions/:id/auto-approve", wrap(async (req, res) => {
  const value = !!(req.body && req.body.value === true);
  const row = must(await supabase.from("sessions").update({ auto_approve: value }).eq("id", req.params.id).select());
  res.json(row[0] || null);
}));

// Approve / remove a member.
app.post("/api/members/:id/approve", wrap(async (req, res) => {
  const row = must(await supabase.from("session_members").update({ approved: true }).eq("id", req.params.id).select());
  res.json(row[0] || null);
}));
app.post("/api/members/:id/remove", wrap(async (req, res) => {
  const row = must(await supabase.from("session_members").update({ removed: true }).eq("id", req.params.id).select());
  res.json(row[0] || null);
}));

// Advance one item's kitchen status (received -> preparing -> served).
app.post("/api/items/:id/status", wrap(async (req, res) => {
  const status = req.body && req.body.status;
  if (!["received", "preparing", "served"].includes(status)) return res.status(400).json({ error: "invalid status" });
  const patch = { status };
  if (status === "served") patch.served_at = nowIso();
  const row = must(await supabase.from("order_items").update(patch).eq("id", req.params.id).select());
  res.json(row[0] || null);
}));

// Accept a WHOLE order: jump it straight to "preparing" (single accept+prepare step).
// Sets the order row, every item in its JSON, AND any order_items rows — so it works for
// session orders and legacy orders alike. Per-item "served" taps happen after this.
app.post("/api/orders/:id/accept", wrap(async (req, res) => {
  const cur = must(await supabase.from("orders").select("items").eq("id", req.params.id).single());
  const items = Array.isArray(cur.items) ? cur.items.map((i) => ({ ...i, status: i.status === "served" ? "served" : "preparing" })) : [];
  must(await supabase.from("orders").update({ items, status: "preparing" }).eq("id", req.params.id).select());
  await supabase.from("order_items").update({ status: "preparing" }).eq("order_id", req.params.id).eq("status", "received");
  const row = must(await supabase.from("orders").select("*").eq("id", req.params.id).single());
  res.json(row || null);
}));

// Serve EVERYTHING on an order at once → order complete (the "all items served" shortcut).
app.post("/api/orders/:id/serve-all", wrap(async (req, res) => {
  const cur = must(await supabase.from("orders").select("items").eq("id", req.params.id).single());
  const items = Array.isArray(cur.items) ? cur.items.map((i) => ({ ...i, status: "served" })) : [];
  must(await supabase.from("orders").update({ items, status: "served" }).eq("id", req.params.id).select());
  await supabase.from("order_items").update({ status: "served", served_at: nowIso() }).eq("order_id", req.params.id).neq("status", "served");
  const row = must(await supabase.from("orders").select("*").eq("id", req.params.id).single());
  res.json(row || null);
}));

// Advance ONE item inside a legacy order's items JSON (orders that have no order_items rows).
// Also derives the order's overall status so the guest's order-level tracker keeps updating.
app.post("/api/orders/:id/item", wrap(async (req, res) => {
  const idx = Number(req.body && req.body.index);
  const status = req.body && req.body.status;
  if (!["received", "preparing", "served"].includes(status)) return res.status(400).json({ error: "invalid status" });
  const cur = must(await supabase.from("orders").select("items").eq("id", req.params.id).single());
  const items = Array.isArray(cur.items) ? cur.items : [];
  if (!items[idx]) return res.status(400).json({ error: "bad item index" });
  items[idx] = { ...items[idx], status };
  const servedCount = items.filter((i) => i.status === "served").length;
  const orderStatus = servedCount === items.length ? "served"
    : items.some((i) => i.status === "preparing" || i.status === "served") ? "preparing" : "received";
  const row = must(await supabase.from("orders").update({ items, status: orderStatus }).eq("id", req.params.id).select());
  res.json(row[0] || null);
}));

// Resolve a queued request. Approving an "open" request opens that table.
app.post("/api/requests/:id/resolve", wrap(async (req, res) => {
  const status = req.body && req.body.status;
  if (!["approved", "denied"].includes(status)) return res.status(400).json({ error: "invalid status" });
  const reqRow = must(await supabase.from("requests").update({ status }).eq("id", req.params.id).select())[0];
  if (status === "approved" && reqRow && reqRow.type === "open") {
    const existing = must(await supabase.from("sessions").select("id").eq("table_number", reqRow.table_number).neq("status", "closed").limit(1));
    if (!existing.length) must(await supabase.from("sessions").insert({ table_number: reqRow.table_number, status: "open", opened_by: "waiter", opened_at: nowIso() }));
  }
  res.json(reqRow || null);
}));

// Block a phone and/or table; mirror to customers.blocked so the RPC guard catches it.
app.post("/api/blocklist", wrap(async (req, res) => {
  const b = req.body || {};
  const phone = b.phone ? String(b.phone).trim() : null;
  const table = b.table ? String(b.table).trim() : null;
  if (!phone && !table && !b.member_id) return res.status(400).json({ error: "phone, table, or member_id required" });
  const row = must(await supabase.from("blocklist").insert({ phone, table_number: table, member_id: b.member_id || null, reason: b.reason || null }).select())[0];
  if (phone) await supabase.from("customers").upsert({ phone, blocked: true }, { onConflict: "phone" });
  res.json(row || null);
}));

// Unblock: delete the row, and clear customers.blocked if nothing else blocks that phone.
app.delete("/api/blocklist/:id", wrap(async (req, res) => {
  const existing = must(await supabase.from("blocklist").select("*").eq("id", req.params.id).limit(1));
  must(await supabase.from("blocklist").delete().eq("id", req.params.id));
  const phone = existing[0] && existing[0].phone;
  if (phone) {
    const others = must(await supabase.from("blocklist").select("id").eq("phone", phone).limit(1));
    if (!others.length) await supabase.from("customers").update({ blocked: false }).eq("phone", phone);
  }
  res.json({ ok: true });
}));

// ── Users / Log: recent guests (with their table), known customers, the blocklist ──
app.get("/api/users", wrap(async (_req, res) => {
  const members = must(
    await supabase.from("session_members")
      .select("id, name, phone, phone_verified, role, approved, removed, location_ok, joined_at, session:sessions(table_number, status)")
      .order("joined_at", { ascending: false }).limit(120)
  );
  const customers = must(await supabase.from("customers").select("*").order("last_seen_at", { ascending: false }).limit(120));
  const blocklist = must(await supabase.from("blocklist").select("*").order("blocked_at", { ascending: false }));
  // Per-member activity so the Log can show what each guest DID (ordered vs only
  // called a waiter). Both tables carry member_id; the UI aggregates by it.
  const orders = must(await supabase.from("orders").select("member_id, total, created_at").not("member_id", "is", null).order("created_at", { ascending: false }).limit(400));
  const calls = must(await supabase.from("waiter_calls").select("member_id, note, created_at").not("member_id", "is", null).order("created_at", { ascending: false }).limit(400));
  res.json({ members, customers, blocklist, orders, calls });
}));

// --- generic CRUD for the three tables ---
// table config: which Supabase table + which column is the unique key
const TABLES = {
  items: { name: "menu_items", key: "id" },
  categories: { name: "categories", key: "slug" },
  filters: { name: "filters", key: "slug" },
  settings: { name: "settings", key: "id" },
};

// Create or update a row (upsert on the table's unique key).
app.post("/api/:kind", wrap(async (req, res) => {
  const t = TABLES[req.params.kind];
  if (!t) return res.status(404).json({ error: "unknown kind" });
  // Settings guard: never trust the client (even though we're local). The
  // public app treats table_count <= 0 as "no limit", which would silently
  // switch OFF the out-of-range table check guests rely on — so clamp it to a
  // sane whole number, and pin the row id so we can't spawn orphan settings.
  if (req.params.kind === "settings" && req.body && typeof req.body === "object") {
    req.body.id = "site";
    if ("table_count" in req.body) {
      const n = Math.round(Number(req.body.table_count));
      req.body.table_count = Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 12;
    }
    // v2 session settings: coerce to the right types so a blank/odd value can't
    // poison the public app's gating.
    for (const b of ["sessions_enabled", "require_location", "require_otp"]) {
      if (b in req.body) req.body[b] = req.body[b] === true || req.body[b] === "true";
    }
    for (const g of ["geo_lat", "geo_lng"]) {
      if (g in req.body) { const v = parseFloat(req.body[g]); req.body[g] = Number.isFinite(v) ? v : null; }
    }
    if ("geo_radius_m" in req.body) {
      const n = Math.round(Number(req.body.geo_radius_m));
      req.body.geo_radius_m = Number.isFinite(n) ? Math.min(Math.max(n, 20), 5000) : 250;
    }
  }
  // "upsert" = insert if it's new, or update if a row with that key already
  // exists. onConflict tells Supabase which column decides "same row".
  const data = must(
    await supabase.from(t.name).upsert(req.body, { onConflict: t.key }).select()
  );
  res.json(data[0]);
}));

// Delete a row by its key value.
app.delete("/api/:kind/:id", wrap(async (req, res) => {
  const t = TABLES[req.params.kind];
  if (!t) return res.status(404).json({ error: "unknown kind" });
  must(await supabase.from(t.name).delete().eq(t.key, req.params.id));
  res.json({ ok: true });
}));

// Start listening for requests — but ONLY when this file is run directly
// (e.g. `node server.js`, `npm run dev`, START.BAT). On Vercel the platform
// imports this file as a serverless function and calls the app itself, so we
// must NOT open a long-running listener there.
const PORT = process.env.PORT || 4001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("");
    console.log(`  🍽️  Menu editor running at http://localhost:${PORT}`);
    console.log(`     Connected to ${SUPABASE_URL}`);
    console.log(`     ${EDITOR_PASSWORD ? "🔒 password lock ON" : "🔓 open (no password — fine for local use)"}`);
    console.log("");
  });
}

// Export the configured Express app so a serverless host (Vercel) can use it.
module.exports = app;
