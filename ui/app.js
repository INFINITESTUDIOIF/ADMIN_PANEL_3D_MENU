// Menu editor — talks only to the local server (which holds the service-role key).
//
// This is the WHOLE browser side of the editor. It builds every screen by
// generating HTML text and dropping it into the page, listens for clicks, and
// calls the local server (server.js) to read/write the database. There is no
// framework here — just plain JavaScript, so a beginner can follow it top to bottom.

// The six languages every dish/category/filter name can be translated into.
// Each entry is [code, human-readable label].
const LANGS = [
  ["en", "English"], ["de", "German"], ["fr", "French"],
  ["ar", "Arabic"], ["hi", "Hindi"], ["ko", "Korean"],
];
// keep in sync with lib/allergens.ts
const ALLERGENS = [
  { slug: "gluten", label: "🌾 Gluten" },
  { slug: "dairy", label: "🥛 Dairy" },
  { slug: "eggs", label: "🥚 Eggs" },
  { slug: "nuts", label: "🥜 Nuts" },
  { slug: "soy", label: "🫘 Soy" },
  { slug: "fish", label: "🐟 Fish" },
];
// Friendly singular names for each tab, used in headings like "New Dish".
const TAB_LABEL = { items: "Dish", categories: "Category", filters: "Tag", general: "Settings" };

// The tabs across the top of the editor. Anything not in this list is ignored.
const VALID_TABS = ["items", "categories", "filters", "orders", "tables", "log", "general"];
// Remember which tab you were on so a refresh keeps you there (e.g. stay on
// Orders during a busy service instead of snapping back to Dishes).
const savedTab = (() => { try { return localStorage.getItem("lfh_editor_tab"); } catch { return null; } })();
// "state" is the editor's single source of truth — one object holding everything
// the screen needs: which tab is open, the data loaded from the server, the record
// currently being edited, the search text, and the live tables board. Whenever
// state changes we re-draw the affected part of the screen from it.
const state = {
  tab: savedTab === "sessions" ? "tables" : (VALID_TABS.includes(savedTab) ? savedTab : "items"), // "sessions" merged into "tables"
  data: { items: [], categories: [], filters: [], orders: [], calls: [], settings: { id: "site", bubbles_enabled: true, service_mode: false } },
  sel: null,      // working copy of the record being edited
  isNew: false,
  search: "",
  catFilter: "", // Dishes tab: selected category slug to filter by ("" = All)
  board: { sessions: [], members: [], items: [], requests: [], blocklist: [] }, // v2 sessions live board
  boardLoaded: false, // false until the live board arrives once → drives the floor skeleton (no "all Free" flash on load)
  openSess: null, // table number whose session modal is open
  ordersView: "live", // Orders tab left-bar selection: live | previous | bills | calls
  users: { members: [], customers: [], blocklist: [] }, // Log tab data
};

// ---------- tiny helpers ----------
// $  : shorthand for "find the first element matching this CSS selector".
const $ = (s, r = document) => r.querySelector(s);
// clone: make a deep, independent copy of an object (so editing the copy never
// changes the original until we deliberately save). structuredClone is the
// browser's native deep copy — much faster than the old JSON round-trip,
// which added real lag when opening big dishes.
const clone = (o) => (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
// esc: make text safe to drop into HTML. It turns characters like < > & " into
// their harmless codes so a dish name with a "<" can't break or hijack the page.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// inr: show a stored USD amount as Indian rupees, rounded to whole ₹.
// Orders store totals in USD (the menu's source-of-truth currency); the owner
// wants the editor to read in ₹ (2026-06-10). The rate mirrors CURRENCIES in
// the menu app's lib/format.ts — update both together when rates move.
const INR_RATE = 84;
const inr = (usd) => "₹" + Math.round((parseFloat(usd) || 0) * INR_RATE).toLocaleString("en-US");
// el: turn a string of HTML into a real, clickable page element we can insert.
const el = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

// setPath: store a value deep inside an object using a dotted "address" like
// "nutrition.calories" or "options.0.choices.1.label". It walks down each step,
// creating empty objects/arrays as needed, then sets the final piece. This is how
// a single input box can edit a deeply-nested field by just naming its path.
function setPath(obj, path, val) {
  const ks = path.split(".");
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i];
    if (o[k] == null) o[k] = /^\d+$/.test(ks[i + 1]) ? [] : {};
    o = o[k];
  }
  o[ks[ks.length - 1]] = val;
}

// toast: pop a small message at the corner of the screen (green for success,
// red for an error) and hide it again after a couple of seconds. toastTimer
// remembers the pending "hide it" timer so a new toast resets the clock.
// Optionally takes an action button (e.g. { label: "UNDO", fn: ... }) and a
// custom lifetime in ms — the Gmail-style pattern for bulk actions: do the
// thing instantly, but give the owner a few seconds to take it back.
let toastTimer;
function toast(msg, type = "ok", action, ms) {
  const t = $("#toast");
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = action.label;
    // Clicking the action hides the toast first so it can't be clicked twice.
    b.onclick = () => { t.hidden = true; clearTimeout(toastTimer); action.fn(); };
    t.appendChild(b);
  }
  t.className = "toast " + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms || 2600);
}

// Pretty in-app confirm (replaces the ugly native window.confirm).
// It builds a little "Are you sure?" pop-up and returns a Promise that resolves
// to true (user clicked the confirm button) or false (cancel / Escape / click
// outside). Calling code does: if (await confirmDialog(...)) { ...do it... }.
function confirmDialog(message, confirmLabel = "Confirm", opts = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    // opts.floorwide marks confirms that hit EVERY table at once (Close all).
    // They get a deliberately different, scarier look so muscle-memory built on
    // the routine one-table popups doesn't click through this one blindly.
    wrap.className = "confirm-overlay" + (opts.floorwide ? " floorwide" : "");
    wrap.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-icon"><i class="fas fa-triangle-exclamation"></i></div>
        <div class="confirm-msg">${esc(message)}</div>
        <div class="confirm-actions">
          <button class="btn confirm-cancel">Cancel</button>
          <button class="btn danger confirm-ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("show")); // next frame: trigger the fade-in animation
    // "close" hides the dialog, removes it after the fade-out, and reports the
    // answer (true/false) back to whoever is awaiting this Promise.
    const close = (val) => {
      wrap.classList.remove("show");
      setTimeout(() => wrap.remove(), 200);
      resolve(val);
    };
    // Speed-click guard: the dialog pops up right under the pointer, so the
    // tail of a fast double-click lands ~100ms later on the backdrop (or even
    // on the Cancel/Confirm buttons). That used to silently cancel the dialog
    // — making it feel like the app asked "are you sure?" again and again —
    // or could instantly confirm something the owner never read. So every
    // click is ignored until the dialog has been on screen for 350ms (humans
    // need longer than that to read it anyway). Escape stays instant.
    const openedAt = Date.now();
    const settled = () => Date.now() - openedAt > 350;
    wrap.querySelector(".confirm-cancel").onclick = () => { if (settled()) close(false); };
    wrap.querySelector(".confirm-ok").onclick = () => { if (settled()) close(true); };
    wrap.onclick = (e) => { if (e.target === wrap && settled()) close(false); };
    document.addEventListener("keydown", function esc2(e) {
      if (e.key === "Escape") { close(false); document.removeEventListener("keydown", esc2); }
    });
  });
}

// api: the one helper every server call goes through. Give it the HTTP method
// ("GET"/"POST"/"PATCH"/"DELETE"), the path (e.g. "/orders"), and optionally a
// body object. It sends the request to our local server, reads back the JSON,
// and throws a clear error if the server reported a problem.
async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, // turn the body object into JSON text to send
  });
  const json = await res.json().catch(() => ({})); // read the reply; if it isn't JSON, fall back to {}
  if (!res.ok) throw new Error(json.error || res.statusText); // not OK? surface the server's error message
  return json;
}

// ---------- data + list ----------
// loadAll: fetch everything from the server in one go (the /all endpoint), store
// it in state.data, flip the little "connected" indicator green, then redraw the
// left-hand list. Called on startup and after every save.
async function loadAll() {
  state.data = await api("GET", "/all");
  $("#conn").textContent = "connected";
  $("#conn").className = "conn ok";
  renderList();
}

// records: the list of rows for whichever tab is currently open.
const records = () => state.data[state.tab] || [];
// recKey: the unique id of a row. Dishes/settings use "id"; everything else "slug".
const recKey = (r) => ((state.tab === "items" || state.tab === "general") ? r.id : r.slug);
// recLabel: the human-readable name to show for a row in the list.
const recLabel = (r) =>
  state.tab === "items"
    ? (r.title || r.slug || "(untitled)")
    : ((r.name && r.name.en) || r.slug || "(untitled)");

// nextSort: pick a sort_order for a brand-new row — one higher than the current
// highest, so new items land at the bottom of the list by default.
function nextSort() {
  const xs = records().map((r) => r.sort_order || 0);
  return (xs.length ? Math.max(...xs) : 0) + 1;
}

// renderList: draw the left-hand list of rows for the current tab. The special
// tabs (general/orders/tables) show a single fixed entry instead of a real list.
// renderCatFilter: the Dishes-tab category chips. Tap one to show only that
// category's dishes; "All" clears the filter. Hidden on every other tab.
function renderCatFilter() {
  const bar = $("#catFilter");
  if (!bar) return;
  if (state.tab !== "items") { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  const cats = state.data.categories || [];
  const chip = (slug, label, icon, active) =>
    `<button type="button" class="cat-chip ${active ? "active" : ""}" data-cat="${esc(slug)}">${icon ? `<i class="fas ${esc(icon)}"></i> ` : ""}<span>${esc(label)}</span></button>`;
  let html = chip("", "All", "fa-layer-group", !state.catFilter);
  html += cats.map((c) => chip(c.slug, (c.name && c.name.en) || c.slug, c.icon, state.catFilter === c.slug)).join("");
  bar.innerHTML = html;
  bar.querySelectorAll(".cat-chip").forEach((b) => (b.onclick = () => {
    state.catFilter = b.dataset.cat; // "" for All
    renderCatFilter(); // restyle the active chip
    renderList();      // re-filter the dish list
  }));
}

function renderList() {
  const ul = $("#list");
  ul.innerHTML = ""; // wipe the old list before drawing the new one
  if (state.tab === "general") {
    ul.appendChild(el(`<li class="list-item active"><div class="thumb"><i class="fas fa-gear"></i></div><div class="meta"><b>Site settings</b><small>general</small></div></li>`));
    return;
  }
  if (state.tab === "orders") {
    // The left column IS the order navigation now — Today / Previous / Calls —
    // instead of a single redundant "Orders / incoming" card. Clicking a row
    // switches which set of order cards shows in the main area on the right.
    const { today, previous, callCount } = ordersBuckets();
    const view = ordersViewKey();
    const mk = (key, icon, label, count) => {
      const li = el(`<li class="list-item${view === key ? " active" : ""}" data-orders-view="${key}">
        <div class="thumb">${icon}</div>
        <div class="meta"><b>${label}</b></div>
        ${count ? `<span class="ord-nav-count">${count}</span>` : ""}
      </li>`);
      li.onclick = () => {
        state.ordersView = key;
        renderList();   // re-highlight the chosen row
        renderEditor(); // redraw the order cards on the right
      };
      return li;
    };
    ul.appendChild(mk("today", '<i class="fas fa-circle" style="color:#7ec88a"></i>', "Today", today.length));
    ul.appendChild(mk("previous", '<i class="fas fa-receipt"></i>', "Previous", previous.length));
    ul.appendChild(mk("calls", "🔔", "Calls", callCount));
    return;
  }
  if (state.tab === "tables") {
    ul.appendChild(el(`<li class="list-item active"><div class="thumb"><i class="fas fa-chair"></i></div><div class="meta"><b>Floor map</b><small>live tables</small></div></li>`));
    return;
  }
  const q = state.search.toLowerCase();
  // On the Dishes tab, also narrow to the chosen category (if any).
  const catF = state.tab === "items" ? state.catFilter : "";
  records()
    // keep only dishes in the chosen category (Dishes tab; "" = All)
    .filter((r) => !catF || r.category === catF)
    // keep only rows that match the search box (search across the whole row's text)
    .filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q))
    .forEach((r) => {
      const active = state.sel && !state.isNew && recKey(r) === recKey(state.sel); // is this the row being edited?
      const hidden = state.tab !== "items" && r.active === false; // greyed-out "hidden from menu" rows
      // Build the little thumbnail on the left of each list row: a photo for
      // dishes, a coloured icon for categories, an emoji for filters.
      let thumb;
      if (state.tab === "items") {
        thumb = r.image
          ? `<div class="thumb" style="background-image:url('${esc(r.image)}')"></div>`
          : `<div class="thumb"><i class="fas fa-utensils"></i></div>`;
      } else if (state.tab === "categories") {
        thumb = `<div class="thumb" style="color:${esc(r.color || "#d4a574")}"><i class="fas ${esc(r.icon || "fa-tag")}"></i></div>`;
      } else {
        thumb = `<div class="thumb">${esc(r.icon || "🏷️")}</div>`;
      }
      const li = el(
        `<li class="list-item ${active ? "active" : ""} ${hidden ? "hidden-row" : ""}">
          ${thumb}
          <div class="meta">
            <b>${esc(recLabel(r))}${state.tab === "items" && r.dish_no != null ? ` <span class="dish-no">#${esc(String(r.dish_no))}</span>` : ""}${hidden ? '<span class="badge-off">hidden</span>' : ""}</b>
            <small>${esc(recKey(r) || "")}</small>
          </div>
        </li>`
      );
      li.onclick = () => {
        // INSTANT feedback: highlight this row right now, before any heavy
        // work, so the click never feels ignored (it used to take ~1s).
        ul.querySelectorAll(".list-item.active").forEach((x) => x.classList.remove("active"));
        li.classList.add("active");
        selectRecord(r); // then open it in the editor on the right
      };
      ul.appendChild(li);
    });
}

// ---------- select / new ----------
// blankName: an empty translations object, one empty string per language.
function blankName() {
  const o = {};
  LANGS.forEach(([c]) => (o[c] = ""));
  return o;
}
// blank: a fresh, empty record with sensible defaults for the given tab — what
// "+ New" starts you off with before you fill anything in.
function blank(tab) {
  if (tab === "items")
    return {
      id: "", slug: "", title: "", price: "", image: "",
      category: (state.data.categories[0] || {}).slug || "",
      veg: false, is4d: false, model_folder: "",
      model_small_url: "", model_optimized_url: "",
      description: "", long_description: "", rating: "", time: "", search_alias: "",
      nutrition: { calories: "", protein: "", carbs: "", sugar: "" },
      ingredients: [], reviews: [], tags: [], allergens: [], options: [],
      sort_order: nextSort(),
    };
  if (tab === "categories")
    return { slug: "", name: blankName(), icon: "fa-utensils", color: "#d4a574", sort_order: nextSort(), active: true };
  return { slug: "", name: blankName(), icon: "", sort_order: nextSort(), active: true };
}

// selectRecord: open an existing row for editing. We edit a CLONE so changes
// aren't saved to the real data until the user hits Save.
function selectRecord(r) {
  state.sel = clone(r);
  state.isNew = false;
  // No renderList() here: rebuilding the whole sidebar on every click was a
  // big part of the lag, and the click handler already moved the highlight.
  renderEditor();
}
// newRecord: start a fresh, blank row for the current tab.
function newRecord() {
  state.sel = blank(state.tab);
  state.isNew = true;
  renderList();
  renderEditor();
}

// ---------- field builders ----------
// These little helpers each return a chunk of HTML for one form control, so the
// big forms below can stay readable. The "path" they're given (e.g. "title" or
// "nutrition.calories") is stored on the input as data-path; when the user types,
// bindEditor() reads that path and uses setPath() to update state.sel.

// tf: a single-line text (or number) input field with a label.
function tf(label, path, val, opts = {}) {
  return `<div class="field ${opts.span ? "span-2" : ""}">
    <label>${esc(label)}</label>
    <input type="${opts.type || "text"}" data-path="${path}" value="${esc(val ?? "")}"
      ${opts.min != null ? `min="${opts.min}"` : ""} ${opts.max != null ? `max="${opts.max}"` : ""} ${opts.step != null ? `step="${opts.step}"` : ""}
      ${opts.disabled ? "disabled" : ""} placeholder="${esc(opts.ph || "")}" />
    ${opts.hint ? `<span class="hint">${esc(opts.hint)}</span>` : ""}
  </div>`;
}
// ta: a multi-line text area (for longer descriptions, review text, etc).
function ta(label, path, val, opts = {}) {
  return `<div class="field ${opts.span ? "span-2" : ""}">
    <label>${esc(label)}</label>
    <textarea data-path="${path}" placeholder="${esc(opts.ph || "")}">${esc(val ?? "")}</textarea>
  </div>`;
}
// toggle: an on/off switch (a styled checkbox), e.g. "Vegetarian" or "4D mode".
function toggle(label, path, val) {
  return `<label class="toggle"><input type="checkbox" data-path="${path}" ${val ? "checked" : ""}/>
    <span class="track"></span><span>${esc(label)}</span></label>`;
}
// lbl: a small standalone caption above a group of controls.
function lbl(text) {
  return `<label style="font-size:12px;color:var(--muted);font-weight:600;display:block;margin-bottom:8px">${esc(text)}</label>`;
}

// catSelect: a drop-down listing every category, used to pick a dish's category.
function catSelect(val) {
  const opts = state.data.categories
    .map((c) => `<option value="${esc(c.slug)}" ${c.slug === val ? "selected" : ""}>${esc((c.name && c.name.en) || c.slug)}</option>`)
    .join("");
  return `<div class="field"><label>Category</label>
    <select data-path="category"><option value="">—</option>${opts}</select></div>`;
}
// tagChips: a row of clickable "chips", one per filter tag. Chips the dish
// already has are highlighted ("on"); tapping one toggles it.
function tagChips(tags) {
  tags = tags || [];
  const chips = state.data.filters
    .map((f) => `<span class="chip ${tags.includes(f.slug) ? "on" : ""}" data-action="toggleTag" data-arg="${esc(f.slug)}">${esc(f.icon || "")} ${esc((f.name && f.name.en) || f.slug)}</span>`)
    .join("");
  return `<div class="chips">${chips || '<span class="hint">No filters yet — make some in the Filters tab.</span>'}</div>`;
}
// ingredientRows: one editable row per ingredient (emoji + name + delete), plus
// an "+ Ingredient" button to add another.
function ingredientRows(it) {
  const rows = (it.ingredients || [])
    .map((ing, i) => `<div class="row-item">
      <input class="narrow" data-path="ingredients.${i}.emoji" value="${esc(ing.emoji || "")}" placeholder="🍞"/>
      <input data-path="ingredients.${i}.name" value="${esc(ing.name || "")}" placeholder="Ingredient name"/>
      <button class="icon-btn" data-action="rmIngredient" data-arg="${i}"><i class="fas fa-trash"></i></button>
    </div>`).join("");
  return `<div class="rows">${rows}</div><button class="btn small" data-action="addIngredient" style="margin-top:10px">+ Ingredient</button>`;
}
// reviewRows: one editable row per customer review (name + star rating + text).
function reviewRows(it) {
  const rows = (it.reviews || [])
    .map((rv, i) => `<div class="row-item">
      <input data-path="reviews.${i}.name" value="${esc(rv.name || "")}" placeholder="Name" style="max-width:150px"/>
      <input class="narrow" type="number" min="1" max="5" data-path="reviews.${i}.rating" value="${esc(rv.rating ?? 5)}"/>
      <textarea data-path="reviews.${i}.text" placeholder="Review text">${esc(rv.text || "")}</textarea>
      <button class="icon-btn" data-action="rmReview" data-arg="${i}"><i class="fas fa-trash"></i></button>
    </div>`).join("");
  return `<div class="rows">${rows}</div><button class="btn small" data-action="addReview" style="margin-top:10px">+ Review</button>`;
}

// ---------- forms ----------
// Customization options editor (Size, Milk, Extras… — each choice can add to price).
function optionsHtml(it) {
  const groups = it.options || [];
  const groupsHtml = groups.map((g, i) => `
    <div class="opt-group">
      <div class="grid cols-2">
        ${tf("Group name", `options.${i}.name`, g.name, { ph: "Size" })}
        <div class="field"><label>Guest can…</label>
          <select data-path="options.${i}.type">
            <option value="single" ${g.type !== "multi" ? "selected" : ""}>Pick one</option>
            <option value="multi" ${g.type === "multi" ? "selected" : ""}>Pick any</option>
          </select>
        </div>
      </div>
      <div class="opt-choices">
        ${(g.choices || []).map((c, j) => `
          <div class="opt-choice">
            ${tf("Choice", `options.${i}.choices.${j}.label`, c.label, { ph: "Large" })}
            ${tf("Price +", `options.${i}.choices.${j}.price`, c.price, { type: "number", ph: "0" })}
            <button class="btn small danger" data-action="rmOptChoice" data-arg="${i}.${j}">✕</button>
          </div>`).join("")}
        <button class="btn small" data-action="addOptChoice" data-arg="${i}">+ Choice</button>
      </div>
      <button class="btn small danger" data-action="rmOptGroup" data-arg="${i}" style="margin-top:10px">Remove group</button>
    </div>`).join("");
  return `<div class="card"><h3>Customization options</h3>
    <span class="hint">Let guests customise this dish (Size, Milk, Extras…). Each choice's price adds to the base. Leave empty for none.</span>
    <div class="opt-groups">${groupsHtml}</div>
    <button class="btn small primary" data-action="addOptGroup" style="margin-top:12px">+ Add option group</button>
  </div>`;
}

// formItems: builds the entire right-hand edit form for ONE dish — basics,
// image, 3D models, diet/filters, allergens, options, details, nutrition,
// ingredients and reviews. It's just one big HTML string assembled from the
// small field helpers above.
function formItems(it) {
  return `
  <div class="card"><h3>Basics</h3>
    <div class="grid cols-2">
      ${tf("Title", "title", it.title, { span: true })}
      ${tf("ID (permanent)", "id", it.id, { disabled: !state.isNew, ph: state.isNew ? "auto from title" : "", hint: state.isNew ? "Leave blank — we'll make it from the title." : "Unique. Can't change later." })}
      ${tf("Slug (URL)", "slug", it.slug, { ph: state.isNew ? "auto from title" : "gourmet-burger", hint: state.isNew ? "Leave blank to auto-fill from the title." : "" })}
      ${tf("Price", "price", it.price, { ph: "12.99" })}
      ${catSelect(it.category)}
      ${tf("Sort order", "sort_order", it.sort_order, { type: "number" })}
    </div>
    <button type="button" class="avail-toggle ${(it.tags || []).includes("sold-out") ? "off" : "on"}" data-action="toggleSoldOut">
      ${(it.tags || []).includes("sold-out")
        ? "🚫 Not available right now — tap to make available"
        : "✅ Available — tap to mark not available"}
    </button>
  </div>

  <div class="card"><h3>Image</h3>
    <div class="grid cols-2" style="align-items:start">
      ${tf("Image URL", "image", it.image, { ph: "https://…" })}
      <img id="imgPreview" class="preview-img" src="${esc(it.image || "")}" alt="" style="opacity:${it.image ? 1 : 0.2}"/>
    </div>
  </div>

  <div class="card"><h3>3D · 4D</h3>
    <div style="margin-bottom:14px">${toggle("4D mode — cyan glow outline + 3D preview", "is4d", it.is4d)}</div>
    <div class="grid cols-2">
      ${tf("Model folder", "model_folder", it.model_folder)}
      <div></div>
      ${tf("GLB — small (fast load)", "model_small_url", it.model_small_url, { span: true, ph: "https://…/model_small.glb" })}
      ${tf("GLB — optimized (full quality)", "model_optimized_url", it.model_optimized_url, { span: true, ph: "https://…/model-optimized.glb" })}
    </div>
    <span class="hint">4D only appears on the menu when both GLB URLs are filled.</span>
  </div>

  <div class="card"><h3>Diet & filters</h3>
    <div style="margin-bottom:16px">${toggle("Vegetarian (green leaf icon)", "veg", it.veg)}</div>
    ${lbl("Filter tags")}
    ${tagChips(it.tags)}
  </div>

  <div class="card"><h3>Allergens</h3>
    ${lbl("Tap the allergens this dish contains (shown on the dish page + checkout)")}
    <div class="chips">
      ${ALLERGENS.map((a) => `<span class="chip ${(it.allergens || []).includes(a.slug) ? "on" : ""}" data-action="toggleAllergen" data-arg="${a.slug}">${esc(a.label)}</span>`).join("")}
    </div>
  </div>

  ${optionsHtml(it)}

  <div class="card"><h3>Details</h3>
    <div class="grid cols-2">
      ${tf("Rating", "rating", it.rating, { ph: "4.8" })}
      ${tf("Prep time", "time", it.time, { ph: "25-30 min" })}
      ${ta("Short description", "description", it.description, { span: true })}
      ${ta("Long description", "long_description", it.long_description, { span: true })}
      ${tf("Search keywords", "search_alias", it.search_alias, { span: true, hint: "Hidden words guests can search by, comma-separated (e.g. caesar, healthy, bowl)." })}
    </div>
  </div>

  <div class="card"><h3>Nutrition</h3>
    <div class="grid cols-2">
      ${tf("Calories", "nutrition.calories", (it.nutrition || {}).calories)}
      ${tf("Protein", "nutrition.protein", (it.nutrition || {}).protein)}
      ${tf("Carbs", "nutrition.carbs", (it.nutrition || {}).carbs)}
      ${tf("Sugar (shown on dish page)", "nutrition.sugar", (it.nutrition || {}).sugar)}
    </div>
  </div>

  <div class="card"><h3>Ingredients</h3>${ingredientRows(it)}</div>
  <div class="card"><h3>Reviews</h3>${reviewRows(it)}</div>`;
}

// formCategories: the edit form for one category (icon, colour, sort order,
// show/hide, and a name box per language).
function formCategories(c) {
  return `
  <div class="card"><h3>Category</h3>
    <div class="grid cols-2">
      ${tf("Slug (permanent)", "slug", c.slug, { disabled: !state.isNew, hint: "Used on dishes. Can't change later." })}
      ${tf("Sort order", "sort_order", c.sort_order, { type: "number" })}
      ${tf("Icon (FontAwesome class)", "icon", c.icon, { ph: "fa-burger" })}
      <div class="field"><label>Colour</label>
        <input type="color" data-path="color" value="${esc(c.color || "#d4a574")}" style="height:40px;padding:4px"/></div>
    </div>
    <div style="display:flex;gap:18px;align-items:center;margin-top:16px">
      <div id="iconPreview" class="icon-preview" style="color:${esc(c.color || "#d4a574")}"><i class="fas ${esc(c.icon || "fa-tag")}"></i></div>
      ${toggle("Show on menu", "active", c.active !== false)}
    </div>
    <span class="hint">Icon names: fontawesome.com (free solid). Type just the class, e.g. fa-pizza-slice.</span>
  </div>
  <div class="card"><h3>Name — one box per language</h3>
    <div class="grid cols-2">
      ${LANGS.map(([code, label]) => tf(label, `name.${code}`, (c.name || {})[code])).join("")}
    </div>
    <span class="hint">English is the fallback if a language is left empty.</span>
  </div>`;
}

// formFilters: the edit form for one filter/tag (emoji, sort order, names),
// plus the "which dishes carry this tag" picker below it.
function formFilters(f) {
  return `
  <div class="card"><h3>Filter</h3>
    <div class="grid cols-2">
      ${tf("Slug (permanent)", "slug", f.slug, { disabled: !state.isNew, hint: "Used in dish tags, e.g. vegan, spicy." })}
      ${tf("Sort order", "sort_order", f.sort_order, { type: "number" })}
      ${tf("Icon / emoji", "icon", f.icon, { ph: "🌿" })}
      <div class="field"><label>Preview</label>
        <div style="display:flex;gap:18px;align-items:center">
          <div id="iconPreview" class="icon-preview">${esc(f.icon || "🏷️")}</div>
          ${toggle("Show on menu", "active", f.active !== false)}
        </div></div>
    </div>
  </div>
  <div class="card"><h3>Name — one box per language</h3>
    <div class="grid cols-2">
      ${LANGS.map(([code, label]) => tf(label, `name.${code}`, (f.name || {})[code])).join("")}
    </div>
  </div>
  ${filterMembersHtml(f)}`;
}

// Manage which existing dishes carry this tag. This is how you add already-listed
// dishes to "Chef's Special" (or any tag) without recreating them — a dish can be
// in its normal category AND tagged here at the same time.
function filterMembersHtml(f) {
  if (state.isNew || !f.slug) return "";
  const label = (f.name && f.name.en) || f.slug;
  const items = state.data.items || [];
  const selected = items.filter((it) => (it.tags || []).includes(f.slug)).length;
  const rows = items
    .map((it) => {
      const on = (it.tags || []).includes(f.slug);
      const hay = `${(it.title || "").toLowerCase()} ${it.category || ""}`;
      return `<label class="memb-row${on ? " on" : ""}" data-memb="${esc(hay)}">
        <input type="checkbox" data-action="toggleMember" data-arg="${esc(it.id)}"${on ? " checked" : ""}>
        <span class="memb-title">${esc(it.title || it.slug)}</span>
        <span class="memb-cat">${esc(it.category || "")}</span>
      </label>`;
    })
    .join("");
  return `<div class="card"><h3>Dishes in "${esc(label)}"
      <span class="sub">· <b id="membCount">${selected}</b> selected · tick to add an existing dish, untick to remove</span></h3>
    <input class="memb-search" id="membSearch" placeholder="Search dishes…" />
    <div class="memb-list">${rows}</div>
  </div>`;
}

// formGeneral: the site-wide Settings form — maintenance mode, the bubble
// effect, table count, and the dining-session/location options.
function formGeneral(s) {
  return `
  <div class="card"><h3>Service mode</h3>
    <p style="color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5">
      When ON, the public menu is replaced by a full-screen <b>"We'll be right back"</b>
      maintenance screen — customers can't view or order anything until you switch it
      back off. Use it while updating the menu or during a break.
    </p>
    ${toggle("Put the menu under maintenance", "service_mode", s.service_mode === true)}
  </div>
  <div class="card"><h3>Bubble effect</h3>
    <p style="color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5">
      The rising bubble particles in the menu background (the "furnace" look).
      Turn this off for a flat, calm background.
    </p>
    ${toggle("Show rising bubbles on the menu", "bubbles_enabled", s.bubbles_enabled !== false)}
  </div>
  <div class="card"><h3>Tables / seating</h3>
    <p style="color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5">
      How many tables the restaurant has. Drives the live floor map in the
      <b>Tables</b> tab — Save, then open Tables.
    </p>
    <div style="max-width:200px">${tf("Number of tables", "table_count", s.table_count ?? 12, { type: "number", min: 1, max: 500, step: 1 })}</div>
  </div>
  <div class="card"><h3>Dining sessions — NEW</h3>
    <p style="color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5">
      The QR/session system. <b>When OFF, the menu works exactly like today.</b> Turn it
      ON only when you're ready: guests must be at the café (location) to order or call a
      waiter, and the first order asks for a one-time phone code.
    </p>
    ${toggle("Turn the dining-session system ON", "sessions_enabled", s.sessions_enabled === true)}
    ${toggle("Require location (guest must be near the café)", "require_location", s.require_location !== false)}
    ${toggle("Require a phone code (OTP) to place an order", "require_otp", s.require_otp !== false)}
    <p style="color:var(--muted);font-size:13px;margin:16px 0 10px;line-height:1.5">
      Café location — used only to confirm guests are physically here. In Google Maps,
      right-click your café and click the latitude, longitude numbers at the top to copy them.
      Leave blank to skip the location check.
    </p>
    <div class="grid cols-3">
      ${tf("Latitude", "geo_lat", s.geo_lat ?? "", { type: "number", step: "any" })}
      ${tf("Longitude", "geo_lng", s.geo_lng ?? "", { type: "number", step: "any" })}
      ${tf("Radius (metres)", "geo_radius_m", s.geo_radius_m ?? 250, { type: "number", min: 20, max: 5000, step: 10 })}
    </div>
  </div>`;
}

// STATUS_META: how each order status looks on screen — its badge label and the
// CSS class that colours it.
const STATUS_META = {
  received: { label: "🔔 New", cls: "received" },
  preparing: { label: "👨‍🍳 Preparing", cls: "preparing" },
  served: { label: "✓ Served", cls: "served" },
  cancelled: { label: "✕ Cancelled", cls: "cancelled" },
};
// STATUS_RANK: a sort order so the Orders list shows New first, then Preparing, etc.
const STATUS_RANK = { received: 0, preparing: 1, served: 2, cancelled: 3 };

// itemDetailLine: the small sub-line under a dish showing EVERYTHING the guest
// chose — picked options ("Large · Oat milk · Extra shot"), removed/allergen
// ingredients ("NO DAIRY"), and any note ("'less ice'"). Shared by the order
// cards, the per-table bill, AND the table detail popup so the kitchen always
// sees exactly what to make. Returns "" when a dish is plain (nothing to show).
function itemDetailLine(it) {
  const parts = [];
  if (Array.isArray(it.options) && it.options.length) parts.push(it.options.map((o) => esc(o.label)).join(" · "));
  if (Array.isArray(it.removed) && it.removed.length) parts.push("NO " + it.removed.map((r) => esc(r)).join(", ").toUpperCase());
  if (it.note) parts.push("“" + esc(it.note) + "”");
  return parts.length ? `<div class="ord-line-opts">${parts.join(" · ")}</div>` : "";
}

// dishNoTag: the editor-only "#N" dish code shown next to an ordered dish. Order
// rows store only the title, so we look the dish up by title to find its dish_no.
// Customer-facing screens never call this — it's editor staff reference only.
function dishNoTag(title) {
  const d = (state.data.items || []).find((m) => (m.title || "") === title);
  return d && d.dish_no != null ? ` <span class="dish-no">#${esc(String(d.dish_no))}</span>` : "";
}

// orderCardHtml: build the big card for ONE order in the Orders tab — its items,
// allergy note, total, payment pill, and the action buttons that fit its current
// stage. `freed` = true means it's an archived/cleared order shown in the lower
// "Freed tables" section, which only gets a "Restore to floor" button.
function orderCardHtml(o, freed = false) {
  const status = o.status || "received"; // default a missing status to "received"
  const meta = STATUS_META[status] || STATUS_META.received; // look up its label + colour
  const when = o.created_at ? new Date(o.created_at).toLocaleString() : ""; // friendly date/time
  // Build one line per item, including any chosen options, "NO …" removals, and notes.
  const items = (o.items || [])
    .map((i) => `<div class="ord-line"><span>${esc(i.title)}${dishNoTag(i.title)} <b>×${esc(i.qty)}</b>${itemDetailLine(i)}</span><span>${esc(i.price)}</span></div>`)
    .join("");
  const allergy = (o.allergies || []).length
    ? `<div class="ord-allergy">⚠ Avoid: ${o.allergies.map(esc).join(", ")}</div>`
    : "";
  // Actions depend on where the order is in its lifecycle.
  let actions = "";
  if (status === "received") {
    actions = `<button class="ord-btn accept" data-act="preparing" data-id="${esc(o.id)}">✓ Accept &amp; Prepare</button>
               <button class="ord-btn ghost" data-act="cancelled" data-id="${esc(o.id)}">Cancel</button>`;
  } else if (status === "preparing") {
    actions = `<button class="ord-btn serve" data-act="served" data-id="${esc(o.id)}">🍽️ Mark Served</button>
               <button class="ord-btn ghost" data-act="cancelled" data-id="${esc(o.id)}">Cancel</button>`;
  } else if (status === "served") {
    actions = `<button class="ord-btn ghost" data-act="preparing" data-id="${esc(o.id)}">↩ Reopen</button>`;
  } else {
    actions = `<button class="ord-btn ghost" data-act="received" data-id="${esc(o.id)}">↩ Restore</button>`;
  }
  const paid = o.payment_status === "paid"; // has the guest settled this order?
  const cancelled = status === "cancelled"; // voided: no money is due, so no pay control
  // Can this whole table leave the floor? Only when EVERY non-archived order on
  // it is settled (paid or cancelled) — never free a table with money still due.
  const tnum = (o.table_number || "").trim();
  // tableOrders: every live order sharing this table number.
  const tableOrders = tnum
    ? (state.data.orders || []).filter((x) => !x.archived && (x.table_number || "").trim() === tnum)
    : [];
  // tableDue: add up the money still owed across the whole table.
  const tableDue = tableOrders
    .filter((x) => x.status !== "cancelled" && x.payment_status !== "paid")
    .reduce((s, x) => s + (parseFloat(x.total) || 0), 0);
  const tableSettled = tableOrders.length > 0 && tableDue === 0; // nothing left to pay → safe to free
  // Freed cards: just a "restore to floor" affordance. Live cards: full actions.
  const actionsRow = freed
    ? `<button class="ord-btn ghost" data-restore="${esc(o.id)}">↩ Restore to floor</button>`
    : `${cancelled ? "" : `<button class="ord-btn ${paid ? "ghost" : "pay"}" data-pay="${esc(o.id)}" data-paid="${paid ? "1" : "0"}">
        ${paid ? "↩ Mark unpaid" : "💳 Mark paid"}
      </button>`}
      ${actions}
      ${tnum && paid
        ? (tableSettled
            ? `<button class="ord-btn free-table" data-free-table="${esc(tnum)}">🪑 Free table ${esc(tnum)}</button>`
            : `<button class="ord-btn free-table" disabled title="Settle the rest of this table first">🪑 ${inr(tableDue)} still due</button>`)
        : ""}`;
  return `<div class="card ord-card ord-${meta.cls} ${paid ? "is-paid" : ""} ${freed ? "is-freed" : ""}">
    <div class="ord-top">
      <label class="ord-check"><input type="checkbox" class="ord-select" data-sel="${esc(o.id)}"> </label>
      <b>${o.table_number ? "Table " + esc(o.table_number) : "Walk-in / no table"}</b>
      <span class="ord-pill ${meta.cls}">${meta.label}</span>
      ${cancelled
        ? `<span class="pay-pill voided">— Voided</span>`
        : `<span class="pay-pill ${paid ? "paid" : "pending"}">${paid ? "💳 Paid" : "⏳ Unpaid"}</span>`}
      ${freed ? `<span class="ord-pill freed-pill">✓ Freed</span>` : ""}
      <button class="ord-del" data-del="${esc(o.id)}" title="Delete order">🗑</button>
    </div>
    <small class="ord-when">${esc(when)}</small>
    <div class="ord-items">${items}</div>
    ${allergy}
    <div class="ord-total"><span>Total</span><span>${inr(o.total)}</span></div>
    <div class="ord-actions">${actionsRow}</div>
  </div>`;
}

// Pending waiter calls shown at the top of the Orders tab.
function callsHtml() {
  const calls = (state.data.calls || []).filter((c) => !c.resolved);
  if (!calls.length) return "";
  const rows = calls.map((c) => {
    const when = c.created_at ? new Date(c.created_at).toLocaleTimeString() : "";
    const REASON_EMOJI = {
      "Call waiter": "🙋", "Water": "💧", "Cutlery": "🍴",
      "Napkins": "🧻", "Clean table": "🧹", "Bring the bill": "🧾",
    };
    const reason = c.note ? esc(c.note) : "needs a waiter";
    const emoji = REASON_EMOJI[c.note] || "🔔";
    return `<div class="call-row">
      <span class="call-bell">${emoji}</span>
      <b>${c.table_number ? "Table " + esc(c.table_number) : "A guest"}</b>
      <span class="call-when">${reason} · ${esc(when)}</span>
      <button class="ord-btn serve" data-resolve="${esc(c.id)}">✓ Attended</button>
    </div>`;
  }).join("");
  return `<div class="calls-panel"><h3>🔔 Waiter calls (${calls.length})</h3>${rows}</div>`;
}

// ordersHtml: the Orders tab. A LEFT BAR switches the main panel between Live
// orders, Previous orders (which ARE the bills — past + cancelled), and waiter
// Calls. The header shows the live counts.
// Normalize the selected Orders view, mapping the old "live"/"bills" keys to the
// current "today"/"previous". Shared by the sidebar nav and the main view so they
// always agree on what's selected.
function ordersViewKey() {
  return (state.ordersView === "bills" || state.ordersView === "live")
    ? (state.ordersView === "bills" ? "previous" : "today")
    : (state.ordersView || "today");
}

// Split orders by DAY: TODAY's (live AND already-served, shown together) vs
// PREVIOUS (anything archived, cancelled, or older than today — the bill records),
// plus the count of unresolved waiter calls. ONE source of truth for both the
// sidebar nav counts and the main view, so they can never disagree.
function ordersBuckets() {
  const all = state.data.orders || [];
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const ts = startToday.getTime();
  const isToday = (o) => o.created_at && new Date(o.created_at).getTime() >= ts;
  const today = all.filter((o) => !o.archived && o.status !== "cancelled" && isToday(o));
  const previous = all.filter((o) => o.archived || o.status === "cancelled" || !isToday(o));
  const callCount = (state.data.calls || []).filter((c) => !c.resolved).length;
  return { today, previous, callCount };
}

function ordersHtml() {
  // The Today / Previous / Calls nav lives in the LEFT SIDEBAR now (see renderList).
  // Here we only build the heading + the selected view's cards in the main area.
  const { today, previous } = ordersBuckets();
  const active = today.filter((o) => o.status === "received" || o.status === "preparing").length;
  const view = ordersViewKey();

  let main;
  if (view === "previous") main = ordersPreviousHtml(previous);
  else if (view === "calls") main = ordersCallsHtml();
  else main = ordersLiveHtml(today);

  const head = `<div class="ed-head">
      <h2>Orders <span class="sub">· ${active} active / ${today.length} today</span></h2>
      <button class="btn" id="refreshOrders">↻ Refresh</button>
    </div>`;
  return head + `<div class="ord-wrap"><div class="ord-main">${main}</div></div>`;
}

// LIVE view: current orders (newest stage first), grouped by table number, each
// an order card with its full item detail + accept/serve/pay actions. Keeps the
// bulk-select + "money owed" banner that staff rely on.
function ordersLiveHtml(live) {
  if (!live.length) return `<div class="empty">No active orders right now. Orders placed from the menu show up here.</div>`;
  const orders = [...live].sort((a, b) =>
    (String(a.table_number || "").localeCompare(String(b.table_number || ""), undefined, { numeric: true }))
    || ((STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0)));
  const unpaid = live.filter((o) => o.payment_status !== "paid" && o.status !== "cancelled");
  const pendingTotal = unpaid.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
  const note = unpaid.length
    ? `<div class="ord-note">⏳ <b>Pending bills:</b> ${unpaid.length} order${unpaid.length !== 1 ? "s" : ""} · ${inr(pendingTotal)} unpaid — mark each "Paid" once the guest settles up.</div>`
    : "";
  const bulk = `<div class="ord-bulk">
      <label class="ord-check"><input type="checkbox" id="ordSelectAll"> Select all</label>
      <span id="ordSelCount" class="sub"></span>
      <button class="btn danger" id="ordDeleteSelected" disabled>Delete selected</button>
    </div>`;
  return note + bulk + `<div class="ord-grid">${orders.map((o) => orderCardHtml(o)).join("")}</div>`;
}

// PREVIOUS view: the bill records — freed/cleared orders AND cancelled orders,
// newest first. Each archived order gets an un-archive "restore"; each cancelled
// order gets a status-restore (back to received). This is where bills live now.
function ordersPreviousHtml(previous) {
  if (!previous.length) return `<div class="empty">No previous orders yet. Freed &amp; cancelled orders land here as bills.</div>`;
  const sorted = [...previous].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  // freed=true for archived rows (restore = un-archive); freed=false for a
  // cancelled-but-not-archived row (its card offers a status restore instead).
  return `<div class="ord-section-divider"><h3>✓ Previous orders <span class="sub">· ${previous.length}</span></h3>
       <span class="ord-section-hint">Past bills — settled, freed, or cancelled. Kept in records.</span>
       <button class="btn danger" id="clearFreed">🗑 Clear all</button></div>
     <div class="ord-grid ord-grid-freed">${sorted.map((o) => orderCardHtml(o, !!o.archived)).join("")}</div>`;
}

// CALLS view: the live waiter-call list (water/cutlery/bill…), or an empty note.
function ordersCallsHtml() {
  const calls = (state.data.calls || []).filter((c) => !c.resolved);
  if (!calls.length) return `<div class="empty">No waiter calls right now.</div>`;
  return callsHtml();
}

// freeTable: clear a settled table off the floor by archiving all its orders
// (they stay in the records, just hidden from the live view). Asks first.
async function freeTable(t) {
  const ids = (state.data.orders || []).filter((o) => !o.archived && (o.table_number || "").trim() === String(t)).map((o) => o.id);
  if (!ids.length) return;
  if (!(await confirmDialog(`Free Table ${t}? Its ${ids.length} settled order(s) leave the floor (kept in records).`, "Free table"))) return;
  try {
    for (const id of ids) await api("PATCH", "/orders/" + id, { archived: true });
    (state.data.orders || []).forEach((o) => { if (ids.includes(o.id)) o.archived = true; });
    renderEditor();
    toast(`Table ${t} freed`, "ok");
  } catch (e) { toast("Could not free: " + e.message, "err"); }
}

// Bring a freed order back onto the live floor (un-archive).
async function restoreTable(id) {
  try {
    await api("PATCH", "/orders/" + id, { archived: false });
    const o = (state.data.orders || []).find((x) => x.id === id);
    if (o) o.archived = false;
    renderEditor();
    toast("Restored to floor", "ok");
  } catch (e) {
    toast("Restore failed: " + e.message, "err");
  }
}

// setOrderStatus: move one order to a new status (e.g. Accept → preparing).
// OPTIMISTIC: the screen flips INSTANTLY and the server is told in the
// background; if the server refuses, we roll back and explain. This is what
// makes 20 clicks in a row feel real-time instead of 20 waits.
async function setOrderStatus(id, status) {
  const o = (state.data.orders || []).find((x) => x.id === id);
  const prev = o ? o.status : null;
  if (o) o.status = status;        // flip the screen NOW
  opBegin(id);                     // shield this order from the poll meanwhile
  renderEditor();
  renderTablePanel();
  try {
    await api("PATCH", "/orders/" + id, { status }); // sync in the background
    toast("Order updated → " + status, "ok");
  } catch (e) {
    if (o && prev !== null) o.status = prev;         // server said no -> undo
    renderEditor();
    renderTablePanel();
    toast("Could not update order: " + e.message, "err");
  } finally {
    opEnd(id);
  }
}

// cancelOrder: void one order (after confirming). If cancelling it leaves the
// table with NO active orders, offer to free the table in the same flow — so a
// cancelled, empty table doesn't sit open by mistake.
async function cancelOrder(id) {
  if (!(await confirmDialog("Cancel this order? It will be voided — no charge to the guest.", "Cancel order"))) return;
  await setOrderStatus(id, "cancelled");
  const o = (state.data.orders || []).find((x) => x.id === id);
  const t = (o && o.table_number ? o.table_number : "").trim();
  if (!t) return;
  // Any non-cancelled, non-archived order still live at this table?
  const stillActive = (state.data.orders || []).some((x) => !x.archived && (x.table_number || "").trim() === t && x.status !== "cancelled");
  if (!stillActive && (await confirmDialog(`Table ${t} has no active orders left. Free the table?`, "Free table"))) freeTable(t);
}

// deleteOrders: permanently delete orders — a single one, a selected batch, or
// every order (all=true). OPTIMISTIC: the cards vanish instantly; the server
// catches up in the background (and the rows return + an error shows if it
// fails). No more re-downloading all 200 orders just to delete one.
async function deleteOrders(ids, all = false) {
  const before = state.data.orders || [];
  const gone = all ? before.map((o) => o.id) : ids;
  state.data.orders = all ? [] : before.filter((o) => !ids.includes(o.id));
  lastOrderCount = state.data.orders.length;
  gone.forEach((id) => pendingDeletes.add(id)); // poll must not resurrect them
  renderEditor();
  try {
    if (all) await api("POST", "/orders/delete", { all: true });
    else if (ids && ids.length === 1) await api("DELETE", "/orders/" + ids[0]);
    else await api("POST", "/orders/delete", { ids });
    toast(all ? "All orders deleted" : "Order(s) deleted", "ok");
  } catch (e) {
    state.data.orders = before;   // bring the rows back — the delete failed
    lastOrderCount = before.length;
    renderEditor();
    toast("Delete failed: " + e.message, "err");
  } finally {
    gone.forEach((id) => pendingDeletes.delete(id));
  }
}

// setOrderPayment: flip one order between paid and unpaid.
// OPTIMISTIC like setOrderStatus: screen first, server second, undo on error.
async function setOrderPayment(id, paid) {
  const o = (state.data.orders || []).find((x) => x.id === id);
  const prev = o ? o.payment_status : null;
  if (o) o.payment_status = paid ? "paid" : "pending"; // flip the screen NOW
  opBegin(id);                     // shield this order from the poll meanwhile
  renderEditor();
  renderTablePanel();
  try {
    await api("PATCH", "/orders/" + id, { payment_status: paid ? "paid" : "pending" });
    toast(paid ? "Marked paid 💳" : "Marked unpaid", "ok");
  } catch (e) {
    if (o && prev !== null) o.payment_status = prev;   // undo on failure
    renderEditor();
    renderTablePanel();
    toast("Could not update payment: " + e.message, "err");
  } finally {
    opEnd(id);
  }
}

// resolveCall: mark a waiter call as attended and drop it from the list.
// OPTIMISTIC: the call disappears instantly; restored if the server fails.
async function resolveCall(id) {
  const before = state.data.calls || [];
  state.data.calls = before.filter((c) => c.id !== id); // vanish NOW
  renderEditor();
  try {
    await api("PATCH", "/calls/" + id, { resolved: true });
    toast("Marked attended", "ok");
  } catch (e) {
    state.data.calls = before; // bring it back — the server didn't get it
    renderEditor();
    toast("Could not update call: " + e.message, "err");
  }
}

// ---------- render + bind ----------
// renderEditor: the heart of the screen. It looks at which tab is open and draws
// the matching panel into the #editor area, then wires up that panel's buttons.
// Think of it as a switchboard: tables → floor, log → log, orders → orders,
// otherwise → the edit form for the selected dish/category/filter/settings.
function renderEditor() {
  const ed = $("#editor");
  if (state.tab === "tables") {
    ed.innerHTML = floorHtml();
    bindFloor();
    return;
  }
  if (state.tab === "log") {
    ed.innerHTML = logHtml();
    bindLog();
    return;
  }
  if (state.tab === "orders") {
    ed.innerHTML = ordersHtml(); // draw the orders screen
    const rb = document.getElementById("refreshOrders");
    if (rb) rb.onclick = loadOrders;
    // Each block below finds a set of buttons by their data-* marker and attaches
    // the click behaviour. (We re-draw the HTML each time, so we re-bind each time.)
    ed.querySelectorAll(".ord-btn[data-act]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id, act = btn.dataset.act;
        const o = (state.data.orders || []).find((x) => x.id === id);
        if (act === "cancelled") return cancelOrder(id);
        // Accept (received → preparing) and Serve-all must flip the per-dish
        // order_items too, not just orders.status — otherwise the dishes stay
        // "received" and the table panel can't serve them (the glitch). Route
        // these through the /accept and /serve-all endpoints that do both.
        if (act === "preparing" && o && o.status === "received") return acceptOrder(id);
        if (act === "served") return serveAllOrder(id);
        setOrderStatus(id, act); // reopen / restore (no per-dish change needed)
      };
    });
    ed.querySelectorAll(".ord-del[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        if (await confirmDialog("Delete this order? It will be permanently removed.", "Delete")) deleteOrders([btn.dataset.del]);
      };
    });
    ed.querySelectorAll("[data-resolve]").forEach((btn) => {
      btn.onclick = () => resolveCall(btn.dataset.resolve);
    });
    ed.querySelectorAll("[data-pay]").forEach((btn) => {
      btn.onclick = () => setOrderPayment(btn.dataset.pay, btn.dataset.paid !== "1");
    });
    ed.querySelectorAll("[data-free-table]").forEach((btn) => {
      btn.onclick = () => freeTable(btn.dataset.freeTable);
    });
    ed.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.onclick = () => restoreTable(btn.dataset.restore);
    });
    // Left-bar: switch which Orders view is showing (live / previous / bills / calls).
    ed.querySelectorAll("[data-orders-view]").forEach((btn) => {
      btn.onclick = () => { state.ordersView = btn.dataset.ordersView; renderEditor(); };
    });
    // Bills view: settle a table's WHOLE bill at once (mark every unpaid order paid).
    ed.querySelectorAll("[data-pay-table]").forEach((btn) => {
      btn.onclick = () => btn.dataset.payTable.split(",").filter(Boolean).forEach((id) => setOrderPayment(id, true));
    });
    const updateSel = () => {
      const ids = [...ed.querySelectorAll(".ord-select:checked")].map((c) => c.dataset.sel);
      const cnt = document.getElementById("ordSelCount");
      if (cnt) cnt.textContent = ids.length ? `${ids.length} selected` : "";
      const del = document.getElementById("ordDeleteSelected");
      if (del) del.disabled = ids.length === 0;
      return ids;
    };
    ed.querySelectorAll(".ord-select").forEach((c) => (c.onchange = updateSel));
    const all = document.getElementById("ordSelectAll");
    if (all) all.onchange = () => {
      ed.querySelectorAll(".ord-select").forEach((c) => (c.checked = all.checked));
      updateSel();
    };
    const delSel = document.getElementById("ordDeleteSelected");
    if (delSel) delSel.onclick = async () => {
      const ids = [...ed.querySelectorAll(".ord-select:checked")].map((c) => c.dataset.sel);
      if (!ids.length) return;
      if (await confirmDialog(`Delete ${ids.length} selected order${ids.length > 1 ? "s" : ""}? They'll be permanently removed.`, "Delete")) deleteOrders(ids);
    };
    // Clear every freed/archived record in one go (the records you can't otherwise
    // reach with the active-orders bulk bar).
    const clearFreed = document.getElementById("clearFreed");
    if (clearFreed) clearFreed.onclick = async () => {
      const ids = (state.data.orders || []).filter((o) => o.archived).map((o) => o.id);
      if (!ids.length) return;
      if (await confirmDialog(`Permanently delete all ${ids.length} freed record${ids.length > 1 ? "s" : ""}?`, "Delete")) deleteOrders(ids);
    };
    return;
  }
  // From here down we're on an editable tab (dishes/categories/filters/settings).
  // If nothing is selected yet, show a gentle prompt.
  if (!state.sel) {
    ed.innerHTML = `<div class="empty">Pick something on the left, or hit <b>+ New</b>.</div>`;
    return;
  }
  const isGeneral = state.tab === "general";
  // Pick the right form builder for the current tab.
  const body =
    state.tab === "items" ? formItems(state.sel)
    : state.tab === "categories" ? formCategories(state.sel)
    : state.tab === "filters" ? formFilters(state.sel)
    : formGeneral(state.sel);
  const title = isGeneral ? "General settings" : (state.isNew ? `New ${TAB_LABEL[state.tab]}` : recLabel(state.sel));
  ed.innerHTML = `
    <div class="ed-head">
      <h2>${esc(title)} ${(!isGeneral && !state.isNew) ? `<span class="sub">· ${esc(recKey(state.sel) || "")}</span>` : ""}</h2>
      ${(isGeneral || state.isNew) ? "" : '<button class="btn danger" id="delBtn">Delete</button>'}
      <button class="btn primary" id="saveBtn">Save</button>
    </div>
    ${body}`;
  bindEditor();
}

// updatePreviews: as you type an image URL, icon, or colour, refresh the little
// live preview without redrawing the whole form (which would lose your cursor).
function updatePreviews() {
  const it = state.sel;
  const img = document.getElementById("imgPreview");
  if (img) { img.src = it.image || ""; img.style.opacity = it.image ? 1 : 0.2; }
  const ip = document.getElementById("iconPreview");
  if (ip) {
    if (state.tab === "categories") { ip.style.color = it.color || "#d4a574"; ip.innerHTML = `<i class="fas ${esc(it.icon || "fa-tag")}"></i>`; }
    else if (state.tab === "filters") { ip.textContent = it.icon || "🏷️"; }
  }
}

// bindEditor: make the edit form interactive. It connects Save/Delete, and — the
// clever bit — auto-wires every input: when you change a field, it reads that
// field's data-path and writes the new value into state.sel at that location.
function bindEditor() {
  const ed = $("#editor");
  $("#saveBtn").onclick = save;
  const del = $("#delBtn");
  if (del) del.onclick = removeRecord;

  // For every labelled input/select/textarea, listen for changes and store the value.
  ed.querySelectorAll("[data-path]").forEach((node) => {
    const path = node.dataset.path;
    // Checkboxes/dropdowns fire "change"; text boxes fire "input" (as you type).
    const evt = node.tagName === "SELECT" || node.type === "checkbox" ? "change" : "input";
    node.addEventListener(evt, () => {
      // Read the value in the right shape: true/false for a checkbox, a number for
      // number fields (blank → null), otherwise the plain text.
      let v;
      if (node.type === "checkbox") v = node.checked;
      else if (node.type === "number") v = node.value === "" ? null : Number(node.value);
      else v = node.value;
      setPath(state.sel, path, v); // save it into the working copy at its dotted path
      if (path === "image" || path === "icon" || path === "color") updatePreviews(); // refresh the live preview
    });
  });

  // Buttons marked with data-action (add/remove rows, toggle chips, etc) all route
  // through one handler, handleAction, which figures out what to do from the name.
  ed.querySelectorAll("[data-action]").forEach((node) => {
    node.addEventListener("click", () => handleAction(node.dataset.action, node.dataset.arg, node));
  });

  // Live filter for the "dishes in this tag" list (keeps focus, no re-render).
  const ms = $("#membSearch");
  if (ms) ms.oninput = () => {
    const q = ms.value.toLowerCase();
    ed.querySelectorAll(".memb-row").forEach((row) => {
      row.style.display = !q || row.dataset.memb.includes(q) ? "" : "none";
    });
  };
}

// handleAction: the one place that handles all the small "edit the form" buttons.
// The `action` name (set as data-action in the HTML) decides what happens — adding
// or removing ingredients, reviews, option groups/choices, toggling tags/allergens,
// etc. After changing state.sel it re-renders the form (keeping the scroll position).
function handleAction(action, arg, node) {
  const it = state.sel;
  if (action === "toggleMember") { toggleTagMembership(it.slug, arg, node); return; }
  if (action === "toggleSoldOut") {
    it.tags = it.tags || [];
    const i = it.tags.indexOf("sold-out");
    if (i >= 0) it.tags.splice(i, 1); else it.tags.push("sold-out");
  } else
  if (action === "addIngredient") (it.ingredients = it.ingredients || []).push({ emoji: "", name: "" });
  else if (action === "rmIngredient") it.ingredients.splice(Number(arg), 1);
  else if (action === "addReview") (it.reviews = it.reviews || []).push({ name: "", rating: 5, text: "" });
  else if (action === "rmReview") it.reviews.splice(Number(arg), 1);
  else if (action === "toggleTag") {
    it.tags = it.tags || [];
    const i = it.tags.indexOf(arg);
    if (i >= 0) it.tags.splice(i, 1); else it.tags.push(arg);
  } else if (action === "toggleAllergen") {
    it.allergens = it.allergens || [];
    const i = it.allergens.indexOf(arg);
    if (i >= 0) it.allergens.splice(i, 1); else it.allergens.push(arg);
  } else if (action === "addOptGroup") {
    (it.options = it.options || []).push({ name: "", type: "single", choices: [{ label: "", price: 0 }] });
  } else if (action === "rmOptGroup") {
    it.options.splice(Number(arg), 1);
  } else if (action === "addOptChoice") {
    const g = it.options[Number(arg)];
    (g.choices = g.choices || []).push({ label: "", price: 0 });
  } else if (action === "rmOptChoice") {
    const [gi, ci] = arg.split(".").map(Number);
    it.options[gi].choices.splice(ci, 1);
  }
  // Re-draw the form to show the change, but remember and restore the scroll
  // position so the page doesn't jump to the top after every little edit.
  const ed = $("#editor");
  const sc = ed.scrollTop;
  renderEditor();
  ed.scrollTop = sc;
}

// Add/remove a tag on an existing dish from the Filters tab, then save that dish.
// Updates the UI in place (no full re-render) so the search box keeps focus.
async function toggleTagMembership(filterSlug, dishId, inputEl) {
  const dish = (state.data.items || []).find((d) => d.id === dishId);
  if (!dish || !filterSlug) return;
  dish.tags = dish.tags || [];
  const i = dish.tags.indexOf(filterSlug);
  const adding = i < 0;
  if (adding) dish.tags.push(filterSlug);
  else dish.tags.splice(i, 1);
  const row = inputEl && inputEl.closest(".memb-row");
  if (row) row.classList.toggle("on", adding);
  updateMembCount(filterSlug);
  try {
    const payload = { ...dish };
    delete payload.created_at;
    delete payload.updated_at;
    await api("POST", "/items", payload);
    toast(`${dish.title}: ${adding ? "added to" : "removed from"} "${filterSlug}"`, "ok");
  } catch (e) {
    // revert on failure
    if (adding) dish.tags.splice(dish.tags.indexOf(filterSlug), 1);
    else dish.tags.push(filterSlug);
    if (inputEl) inputEl.checked = !adding;
    if (row) row.classList.toggle("on", !adding);
    updateMembCount(filterSlug);
    toast("Save failed: " + e.message, "err");
  }
}
// updateMembCount: refresh the "· N selected" counter next to a tag's dish list.
function updateMembCount(filterSlug) {
  const el2 = document.getElementById("membCount");
  if (el2) el2.textContent = (state.data.items || []).filter((d) => (d.tags || []).includes(filterSlug)).length;
}

// ---------- save / delete ----------
// save: send the currently-edited record to the server (create or update), show a
// toast, reload everything, then re-select the freshly-saved row. Refuses to save
// if the required key (id or slug) is missing.
async function save() {
  const it = state.sel;
  const kind = state.tab === "general" ? "settings" : state.tab; // which table to write to
  const keyField = (state.tab === "items" || state.tab === "general") ? "id" : "slug"; // its unique-key column
  // New dish: if the id (permanent key) or slug (URL) weren't filled in, derive
  // them from the title so adding a dish never fails for a missing key. You only
  // have to type a name. (Editing keeps the existing id/slug untouched.)
  if (state.tab === "items" && state.isNew) {
    const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!it.slug && it.title) it.slug = slugify(it.title);
    if (!it.id) it.id = it.slug || slugify(it.title);
  }
  if (state.tab === "items" && !it.title) { toast("Give the dish a name first", "err"); return; }
  if (!it[keyField]) { toast(`${keyField === "id" ? "ID" : "Slug"} is required`, "err"); return; }
  if (state.tab === "items" && !it.slug) { toast("Slug is required", "err"); return; }

  // Copy the record but drop the timestamps — the database manages those itself.
  const payload = { ...it };
  delete payload.created_at;
  delete payload.updated_at;
  try {
    const key = recKey(it);
    await api("POST", "/" + kind, payload);
    toast("Saved ✓", "ok");
    await loadAll();
    if (state.tab === "general") {
      state.sel = clone(state.data.settings || it);
    } else {
      const fresh = records().find((r) => recKey(r) === key);
      state.sel = fresh ? clone(fresh) : null;
    }
    state.isNew = false;
    renderList();
    renderEditor();
  } catch (e) {
    toast("Save failed: " + e.message, "err");
  }
}

// removeRecord: permanently delete the currently-selected dish/category/filter.
async function removeRecord() {
  const it = state.sel;
  // Use the app's own styled confirm dialog (every other delete does), not the
  // browser's plain native popup — keeps the look consistent.
  if (!(await confirmDialog(`Delete "${recLabel(it)}"? This can't be undone.`, "Delete"))) return;
  try {
    await api("DELETE", "/" + state.tab + "/" + encodeURIComponent(recKey(it)));
    toast("Deleted", "ok");
    state.sel = null;
    state.isNew = false;
    await loadAll();
    renderEditor();
  } catch (e) {
    toast("Delete failed: " + e.message, "err");
  }
}

// ---------- v2 dining sessions: live board ----------
// membersOf / itemsOf: pull just the members (or ordered items) that belong to a
// given session id, out of the whole board we loaded.
const membersOf = (sid) => (state.board.members || []).filter((m) => m.session_id === sid);
const itemsOf = (sid) => (state.board.items || []).filter((i) => i.session_id === sid);
// timeAgo: turn a timestamp into friendly text like "just now" / "5m ago" / "2h ago".
function timeAgo(ts) {
  if (!ts) return "";
  const d = (Date.now() - new Date(ts).getTime()) / 1000; // seconds since then
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return Math.floor(d / 86400) + "d ago";
}

// Fetch the whole board in one call. `fromPoll` = silent (no error toast, and don't
// stomp the editor while the owner is typing in an input).
let lastBoardSig = ""; // last rendered board fingerprint — skip needless re-renders on poll

// ── Serve debounce ───────────────────────────────────────────────────────────
// Marking dishes served one-by-one USED to refetch the whole board (3 network
// GETs) and redraw on EVERY click — so serving 1,2,3,4,5… felt laggy and the
// 1-second poll redrew on top of it. Now each serve click updates the board
// LOCALLY and redraws instantly (no network), and we do ONE real server
// reconcile only after you've STOPPED clicking for 5 seconds. While that flush
// is pending, the background poll leaves the open panel alone so it can't redraw
// under your fingers. (The click still saves to the server immediately — it's
// only the refetch/redraw that waits.)
let serveFlushTimer = null;
const SERVE_FLUSH_MS = 5000;
function scheduleServeFlush() {
  if (serveFlushTimer) clearTimeout(serveFlushTimer);
  serveFlushTimer = setTimeout(() => { serveFlushTimer = null; loadSessions(); }, SERVE_FLUSH_MS);
}
function serveFlushPending() { return serveFlushTimer != null; }

// loadSessions: fetch (or reuse) the live tables board and redraw the floor. The
// `fromPoll` flag means "this was the automatic 1-second refresh", so we stay quiet
// (no error toast) and avoid redrawing while the owner is typing or clicking.
async function loadSessions(fromPoll) {
  // On a manual/action refresh we fetch fresh data; on a poll tick pollOrders has
  // already refreshed state.board/orders/calls, so we just render from it (no
  // double round-trip).
  if (!fromPoll) {
    try {
      let [board, orders, calls] = await Promise.all([api("GET", "/sessions"), api("GET", "/orders"), api("GET", "/calls")]);
      // Same shields the 1-second poll uses (see pollOrders). One action's
      // refresh must not wipe ANOTHER action's optimistic state while that
      // save is still travelling — e.g. opening tables 1, 2, 3 quickly:
      // table 1's refresh used to land before the server had processed
      // table 3, flickering tile 3 back to "Free" for a split second.
      // Keep local order rows whose saves are in flight, keep optimistic
      // deletes gone, and only take the server's board once NO floor action
      // is mid-save (the last one to finish reconciles everything).
      orders = orders
        .filter((o) => !pendingDeletes.has(o.id))
        .map((o) => (pendingOrderOps.has(o.id) ? ((state.data.orders || []).find((x) => x.id === o.id) || o) : o));
      if (!floorOpsInFlight) state.board = board;
      state.data.orders = orders; state.data.calls = calls;
      state.boardLoaded = true; // the live board has arrived at least once → real tiles, not the skeleton
    } catch (e) {
      toast("Could not load tables: " + e.message, "err");
      return;
    }
  }
  if (state.tab !== "tables") return;
  const board = state.board || {}, orders = state.data.orders || [], calls = state.data.calls || [];
  // Only touch the DOM when something actually changed, so a background poll never
  // flashes the floor or the open panel (and never steals a click mid-tick).
  const openCalls = (calls || []).filter((c) => !c.resolved).map((c) => c.id).join(",");
  // "sig" is a fingerprint of everything on the board. If a poll arrives and the
  // fingerprint hasn't changed, there's literally nothing new — so skip the redraw.
  const sig = JSON.stringify(board) + "|" + JSON.stringify(orders) + "|" + openCalls;
  if (fromPoll && sig === lastBoardSig) return;
  lastBoardSig = sig;
  const ed = $("#editor");
  // Don't yank the floor out from under the owner mid-edit: if they're typing in a
  // field during a background poll, hold off on the full redraw.
  const typing = document.activeElement && ed.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (!fromPoll || !typing) renderEditor();
  renderTablePanel(); // refresh the open table panel, if any
}

// ---- session staff actions ----
// Each of these calls the server, then reloads the board and shows a toast. They
// all follow the same shape: do the action, refresh, confirm (or report a failure).

// flipOrderItems: locally mark every dish row of an order — the optimistic
// half of the quick actions; the server is told right after in the background.
function flipOrderItems(o, from, to) {
  (state.board.items || []).forEach((it) => { if (it.order_id === o.id && (!from || it.status === from)) it.status = to; });
  (o.items || []).forEach((it) => { if (!from || (it.status || "received") === from) it.status = to; });
}

// openTableSession: open (seat) a table so its guests can order.
// OPTIMISTIC: the tile flips to "Open" instantly via a temporary local
// session; the follow-up refresh swaps in the server's real one.
async function openTableSession(table) {
  const t = String(table);
  const pending = { id: "pending-" + t, table_number: t, status: "open", auto_approve: false };
  state.board.sessions = [...(state.board.sessions || []), pending];
  floorOpsInFlight++;
  loadSessions(true); // render-only, no network
  try { await api("POST", "/sessions/open", { table: t }); floorOpsInFlight--; await loadSessions(); toast("Table opened", "ok"); }
  catch (e) {
    floorOpsInFlight--;
    state.board.sessions = (state.board.sessions || []).filter((s) => s.id !== pending.id); // undo
    loadSessions(true);
    toast("Could not open: " + e.message, "err");
  }
}
// openAllTables: seat every table that isn't open yet, in one go (asks first).
async function openAllTables() {
  const n = Math.max(1, parseInt((state.data.settings || {}).table_count, 10) || 12);
  const targets = [];
  for (let i = 1; i <= n; i++) if (!openSessionForTable(String(i))) targets.push(String(i));
  if (!targets.length) return toast("Every table is already open", "ok");
  if (!(await confirmDialog(`Open all ${targets.length} remaining table${targets.length > 1 ? "s" : ""}?`, "Open all"))) return;
  // Fire the opens in parallel; count what failed instead of stopping halfway.
  const results = await Promise.allSettled(targets.map((t) => api("POST", "/sessions/open", { table: t })));
  const failed = results.filter((r) => r.status === "rejected").length;
  await loadSessions();
  toast(failed ? `Opened ${targets.length - failed}, ${failed} failed` : `Opened ${targets.length} table${targets.length > 1 ? "s" : ""}`, failed ? "err" : "ok");
}
// closeAllTables: end EVERY open session at once (asks first — guests at those
// tables can no longer order until reopened).
async function closeAllTables() {
  const open = (state.board.sessions || []).filter((s) => s.status === "open");
  if (!open.length) return toast("No open tables", "ok");
  // Floor-wide = the scary red confirm (see confirmDialog), so it can't be
  // mistaken for the routine one-table popup when speed-clicking.
  if (!(await confirmDialog(`Close ALL ${open.length} open table${open.length > 1 ? "s" : ""}? Guests at them can't order until reopened.`, `Close all ${open.length}`, { floorwide: true }))) return;
  const tables = open.map((s) => String(s.table_number)); // remembered for UNDO
  const results = await Promise.allSettled(open.map((s) => api("POST", "/sessions/" + s.id + "/close")));
  const failed = results.filter((r) => r.status === "rejected").length;
  await loadSessions();
  if (failed) return toast(`Closed ${open.length - failed}, ${failed} failed`, "err");
  // Gmail-style safety net: 8 seconds to take it back. UNDO reopens the same
  // table numbers (fresh sessions — guests who were seated stay disconnected).
  toast(`Closed ${tables.length} table${tables.length > 1 ? "s" : ""}`, "ok", {
    label: "UNDO",
    fn: async () => {
      await Promise.allSettled(tables.map((tb) => api("POST", "/sessions/open", { table: tb })));
      await loadSessions();
      toast(`Reopened ${tables.length} table${tables.length > 1 ? "s" : ""}`, "ok");
    },
  }, 8000);
}
// closeSession: end a table's session (after confirming).
async function closeSession(id) {
  if (!(await confirmDialog("Close this session? Guests at this table can no longer order or call until it's reopened.", "Close session"))) return;
  // Which table is this? We archive its orders too, so closing clears the floor.
  const sess = (state.board.sessions || []).find((s) => s.id === id);
  const t = sess ? String(sess.table_number).trim() : null;
  try {
    await api("POST", "/sessions/" + id + "/close");
    // Closing the table clears its orders OFF the floor. UNFINISHED orders
    // (received/preparing) are CANCELLED — the meal's over, they won't be made,
    // and the guest's app then shows "Order cancelled". Already-SERVED orders are
    // kept as completed bills. Either way they're archived → Previous orders, and
    // the tile goes back to Free (the bug was a closed table still showing them).
    if (t) {
      const live = (state.data.orders || []).filter((o) => !o.archived && (o.table_number || "").trim() === t);
      for (const o of live) {
        const patch = o.status === "served" ? { archived: true } : { status: "cancelled", archived: true };
        await api("PATCH", "/orders/" + o.id, patch);
        o.archived = true; if (o.status !== "served") o.status = "cancelled";
      }
    }
    state.openSess = null; document.querySelector(".sx-modal-overlay")?.remove();
    await loadSessions();
    toast("Table closed — bill moved to Previous", "ok");
  } catch (e) { toast("Could not close: " + e.message, "err"); }
}
// setSessAutoApprove: turn on/off "let new joiners in automatically" for a table.
async function setSessAutoApprove(id, value) {
  try { await api("POST", "/sessions/" + id + "/auto-approve", { value: !!value }); await loadSessions(); toast(value ? "Auto-approve on" : "Auto-approve off", "ok"); }
  catch (e) { toast("Failed: " + e.message, "err"); }
}
// memberAction: approve a waiting guest, or remove one from the table.
async function memberAction(id, kind) {
  try { await api("POST", "/members/" + id + "/" + (kind === "approve" ? "approve" : "remove")); await loadSessions(); toast(kind === "approve" ? "Approved" : "Removed", "ok"); }
  catch (e) { toast("Failed: " + e.message, "err"); }
}
// Kick = remove now (works for the head too; the table stays open). Ban = kick +
// add to the blocklist (by member id, and phone if we have one).
async function kickMember(id) {
  if (!(await confirmDialog("Kick this guest from the table? Their access ends now — the table stays open.", "Kick"))) return;
  try { await api("POST", "/members/" + id + "/remove"); await loadSessions(); toast("Kicked", "ok"); }
  catch (e) { toast("Failed: " + e.message, "err"); }
}
async function banMember(id, phone) {
  if (!(await confirmDialog("Ban this guest? They're kicked now and added to the blocklist.", "Ban"))) return;
  try {
    await api("POST", "/blocklist", { member_id: id, phone: phone || undefined });
    await api("POST", "/members/" + id + "/remove");
    await loadSessions(); toast("Banned", "ok");
  } catch (e) { toast("Failed: " + e.message, "err"); }
}
// itemStatus: move one session item forward (received → preparing → served).
// Saves to the server right away, then updates the board LOCALLY and redraws
// instantly (no refetch). The real reconcile happens 5s after the last click —
// see scheduleServeFlush — so serving several dishes in a row stays smooth.
async function itemStatus(id, status) {
  try {
    await api("POST", "/items/" + id + "/status", { status });   // persist now
    const it = (state.board.items || []).find((i) => i.id === id); // optimistic local update
    if (it) it.status = status;
    renderTablePanel();                                            // instant redraw from local state
    scheduleServeFlush();                                          // one real refresh after you stop clicking
  } catch (e) { toast("Failed: " + e.message, "err"); }
}
// resolveRequest: approve or dismiss a queued "let me in / open this table" request.
// OPTIMISTIC: the request row leaves the queue instantly; the real refresh
// afterwards brings in whatever the approval created (e.g. the new session).
async function resolveRequest(id, status) {
  const before = state.board.requests || [];
  state.board.requests = before.filter((r) => r.id !== id);
  floorOpsInFlight++;
  loadSessions(true);
  try { await api("POST", "/requests/" + id + "/resolve", { status }); floorOpsInFlight--; await loadSessions(); toast(status === "approved" ? "Approved" : "Dismissed", "ok"); }
  catch (e) { floorOpsInFlight--; state.board.requests = before; loadSessions(true); toast("Failed: " + e.message, "err"); }
}
// block: add a phone/table to the blocklist (opts says which).
async function block(opts) {
  try { await api("POST", "/blocklist", opts); await loadSessions(); toast("Blocked", "ok"); }
  catch (e) { toast("Could not block: " + e.message, "err"); }
}
// unblock: remove an entry from the blocklist.
async function unblock(id) {
  try { await api("DELETE", "/blocklist/" + id); await loadSessions(); toast("Unblocked", "ok"); }
  catch (e) { toast("Could not unblock: " + e.message, "err"); }
}
// attendCall: mark a waiter call as handled.
// OPTIMISTIC: the row leaves the "Needs" list (and the tile emoji) instantly.
async function attendCall(id) {
  const before = state.data.calls || [];
  state.data.calls = before.filter((c) => c.id !== id);
  floorOpsInFlight++;
  loadSessions(true);
  try { await api("PATCH", "/calls/" + id, { resolved: true }); toast("Marked attended", "ok"); }
  catch (e) { state.data.calls = before; loadSessions(true); toast("Failed: " + e.message, "err"); }
  finally { floorOpsInFlight--; }
}

// ===================== UNIFIED FLOOR — one control center for every table =====================
// One map; tap a table to open ONE panel that does it all: open the table, take & advance
// orders (per-item when it's a session, order-level otherwise), manage guests, attend calls,
// see the bill, mark paid, and free the table. Works whether dining sessions are on or off.

// Five quick lookups used all over the unified floor — each filters the loaded
// data down to one table (or one order):
const ordersForTable = (t) => {
  const list = (state.data.orders || []).filter((o) => !o.archived && (o.table_number || "").trim() === String(t)); // live orders at table t
  const sessionsOn = !!(state.data.settings || {}).sessions_enabled;
  // If sessions are ON and this table has NO open session, any leftover non-archived
  // orders belong to a CLOSED session (stale) — the meal's over, nobody's there. Don't
  // paint the tile with them; the table is Free. (Same guard callsForTable uses, so a
  // closed table can never keep showing "Preparing"/"Served" from an old order.)
  if (sessionsOn && !openSessionForTable(t)) return [];
  return list;
};
const openSessionForTable = (t) => (state.board.sessions || []).find((s) => String(s.table_number) === String(t) && s.status === "open"); // t's open session
// Open (unresolved) waiter calls at table t. Safety net: when dining sessions are
// ON, a call only counts while the table is actually OPEN — so a free/closed table
// can never show a lingering "call" badge even if a stale row slipped through.
const callsForTable = (t) => {
  const list = (state.data.calls || []).filter((c) => !c.resolved && (c.table_number || "").trim() === String(t));
  const sessionsOn = !!(state.data.settings || {}).sessions_enabled;
  if (sessionsOn && !openSessionForTable(t)) return [];
  return list;
};
const reqsForTable = (t) => (state.board.requests || []).filter((r) => String(r.table_number) === String(t)); // pending "let me in" requests for t
const itemsForOrder = (oid) => (state.board.items || []).filter((i) => i.order_id === oid); // the session items belonging to one order

// Per-item rows for an order, unified: session order_items if present, else the items JSON.
function orderItemRows(o) {
  const rows = itemsForOrder(o.id);
  // Carry options/removed/note through so the table panel can show the full
  // customization (what the guest chose, what to leave out) — not just the name.
  if (rows.length) return rows.map((it) => ({ kind: "session", id: it.id, title: it.title, qty: it.qty, status: it.status, options: it.options, removed: it.removed, note: it.note }));
  return (o.items || []).map((it, idx) => ({ kind: "legacy", orderId: o.id, idx, title: it.title, qty: it.qty, status: it.status || "received", options: it.options, removed: it.removed, note: it.note }));
}

// What the guest tapped, as an emoji for the tile / call list.
function callEmoji(note) {
  const n = (note || "").toLowerCase();
  if (n.includes("water")) return "💧";
  if (n.includes("cutlery") || n.includes("fork") || n.includes("spoon")) return "🍴";
  if (n.includes("napkin")) return "🧻";
  if (n.includes("clean")) return "🧹";
  if (n.includes("bill") || n.includes("check") || n.includes("cheque")) return "🧾";
  return "🙋";
}

// One tile's state — every situation gets its OWN colour (free/seated/new/prep/bill/done).
// Given a table number, this works out everything the tile needs: its colour (st),
// its label/sub-label, the little corner badges (requests, joiners, cart, calls),
// whether the outline should be red (unpaid) or green (paid), and a few flags the
// floor uses to decide which quick-action button to show.
function tableTileState(t) {
  const os = ordersForTable(t);
  const sess = openSessionForTable(t);
  const mem = sess ? membersOf(sess.id) : [];
  const pending = mem.filter((m) => !m.approved).length;
  const cart = sess && Array.isArray(sess.cart) ? sess.cart : []; // shared cart being built, not yet ordered
  const cartCount = cart.reduce((a, it) => a + (parseInt(it.qty, 10) || 1), 0);
  const calls = callsForTable(t);
  const reqs = reqsForTable(t); // pending open/join/access requests (guest asked staff to let them in)
  const items = os.flatMap((o) => orderItemRows(o));
  const anyReceived = items.some((i) => i.status === "received");
  const anyPreparing = items.some((i) => i.status === "preparing");
  // An order only becomes an "unpaid bill" (red outline) once it's ACCEPTED. A
  // brand-new order still sitting at "received" hasn't been confirmed by staff
  // yet, so it shouldn't flag the table red — that starts when you accept it.
  const isUnpaidBill = (o) => o.status !== "cancelled" && o.status !== "received" && o.payment_status !== "paid";
  const unpaid = os.some(isUnpaidBill);
  const due = os.filter(isUnpaidBill).reduce((s, o) => s + (parseFloat(o.total) || 0), 0);

  let st = "free", label = "Free", meta = "tap to open";
  if (os.length) {
    if (anyReceived) { st = "new"; label = "New order"; }
    else if (anyPreparing) { st = "prep"; label = "Preparing"; }
    // No separate "Bill due" fill anymore (owner, 2026-06-10): payment is
    // already told by the OUTLINE (red = unpaid, green = paid), so a fully
    // served table just says "Served" until it's paid, then "Cleared".
    else if (unpaid) { st = "done"; label = "Served"; }
    else { st = "done"; label = "Cleared"; }
    const served = items.filter((i) => i.status === "served").length;
    meta = items.length ? `${served}/${items.length} served${due > 0 ? ` · ${inr(due)} due` : ""}` : `${os.length} order${os.length > 1 ? "s" : ""}`;
  } else if (sess) {
    st = "seated"; label = mem.length ? `Seated · ${mem.length}` : "Open";
    // The building cart is intentionally NOT shown on the tile — staff see it only
    // when they open the table panel. So the tile just shows the seated state.
    meta = mem.length ? "no orders yet" : "waiting for guests";
  } else if (reqs.length) {
    // free table, but a guest is asking to be let in -> make it shout for attention
    st = "req"; label = "Wants in";
    meta = reqs[reqs.length - 1].type === "open" ? "asked to open" : "asked for access";
  }
  let badges = "";
  if (reqs.length) badges += `<span class="ftb req">📨${reqs.length}</span>`;
  if (pending) badges += `<span class="ftb join">🙋${pending}</span>`;
  // One emoji per ACTIVE waiter call (water 💧, napkins 🧻, clean 🧹…), up to 3,
  // then a "+N" pill if there are more. The cart is deliberately NOT badged here.
  calls.slice(0, 3).forEach((c) => { badges += `<span class="ftb call">${callEmoji(c.note)}</span>`; });
  if (calls.length > 3) badges += `<span class="ftb call ftb-more">+${calls.length - 3}</span>`;
  return {
    st, label, meta, badges,
    // Outline = payment, but ONLY once an order is accepted: red = an accepted
    // unpaid bill, green = accepted & fully paid, none = nothing accepted yet (a
    // brand-new "received" order shows no pay ring until staff accepts it).
    pay: unpaid ? "red" : (os.some((o) => o.status !== "cancelled" && o.status !== "received" && o.payment_status === "paid") ? "green" : ""),
    done: st === "done" && !unpaid, // served AND paid → offer RST/CLS (never free an unpaid table)
    hasNew: anyReceived,        // a new order waiting to be accepted
    hasCall: calls.length > 0,
    hasReq: reqs.length > 0,    // a guest is waiting to be let in
  };
}

// floorHtml: build the whole unified floor — the grid of table tiles on the left
// (with a legend and on-tile quick buttons) and a side panel on the right holding
// the session toggles, café location, requests queue and blocklist.
function floorHtml() {
  const s = state.data.settings || {};
  const sessionsOn = !!s.sessions_enabled;
  // Number of tables to draw. On the very FIRST paint the settings haven't
  // loaded yet, so without help we'd default to 12 and then jump to the real 13
  // a moment later — a visible "one tile forms, then another" flicker in the
  // skeleton. Fix: remember the real count in localStorage and use it as the
  // default, so the skeleton starts at the right size. (Falls back to 12 only
  // on a browser that has never loaded this editor.)
  let cachedN = parseInt(localStorage.getItem("lfh_editor_table_count"), 10);
  if (!Number.isFinite(cachedN) || cachedN < 1) cachedN = 12;
  const n = Math.max(1, parseInt(s.table_count, 10) || cachedN);
  if (s.table_count) { try { localStorage.setItem("lfh_editor_table_count", String(parseInt(s.table_count, 10))); } catch {} }
  const reqs = state.board.requests || [];
  const blocks = state.board.blocklist || [];

  // legend — every state + its colour. ("Bill due" was removed: payment is
  // already shown by the red/green outline, so a fill colour for it was noise.)
  const LEG = [["free", "Free"], ["req", "Wants in"], ["seated", "Seated"], ["new", "New order"], ["prep", "Preparing"]];
  const legend = `<div class="floor-legend"><span class="lgcap">inside:</span>${LEG.map(([k, v]) => `<span class="lgi"><i class="ldot ldot-${k}"></i>${v}</span>`).join("")}<span class="lgi"><i class="ldot ldot-call">🔔</i>called</span><span class="lgcap">outline:</span><span class="lgi"><i class="lring lring-red"></i>unpaid</span><span class="lgi"><i class="lring lring-green"></i>paid</span></div>`;

  // FIRST PAINT before the live board has arrived: show a shimmer skeleton sized
  // to the real table count, instead of briefly drawing every table as "Free"
  // (that looked like the whole floor had reset on every refresh). The board
  // loads a moment later — boardLoaded flips true — and the real tiles replace
  // this. Mirrors the menu's loading skeleton so the two screens feel the same.
  if (!state.boardLoaded) {
    // left: a shimmer tile per table, sized to the (cached) real count.
    let skel = "";
    for (let i = 1; i <= n; i++) {
      skel += `<div class="ftile ftile-skel" aria-hidden="true"><div class="sk-num"></div><div class="sk-lbl"></div><div class="sk-meta"></div></div>`;
    }
    const skelMain = `<div class="floor-main"><div class="ed-head"><h2>Tables <span class="sub">· live floor</span></h2><button class="btn" id="refreshFloor">↻ Refresh</button></div>${legend}<div class="ftile-grid">${skel}</div></div>`;
    // right: skeleton versions of the side-panel cards so the whole layout is
    // present from the first frame (no empty gutter that fills in late). A card
    // = a title bar + a few placeholder rows of shimmer.
    const skRow = `<div class="sk-row"></div>`;
    const skCard = (titleW, rows) => `<div class="fc-card fc-card-skel"><div class="sk-cardtitle" style="width:${titleW}"></div>${skRow.repeat(rows)}</div>`;
    const sideW = state.floorSideW || 300;
    const skelSide = `<aside class="floor-side" style="width:${sideW}px;flex:0 0 ${sideW}px">${skCard("46%", 4)}${skCard("38%", 2)}${skCard("34%", 2)}</aside>`;
    return `<div class="floor-wrap">${skelMain}<div class="floor-resizer"></div>${skelSide}</div>`;
  }

  let tiles = "";
  for (let i = 1; i <= n; i++) {
    const { st, label, meta, badges, pay, done, hasNew, hasCall } = tableTileState(i); // everything this tile needs
    // quick action(s) on the tile itself — no need to open the detail view.
    // Show the ONE button that matches the table's situation right now.
    let quick = "";
    if ((st === "free" || st === "req") && sessionsOn) quick = `<button class="btn small primary ftq" data-quick-open="${i}">Open</button>`;
    else if (hasNew) quick = `<button class="btn small primary ftq" data-quick-accept="${i}">Accept</button>`;
    else if (done) quick = `<div class="ft-quick2"><button class="btn small ftq2" data-quick-restart="${i}" title="Restart — clear orders, keep table open">RST</button><button class="btn small primary ftq2" data-quick-close="${i}" title="Close & free the table">CLS</button></div>`;
    else if (hasCall) quick = `<button class="btn small ftq" data-quick-attend="${i}">Attend</button>`;
    // A faint chair watermark marks an OFF/free table (an empty seat) — a quiet,
    // premium cue that the table is available.
    const offIcon = st === "free" ? `<i class="fas fa-chair ft-officon" aria-hidden="true"></i>` : "";
    tiles += `<div class="ftile ft-${st}${pay ? " pay-" + pay : ""}" data-floor-table="${i}" role="button" tabindex="0">
        ${offIcon}
        <div class="ft-top"><span class="ft-num">${i}</span>${badges ? `<span class="ft-badges">${badges}</span>` : ""}</div>
        <div class="ft-label">${esc(label)}</div><div class="ft-meta">${esc(meta)}</div>
        ${quick ? `<div class="ft-quick">${quick}</div>` : ""}</div>`;
  }
  // The header keeps ONLY the safe Refresh button. Open all / Close all used to
  // sit right beside it, styled the same — one fast click aimed at Refresh once
  // closed the entire floor (owner hit this 2026-06-11). They now live in the
  // side panel's "Dining sessions" card, well away from the speed-click zone.
  const main = `<div class="floor-main"><div class="ed-head"><h2>Tables <span class="sub">· live floor</span></h2><button class="btn" id="refreshFloor">↻ Refresh</button></div>${legend}<div class="ftile-grid">${tiles}</div></div>`;

  // side panel — session controls + café location + requests + blocklist (all here, not in General)
  const tgl = (label, key) => `<label class="fc-toggle"><input type="checkbox" data-setting="${key}" ${s[key] ? "checked" : ""}/><span class="fc-sw"></span><span>${label}</span></label>`;
  const controls = `<div class="fc-card">
      <h3>Dining sessions</h3>
      ${tgl("System ON", "sessions_enabled")}
      <div class="fc-sub"${sessionsOn ? "" : " hidden"}>${tgl("Require location", "require_location")}${tgl("Require code", "require_otp")}</div>
      ${sessionsOn ? `<h4>Whole floor</h4><div class="fc-bulk"><button class="btn small" id="floorOpenAll">⬆ Open all</button><button class="btn small danger" id="floorCloseAll">⬇ Close all</button></div>` : ""}
      <h4>Café location</h4>
      <div class="fc-geo">
        <label class="fc-field"><span>Latitude (north–south)</span><input class="sx-input" id="fcLat" placeholder="e.g. 23.0274" value="${s.geo_lat ?? ""}"/></label>
        <label class="fc-field"><span>Longitude (east–west)</span><input class="sx-input" id="fcLng" placeholder="e.g. 72.4726" value="${s.geo_lng ?? ""}"/></label>
        <label class="fc-field"><span>Radius (metres)</span><input class="sx-input" id="fcRad" placeholder="e.g. 250" value="${s.geo_radius_m ?? 250}"/></label>
      </div>
      <button class="btn small primary" id="fcSaveGeo">Save location</button></div>`;

  const reqCard = sessionsOn ? `<div class="fc-card"><h3>Requests <span class="sub">· ${reqs.length}</span></h3>${reqs.length ? reqs.map((r) => {
    const who = esc(r.name || r.phone || "Someone");
    const what = r.type === "open" ? `open T${esc(r.table_number)}` : r.type === "join" ? `join T${esc(r.table_number)}` : `access T${esc(r.table_number)}`;
    return `<div class="sx-req"><div class="sx-req-info"><span class="sx-tag sx-tag-${esc(r.type)}">${esc(r.type)}</span> ${who} · ${what}<small>${esc(timeAgo(r.created_at))}</small></div><div class="sx-req-actions"><button class="btn small" data-req-deny="${esc(r.id)}">✕</button><button class="btn small primary" data-req-approve="${esc(r.id)}">${r.type === "open" ? "Open" : "OK"}</button></div></div>`;
  }).join("") : `<div class="sx-empty">No pending requests.</div>`}</div>` : "";

  // Active waiter calls across all OPEN tables (water/napkin/clean…), one row each.
  // This stays in sync with the tile emojis — both read state.data.calls and refresh
  // on the same 1s poll, and "Done" here resolves the same call the tile shows.
  const liveCalls = (state.data.calls || []).filter((c) => !c.resolved && openSessionForTable((c.table_number || "").trim()));
  const needsCard = sessionsOn ? `<div class="fc-card"><h3>Needs <span class="sub">· ${liveCalls.length}</span></h3>${liveCalls.length ? liveCalls.map((c) =>
    `<div class="sx-req"><div class="sx-req-info">${callEmoji(c.note)} T${esc(c.table_number)} · ${esc(c.note || "Waiter")}<small>${esc(timeAgo(c.created_at))}</small></div><div class="sx-req-actions"><button class="btn small primary" data-call-attend="${esc(c.id)}">Done</button></div></div>`
  ).join("") : `<div class="sx-empty">No active calls.</div>`}</div>` : "";

  const blkCard = sessionsOn ? `<div class="fc-card"><h3>Blocked <span class="sub">· ${blocks.length}</span></h3>${blocks.length ? blocks.map((b) => `<div class="sx-blk"><span>${b.phone ? "📵 " + esc(b.phone) : "🚫 T" + esc(b.table_number)}</span><button class="btn small" data-unblock="${esc(b.id)}">Unblock</button></div>`).join("") : `<div class="sx-empty">Nobody blocked.</div>`}<div class="sx-blk-add"><input class="sx-input" id="blkPhone" placeholder="Phone/email"/><input class="sx-input sx-input-sm" id="blkTable" placeholder="T#"/><button class="btn small" id="blkAdd">Block</button></div></div>` : "";

  const sideW = state.floorSideW || 300;
  return `<div class="floor-wrap">${main}<div class="floor-resizer" id="floorResizer" title="Drag to resize"></div><aside class="floor-side" style="width:${sideW}px;flex:0 0 ${sideW}px">${controls}${reqCard}${needsCard}${blkCard}</aside></div>`;
}

// bindFloor: wire up the unified floor after it's drawn — clicking a tile opens
// its detail panel, the on-tile quick buttons do their one action, the side panel
// toggles save settings, and the divider can be dragged to resize the side panel.
function bindFloor() {
  const ed = $("#editor");
  const rb = document.getElementById("refreshFloor");
  if (rb) rb.onclick = () => loadSessions();
  // Bulk open/close for the whole floor (both confirm before acting).
  const oa = document.getElementById("floorOpenAll");
  if (oa) oa.onclick = () => openAllTables();
  const ca = document.getElementById("floorCloseAll");
  if (ca) ca.onclick = () => closeAllTables();
  ed.querySelectorAll("[data-floor-table]").forEach((t) => (t.onclick = () => openTablePanel(t.dataset.floorTable))); // tap a tile → open its panel
  // quick actions on the tile itself — stopPropagation so they don't also open the detail panel
  ed.querySelectorAll("[data-quick-open]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openTableSession(b.dataset.quickOpen); }));
  ed.querySelectorAll("[data-quick-accept]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); acceptTableOrders(b.dataset.quickAccept); }));
  ed.querySelectorAll("[data-quick-attend]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); attendTableCalls(b.dataset.quickAttend); }));
  ed.querySelectorAll("[data-quick-restart]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); restartTable(b.dataset.quickRestart); }));
  ed.querySelectorAll("[data-quick-close]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); closeTableQuick(b.dataset.quickClose); }));
  ed.querySelectorAll("[data-req-approve]").forEach((b) => (b.onclick = () => resolveRequest(b.dataset.reqApprove, "approved")));
  ed.querySelectorAll("[data-req-deny]").forEach((b) => (b.onclick = () => resolveRequest(b.dataset.reqDeny, "denied")));
  ed.querySelectorAll("[data-unblock]").forEach((b) => (b.onclick = () => unblock(b.dataset.unblock)));
  // The "Needs" card's Done buttons resolve a single waiter call (in sync with the tiles).
  ed.querySelectorAll("[data-call-attend]").forEach((b) => (b.onclick = () => attendCall(b.dataset.callAttend)));
  ed.querySelectorAll("[data-setting]").forEach((c) => (c.onchange = () => saveSetting(c.dataset.setting, c.checked)));
  const sg = document.getElementById("fcSaveGeo"); if (sg) sg.onclick = saveGeo;
  const add = document.getElementById("blkAdd");
  if (add) add.onclick = () => {
    const phone = (document.getElementById("blkPhone").value || "").trim();
    const table = (document.getElementById("blkTable").value || "").trim();
    if (!phone && !table) { toast("Enter a phone/email or table to block", "err"); return; }
    block({ phone: phone || undefined, table: table || undefined });
  };
  // drag the divider to resize the side panel (like a real app); width persists across re-renders
  const rz = document.getElementById("floorResizer");
  if (rz) rz.onpointerdown = (e) => {
    e.preventDefault();
    const aside = ed.querySelector(".floor-side");
    const startX = e.clientX, startW = aside.offsetWidth; // remember where the drag began and the starting width
    try { rz.setPointerCapture(e.pointerId); } catch {}
    // While the mouse moves: new width = start width minus how far we've dragged
    // left/right, clamped between 240 and 560px. Store it so re-renders keep it.
    const move = (ev) => { const w = Math.min(560, Math.max(240, startW - (ev.clientX - startX))); state.floorSideW = w; aside.style.width = w + "px"; aside.style.flexBasis = w + "px"; };
    const up = () => { rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up); }; // let go → stop tracking
    rz.addEventListener("pointermove", move);
    rz.addEventListener("pointerup", up);
  };
}

// Flip a session toggle (system on / require location / require code) right from the floor.
// OPTIMISTIC: the toggle (and anything it shows/hides) reacts instantly.
async function saveSetting(key, value) {
  const prev = (state.data.settings || {})[key];
  state.data.settings = { ...(state.data.settings || {}), [key]: value };
  floorOpsInFlight++;
  loadSessions(true);
  try { const r = await api("POST", "/settings", { [key]: value }); state.data.settings = r; loadSessions(true); toast("Saved", "ok"); }
  catch (e) {
    state.data.settings = { ...(state.data.settings || {}), [key]: prev }; // undo
    loadSessions(true);
    toast("Failed: " + e.message, "err");
  } finally { floorOpsInFlight--; }
}
// Save the café location from the side panel.
async function saveGeo() {
  const lat = (document.getElementById("fcLat").value || "").trim();
  const lng = (document.getElementById("fcLng").value || "").trim();
  const rad = (document.getElementById("fcRad").value || "").trim();
  try {
    const r = await api("POST", "/settings", { geo_lat: lat === "" ? null : parseFloat(lat), geo_lng: lng === "" ? null : parseFloat(lng), geo_radius_m: rad === "" ? 250 : parseInt(rad, 10) });
    state.data.settings = r; toast("Location saved", "ok");
  } catch (e) { toast("Failed: " + e.message, "err"); }
}

// ---- the ONE panel that handles a table end to end ----
// open/closeTablePanel: remember which table's big control panel is open. Opening
// also kicks off a fresh load so the panel is never showing stale data.
function openTablePanel(table) { state.openSess = String(table); renderTablePanel(); loadSessions(); /* refresh immediately so a reopened table is never stale */ }
function closeTablePanel() { state.openSess = null; document.querySelector(".sx-modal-overlay")?.remove(); }

// One dish row: its own status pill + next-step tap. Works for session items (order_items)
// AND legacy items (orders.items JSON) — so dishes are served one at a time either way.
function itemRowHtml(row) {
  // After the whole order is accepted, each dish is served one at a time.
  let btn = `<span class="sx-wait">waiting</span>`;
  if (row.status === "preparing") {
    const attr = row.kind === "session"
      ? `data-item-next="${esc(row.id)}" data-item-status="served"`
      : `data-legacy-order="${esc(row.orderId)}" data-legacy-idx="${row.idx}" data-legacy-status="served"`;
    btn = `<button class="btn small primary" ${attr}>🍽️ Serve</button>`;
  } else if (row.status === "served") {
    btn = `<span class="sx-served">✓ served</span>`;
  }
  return `<div class="sx-item"><div class="sx-item-info"><span class="ord-pill ${esc(row.status)}">${esc(row.status)}</span> ${esc(row.title)}${dishNoTag(row.title)} ×${esc(row.qty)}${itemDetailLine(row)}</div><div>${btn}</div></div>`;
}

// renderTablePanel: draw the big "do everything for this table" pop-up — guests,
// the live shared cart they're still building, each order (accept / serve dish by
// dish / serve all / mark paid), waiter calls, the bill, and the footer buttons
// (Restart, Turn table off, Free table). Works whether sessions are on or off.
function renderTablePanel() {
  if (state.openSess == null) return;
  // keep the scroll position so serving an item doesn't fling the panel back to the top
  const prevModal = document.querySelector(".sx-modal-overlay .tbl-modal");
  const savedScroll = prevModal ? prevModal.scrollTop : 0;
  document.querySelector(".sx-modal-overlay")?.remove();
  const t = state.openSess;
  const sessionsOn = !!(state.data.settings || {}).sessions_enabled;
  const os = ordersForTable(t);
  const sess = openSessionForTable(t);
  const calls = callsForTable(t);
  const due = os.filter((o) => o.status !== "cancelled" && o.payment_status !== "paid").reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
  const billTotal = os.filter((o) => o.status !== "cancelled").reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
  const canFree = os.length > 0 && os.every((o) => o.payment_status === "paid" || o.status === "cancelled");

  let sessionSec = "";
  if (sessionsOn) {
    if (sess) {
      const mem = membersOf(sess.id);
      const memRows = mem.length ? mem.map((m) => {
        const owner = m.role === "owner";
        const status = m.approved ? `<span class="sx-ok">approved</span>` : `<span class="sx-wait">waiting</span>`;
        // Kick (remove now) and Ban (kick + blocklist) are available for EVERYONE,
        // including the head — staff have full control from the table view.
        let acts = "";
        if (!m.approved) acts += `<button class="btn small primary" data-mem-approve="${esc(m.id)}">Approve</button><button class="btn small" data-mem-deny="${esc(m.id)}">Deny</button>`;
        else acts += `<button class="btn small" data-mem-kick="${esc(m.id)}">Kick</button>`;
        acts += `<button class="btn small danger" data-mem-ban="${esc(m.id)}" data-ban-phone="${esc(m.phone || "")}">Ban</button>`;
        return `<div class="sx-mem"><div class="sx-mem-info">${owner ? "👑 " : "🤝 "}<b>${esc(m.name || (owner ? "Head" : "Guest"))}</b> ${status}${m.phone_verified ? ` <span class="sx-ok">✓</span>` : ""}</div><div class="sx-mem-acts">${acts}</div></div>`;
      }).join("") : `<div class="sx-empty">No one has joined yet.</div>`;
      sessionSec = `<div class="sx-sec"><div class="sx-sec-h">Guests <span class="sub">· ${mem.length}</span><label class="sx-auto"><input type="checkbox" id="sxAuto" ${sess.auto_approve ? "checked" : ""}> auto-approve</label></div>${memRows}</div>`;
    } else {
      sessionSec = `<div class="sx-sec"><div class="sx-sec-h">Session</div><div class="sx-empty">This table isn't open yet.</div><button class="btn primary" id="sxOpen">Open this table</button></div>`;
    }
  }

  // Live shared cart: what the table is building right now but hasn't sent yet.
  // Clears itself the moment they place the order (cart → []).
  let buildingSec = "";
  const cart = sess && Array.isArray(sess.cart) ? sess.cart : [];
  if (cart.length) {
    const cartTotal = cart.reduce((a, it) => a + (parseFloat(it.price) || 0) * (parseInt(it.qty, 10) || 1), 0);
    const rows = cart.map((it) => `<div class="sx-item"><div class="sx-item-info"><span class="ord-pill building">building</span> ${esc(it.title || "Item")} ×${esc(String(it.qty || 1))}</div></div>`).join("");
    buildingSec = `<div class="sx-sec"><div class="sx-sec-h">🛒 Building <span class="sub">· not sent yet</span></div>${rows}<div class="sx-total">Cart <b>${inr(cartTotal)}</b></div></div>`;
  }

  let ordersSec;
  if (!os.length) {
    ordersSec = `<div class="sx-sec"><div class="sx-sec-h">Orders</div><div class="sx-empty">No orders yet.</div></div>`;
  } else {
    const orderBlocks = os.map((o, oi) => {
      const paid = o.payment_status === "paid";
      const accepted = o.status !== "received"; // a brand-new order is "received" until accepted
      const when = o.created_at ? new Date(o.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      let body;
      if (!accepted) {
        // whole-order accept first; dishes are listed but not yet individually actionable
        body = orderItemRows(o).map((r) => `<div class="sx-item"><div class="sx-item-info"><span class="ord-pill received">received</span> ${esc(r.title)}${dishNoTag(r.title)} ×${esc(r.qty)}${itemDetailLine(r)}</div></div>`).join("")
          + `<button class="btn small primary tp-accept" data-accept="${esc(o.id)}">✓ Accept &amp; prepare order</button>`;
      } else {
        // accepted → serve each dish one at a time, or serve everything at once
        const rows = orderItemRows(o);
        const anyUnserved = rows.some((r) => r.status !== "served");
        body = rows.map(itemRowHtml).join("") + (anyUnserved ? `<button class="btn small tp-serveall" data-serveall="${esc(o.id)}">✓ Serve all (complete order)</button>` : "");
      }
      return `<div class="tp-order"><div class="tp-order-head">Order ${oi + 1}${when ? ` · ${when}` : ""}</div><div class="tp-order-top"><span class="pay-pill ${paid ? "paid" : "pending"}">${paid ? "💳 Paid" : "⏳ Unpaid"}</span><span class="tp-order-total">${inr(o.total)}</span><button class="btn small ${paid ? "" : "primary"}" data-pay="${esc(o.id)}" data-paid="${paid ? "1" : "0"}">${paid ? "↩ Unpaid" : "Mark paid"}</button></div>${body}</div>`;
    }).join("");
    // A table-wide "serve everything" button when there are several orders with
    // anything still unserved (in addition to each order's own "Serve all").
    const anyUnservedAll = os.some((o) => orderItemRows(o).some((r) => r.status !== "served"));
    const serveAllOrdersBtn = (os.length > 1 && anyUnservedAll)
      ? `<button class="btn small primary tp-serve-all-orders" data-serve-all-orders="${esc(t)}">✓ Serve ALL orders (${os.length})</button>`
      : "";
    ordersSec = `<div class="sx-sec"><div class="sx-sec-h">Orders <span class="sub">· ${os.length}</span></div>${orderBlocks}${serveAllOrdersBtn}</div>`;
  }

  // Each active call (water, napkins, clean…) gets its own "Done" button so staff
  // can clear them one at a time; if there are several, an "Attend all" clears them together.
  const callsSec = calls.length ? `<div class="sx-sec"><div class="sx-sec-h">Calls <span class="sub">· ${calls.length}</span></div>${calls.map((c) => `<div class="sx-call">${callEmoji(c.note)} ${esc(c.note || "Waiter call")} <button class="btn small primary" data-call-attend="${esc(c.id)}">Done</button></div>`).join("")}${calls.length > 1 ? `<button class="btn small" data-attend-all="${esc(t)}">✓ Attend all (${calls.length})</button>` : ""}</div>` : "";
  const billSec = os.length ? `<div class="sx-sec"><div class="sx-sec-h">Bill</div><div class="sx-total">${due > 0 ? `Due <b>${inr(due)}</b> · ` : ""}Total <b>${inr(billTotal)}</b></div></div>` : "";
  const foot = `${os.length ? `<button class="btn" data-tp-restart="${esc(t)}">↻ Restart</button>` : ""}${sess ? `<button class="btn danger" id="sxClose">⏻ Turn table off</button>` : ""}<button class="btn ${canFree ? "primary" : ""} tp-free" ${canFree ? "" : "disabled"}>${canFree ? "✓ Free table" : "Settle bill to free"}</button>`;

  const wrap = el(`<div class="sx-modal-overlay tbl-modal-overlay"><div class="tbl-modal sx-modal"><div class="tbl-modal-head"><h3>Table ${esc(t)}${sess ? ` <span class="sx-live">● open</span>` : ""}</h3><button class="tbl-modal-close" aria-label="Close">✕</button></div><div class="tbl-modal-body">${sessionSec}${buildingSec}${ordersSec}${callsSec}${billSec}</div><div class="tbl-modal-foot">${foot}</div></div></div>`);
  document.body.appendChild(wrap);
  const newModal = wrap.querySelector(".tbl-modal"); if (newModal) newModal.scrollTop = savedScroll;
  wrap.querySelector(".tbl-modal-close").onclick = closeTablePanel;
  wrap.onclick = (e) => { if (e.target === wrap) closeTablePanel(); };
  const ob = wrap.querySelector("#sxOpen"); if (ob) ob.onclick = () => openTableSession(t);
  const cb = wrap.querySelector("#sxClose"); if (cb && sess) cb.onclick = () => closeSession(sess.id);
  const auto = wrap.querySelector("#sxAuto"); if (auto && sess) auto.onchange = () => setSessAutoApprove(sess.id, auto.checked);
  wrap.querySelectorAll("[data-mem-approve]").forEach((b) => (b.onclick = () => memberAction(b.dataset.memApprove, "approve")));
  wrap.querySelectorAll("[data-mem-deny]").forEach((b) => (b.onclick = () => memberAction(b.dataset.memDeny, "remove")));
  wrap.querySelectorAll("[data-mem-kick]").forEach((b) => (b.onclick = () => kickMember(b.dataset.memKick)));
  wrap.querySelectorAll("[data-mem-ban]").forEach((b) => (b.onclick = () => banMember(b.dataset.memBan, b.dataset.banPhone)));
  const rst = wrap.querySelector("[data-tp-restart]"); if (rst) rst.onclick = () => restartTable(rst.dataset.tpRestart);
  wrap.querySelectorAll("[data-item-next]").forEach((b) => (b.onclick = () => itemStatus(b.dataset.itemNext, b.dataset.itemStatus)));
  wrap.querySelectorAll("[data-legacy-order]").forEach((b) => (b.onclick = () => legacyItemStatus(b.dataset.legacyOrder, b.dataset.legacyIdx, b.dataset.legacyStatus)));
  wrap.querySelectorAll("[data-accept]").forEach((b) => (b.onclick = () => acceptOrder(b.dataset.accept)));
  wrap.querySelectorAll("[data-serveall]").forEach((b) => (b.onclick = () => serveAllOrder(b.dataset.serveall)));
  wrap.querySelectorAll("[data-serve-all-orders]").forEach((b) => (b.onclick = () => serveAllOrders(b.dataset.serveAllOrders)));
  wrap.querySelectorAll("[data-pay]").forEach((b) => (b.onclick = () => setOrderPayment(b.dataset.pay, b.dataset.paid !== "1")));
  wrap.querySelectorAll("[data-call-attend]").forEach((b) => (b.onclick = () => attendCall(b.dataset.callAttend)));
  wrap.querySelectorAll("[data-attend-all]").forEach((b) => (b.onclick = () => attendTableCalls(b.dataset.attendAll)));
  const free = wrap.querySelector(".tp-free"); if (free && canFree) free.onclick = () => freeTableAll(t, sess);
}

// Advance ONE dish in a legacy order (items stored in the order's JSON).
async function legacyItemStatus(orderId, index, status) {
  try {
    await api("POST", "/orders/" + orderId + "/item", { index: Number(index), status }); // persist now
    const o = (state.data.orders || []).find((x) => x.id === orderId);                    // optimistic local update
    if (o && Array.isArray(o.items) && o.items[index]) o.items[index].status = status;
    renderTablePanel();                                                                   // instant redraw from local state
    scheduleServeFlush();                                                                 // one real refresh after you stop clicking
  } catch (e) { toast("Failed: " + e.message, "err"); }
}

// Accept a whole order (received -> preparing). Flips the order AND its dishes,
// optimistically + poll-shielded so it can't flicker back mid-accept.
async function acceptOrder(orderId) {
  const o = (state.data.orders || []).find((x) => x.id === orderId);
  if (o) { o.status = "preparing"; flipOrderItems(o, "received", "preparing"); opBegin(o.id); }
  floorOpsInFlight++;
  loadSessions(true); renderTablePanel();
  let released = false;
  const release = () => { if (!released) { released = true; floorOpsInFlight--; if (o) opEnd(o.id); } };
  try { await api("POST", "/orders/" + orderId + "/accept"); release(); await loadSessions(); toast("Order accepted → preparing", "ok"); }
  catch (e) { release(); toast("Failed: " + e.message, "err"); await loadSessions(); }
}
// Serve every dish on an order at once → order complete. Optimistic + shielded.
async function serveAllOrder(orderId) {
  const o = (state.data.orders || []).find((x) => x.id === orderId);
  if (o) { o.status = "served"; flipOrderItems(o, null, "served"); opBegin(o.id); }
  floorOpsInFlight++;
  loadSessions(true); renderTablePanel();
  let released = false;
  const release = () => { if (!released) { released = true; floorOpsInFlight--; if (o) opEnd(o.id); } };
  try { await api("POST", "/orders/" + orderId + "/serve-all"); release(); await loadSessions(); toast("All items served", "ok"); }
  catch (e) { release(); toast("Failed: " + e.message, "err"); await loadSessions(); }
}
// Quick action: accept new orders on a table. If there's only ONE new order,
// accept it in one tap. If there are SEVERAL, don't bulk-accept — open the detail
// panel so staff can accept each order separately.
async function acceptTableOrders(t) {
  const recv = ordersForTable(t).filter((o) => o.status === "received");
  if (recv.length > 1) { openTablePanel(t); return; } // multiple → accept each in the detail view
  // OPTIMISTIC: tile flips to "Preparing" instantly, server told in background.
  recv.forEach((o) => { o.status = "preparing"; flipOrderItems(o, "received", "preparing"); opBegin(o.id); });
  floorOpsInFlight++;
  loadSessions(true);
  // release first, then refresh — see restartTable for why this order matters.
  let released = false;
  const release = () => { if (!released) { released = true; floorOpsInFlight--; recv.forEach((o) => opEnd(o.id)); } };
  try { for (const o of recv) await api("POST", "/orders/" + o.id + "/accept"); toast("Order accepted", "ok"); }
  catch (e) { release(); toast("Failed: " + e.message, "err"); await loadSessions(); } // reload truth on failure
  finally { release(); }
}
// Serve EVERY order on a table at once (the table-wide "mark all served").
// OPTIMISTIC like accept: every dish row flips to served on screen first.
async function serveAllOrders(t) {
  const orders = ordersForTable(t);
  if (!orders.length) return;
  orders.forEach((o) => { o.status = "served"; flipOrderItems(o, null, "served"); opBegin(o.id); });
  floorOpsInFlight++;
  loadSessions(true);
  renderTablePanel();
  // release first, then refresh — see restartTable for why this order matters.
  let released = false;
  const release = () => { if (!released) { released = true; floorOpsInFlight--; orders.forEach((o) => opEnd(o.id)); } };
  try { for (const o of orders) await api("POST", "/orders/" + o.id + "/serve-all"); toast("All orders served", "ok"); }
  catch (e) { release(); toast("Failed: " + e.message, "err"); await loadSessions(); }
  finally { release(); }
}
// Quick action: mark every open call on a table attended (clears the tile's emoji).
async function attendTableCalls(t) {
  const cs = callsForTable(t);
  // OPTIMISTIC: the call emojis leave the tile instantly.
  const before = state.data.calls || [];
  const ids = new Set(cs.map((c) => c.id));
  state.data.calls = before.filter((c) => !ids.has(c.id));
  floorOpsInFlight++;
  loadSessions(true);
  try { for (const c of cs) await api("PATCH", "/calls/" + c.id, { resolved: true }); toast("Attended", "ok"); }
  catch (e) { state.data.calls = before; loadSessions(true); toast("Failed: " + e.message, "err"); }
  finally { floorOpsInFlight--; }
}
// RST: clear a finished table's orders off the floor but KEEP the table open for a new round.
async function restartTable(t) {
  const ids = ordersForTable(t).map((o) => o.id);
  if (!ids.length) return;
  if (!(await confirmDialog(`Restart Table ${t}? Its orders clear off the floor and the table stays OPEN for a fresh round.`, "Restart"))) return;
  // OPTIMISTIC after the confirm: the tile resets instantly, server follows.
  // Orders become SERVED + archived (the round is done; they stay as real,
  // completed orders in records/revenue — NOT cancelled, which would void them).
  (state.data.orders || []).forEach((o) => { if (ids.includes(o.id)) { o.archived = true; o.status = "served"; opBegin(o.id); } });
  floorOpsInFlight++;
  loadSessions(true);
  // release: drop our "mid-save" markers BEFORE the reconciling refresh below —
  // loadSessions only trusts the server's board once nothing is in flight, so
  // holding the markers through the refresh would delay our own reconcile.
  let released = false;
  const release = () => { if (!released) { released = true; floorOpsInFlight--; ids.forEach((id) => opEnd(id)); } };
  try {
    for (const id of ids) await api("PATCH", "/orders/" + id, { archived: true, status: "served" });
    // keep the table OPEN for the next round — open a fresh session if it doesn't have one
    if ((state.data.settings || {}).sessions_enabled && !openSessionForTable(t)) await api("POST", "/sessions/open", { table: String(t) });
    release();
    await loadSessions();
    toast(`Table ${t} restarted — still open`, "ok");
  } catch (e) { release(); toast("Could not restart: " + e.message, "err"); await loadSessions(); }
  finally { release(); }
}
// CLS: free the table (archive orders + close any open session).
function closeTableQuick(t) { freeTableAll(t, openSessionForTable(t)); }

// Free a table: archive its settled orders off the floor and, if a session is open, close it.
// OPTIMISTIC after the confirm: the tile turns Free instantly; the server
// catches up in the background and a refresh reconciles (or reloads on error).
async function freeTableAll(t, sess) {
  const ids = ordersForTable(t).map((o) => o.id);
  if (!(await confirmDialog(`Free Table ${t}? Settled orders leave the floor${sess ? " and the session closes" : ""} (kept in records).`, "Free table"))) return;
  (state.data.orders || []).forEach((o) => { if (ids.includes(o.id)) { o.archived = true; opBegin(o.id); } });
  if (sess) sess.status = "closed";
  state.openSess = null; document.querySelector(".sx-modal-overlay")?.remove();
  floorOpsInFlight++;
  loadSessions(true); // instant redraw from local state
  // release first, then refresh — see restartTable for why this order matters.
  let released = false;
  const release = () => { if (!released) { released = true; floorOpsInFlight--; ids.forEach((id) => opEnd(id)); } };
  try {
    for (const id of ids) await api("PATCH", "/orders/" + id, { archived: true });
    if (sess) await api("POST", "/sessions/" + sess.id + "/close");
    release();
    await loadSessions();
    toast(`Table ${t} freed`, "ok");
  } catch (e) { release(); toast("Could not free: " + e.message, "err"); await loadSessions(); }
  finally { release(); }
}

// ===================== USERS / LOG =====================
// Every guest who joined a table (auto ID = their member id) + the blocklist. From here
// the owner can EXIT (kick) a guest or BLOCK them (they then see a blocked screen).
// loadUsers: fetch the Log tab's data (guests, customers, blocklist, plus their
// order/call activity) and redraw if the Log tab is showing.
async function loadUsers() {
  try { state.users = await api("GET", "/users"); if (state.tab === "log") renderEditor(); }
  catch (e) { toast("Could not load log: " + e.message, "err"); }
}

// logHtml: build the Log tab — a table listing every guest (name, table, role,
// what they did, status, when) with Exit/Block actions, plus the blocklist below.
function logHtml() {
  const u = state.users || {};
  const members = u.members || [];
  const blocks = u.blocklist || [];
  const blockedPhones = new Set(blocks.filter((b) => b.phone).map((b) => b.phone)); // quick "is this phone blocked?" lookup
  // What each guest DID — aggregate orders + waiter calls by their member id.
  const orderCount = {}, callCount = {};
  (u.orders || []).forEach((o) => { if (o.member_id) orderCount[o.member_id] = (orderCount[o.member_id] || 0) + 1; });
  (u.calls || []).forEach((c) => { if (c.member_id) callCount[c.member_id] = (callCount[c.member_id] || 0) + 1; });

  const head = `<div class="ed-head"><h2>Log <span class="sub">· who did what</span></h2><button class="btn" id="refreshLog">↻ Refresh</button></div>
    <div class="ord-note">Every guest gets an automatic ID. <b>Role</b> shows who ran the table (👑 Head) vs a joiner (🤝 Partner); <b>Did</b> shows whether they ordered or just called a waiter. Use <b>Exit</b> to remove someone, or <b>Block</b> to stop a misbehaving guest (e.g. someone who calls a waiter but isn't here).</div>`;
  const rows = members.length ? members.map((m) => {
    const table = m.session ? m.session.table_number : "—"; // which table they're at
    const open = m.session && m.session.status === "open"; // is that table's session still open?
    const blocked = m.phone && blockedPhones.has(m.phone);
    // Work out a single word for their current status, in priority order.
    const status = m.removed ? "left" : blocked ? "blocked" : open ? (m.approved ? "in session" : "waiting") : "ended";
    const isHead = m.role === "owner"; // the person who started the table
    const role = isHead ? `<span class="logrole head">👑 Head</span>` : `<span class="logrole partner">🤝 Partner</span>`;
    const nOrders = orderCount[m.id] || 0, nCalls = callCount[m.id] || 0;
    let did = "";
    if (nOrders) did += `<span class="logdid order">🛒 ${nOrders} order${nOrders > 1 ? "s" : ""}</span>`;
    if (nCalls) did += `<span class="logdid call">🔔 ${nCalls} call${nCalls > 1 ? "s" : ""}</span>`;
    if (!did) did = (open && !m.approved) ? `<span class="lg-muted">asked to join</span>` : `<span class="lg-muted">joined only</span>`;
    let acts = "";
    if (open && !m.removed) acts += `<button class="btn small" data-exit="${esc(m.id)}">Exit</button>`;
    if (!blocked) acts += `<button class="btn small danger" data-block-phone="${esc(m.phone || "")}" data-block-table="${esc(table)}">Block</button>`;
    return `<div class="logrow">
        <div class="logcell"><b>${esc(m.name || (isHead ? "Head" : "Guest"))}</b><small>${esc(String(m.id).slice(0, 8))}</small></div>
        <div class="logcell">T${esc(table)}</div>
        <div class="logcell">${role}</div>
        <div class="logcell logdidcell">${did}</div>
        <div class="logcell"><span class="logstat logstat-${status.replace(/ /g, "-")}">${status}</span></div>
        <div class="logcell"><small>${esc(timeAgo(m.joined_at))}</small></div>
        <div class="logcell logacts">${acts}</div>
      </div>`;
  }).join("") : `<div class="sx-empty">No guests have joined a table yet.</div>`;
  const table = `<div class="logtable"><div class="logrow loghead"><div>Guest</div><div>Table</div><div>Role</div><div>Did</div><div>Status</div><div>When</div><div></div></div>${rows}</div>`;
  const blkRows = blocks.length ? blocks.map((b) => `<div class="sx-blk"><span>${b.phone ? "📵 " + esc(b.phone) : "🚫 table " + esc(b.table_number)}${b.reason ? ` — <small>${esc(b.reason)}</small>` : ""}</span><button class="btn small" data-unblock="${esc(b.id)}">Unblock</button></div>`).join("") : `<div class="sx-empty">Nobody is blocked.</div>`;
  const blkPanel = `<div class="sx-panel" style="margin-top:18px;max-width:560px"><h3>🚫 Blocked <span class="sub">· ${blocks.length}</span></h3>${blkRows}</div>`;
  return head + table + blkPanel;
}

// bindLog: wire up the Log tab's buttons (refresh, exit a guest, block, unblock).
function bindLog() {
  const ed = $("#editor");
  const rb = document.getElementById("refreshLog"); if (rb) rb.onclick = loadUsers;
  ed.querySelectorAll("[data-exit]").forEach((b) => (b.onclick = () => exitUser(b.dataset.exit)));
  ed.querySelectorAll("[data-block-phone]").forEach((b) => (b.onclick = () => blockUser(b.dataset.blockPhone, b.dataset.blockTable)));
  ed.querySelectorAll("[data-unblock]").forEach((b) => (b.onclick = () => unblockLog(b.dataset.unblock)));
}

// exitUser: remove a guest from their table (from the Log tab).
async function exitUser(memberId) {
  if (!(await confirmDialog("Remove this guest from the table? They can't order or call until they rejoin.", "Remove"))) return;
  try { await api("POST", "/members/" + memberId + "/remove"); await loadUsers(); toast("Guest removed", "ok"); }
  catch (e) { toast("Failed: " + e.message, "err"); }
}
// blockUser: block a guest by phone (preferred) or table, so they hit a blocked screen.
async function blockUser(phone, table) {
  const by = phone ? `phone ${phone}` : `table ${table}`;
  if (!(await confirmDialog(`Block this guest (by ${by})? They'll see a blocked screen and can't order or call.`, "Block"))) return;
  try { await api("POST", "/blocklist", phone ? { phone } : { table }); await loadUsers(); toast("Blocked", "ok"); }
  catch (e) { toast("Failed: " + e.message, "err"); }
}
// unblockLog: remove someone from the blocklist (from the Log tab).
async function unblockLog(id) {
  try { await api("DELETE", "/blocklist/" + id); await loadUsers(); toast("Unblocked", "ok"); }
  catch (e) { toast("Failed: " + e.message, "err"); }
}

// ---------- tabs + init ----------
// setTab: switch the editor to a different tab. It records the choice (so a refresh
// stays here), resets the selection, shows/hides the search + "New" controls as
// appropriate, redraws, and kicks off any data load that tab needs.
function setTab(tab) {
  state.tab = tab;
  try { localStorage.setItem("lfh_editor_tab", tab); } catch {}
  state.isNew = false;
  state.sel = tab === "general"
    ? clone(state.data.settings || { id: "site", bubbles_enabled: true, service_mode: false })
    : null;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  // The search box and "+ New" don't apply to the General/Orders/Tables tabs.
  const noList = tab === "general" || tab === "orders" || tab === "tables" || tab === "log";
  $("#newBtn").style.display = noList ? "none" : "";
  $("#search").style.display = noList ? "none" : "";
  renderCatFilter(); // show category chips on Dishes, hide elsewhere
  renderList();
  renderEditor();
  if (tab === "orders") {
    loadOrders();
    unseenOrders = 0;
    updateOrdersBadge();
    document.title = "Menu Editor";
  }
  if (tab === "tables") loadSessions(); // unified live floor (orders + sessions in one)
  if (tab === "log") loadUsers();
}

// loadOrders: fetch the latest orders (and waiter calls) and redraw if we're on
// the Orders tab. Used by the Refresh button and after any order change.
async function loadOrders() {
  try {
    state.data.orders = await api("GET", "/orders");
    lastOrderCount = state.data.orders.length;
    try {
      state.data.calls = await api("GET", "/calls");
      lastCallCount = (state.data.calls || []).filter((c) => !c.resolved).length;
    } catch {}
    if (state.tab === "orders") { renderList(); renderEditor(); } // sidebar counts + cards
  } catch (e) {
    toast("Could not load orders: " + e.message, "err");
  }
}

// ---------- live order alerts (owner) ----------
// The editor polls the orders endpoint and chimes + badges when a new order
// lands, no matter which tab the owner is on.
let lastOrderCount = null; // baseline; set on first poll so we don't alert on startup
let lastCallCount = null;  // pending waiter calls baseline
// Optimistic-click bookkeeping: while a save is still travelling to the
// server, the 1-second poll must not overwrite that order with stale data
// (it would flicker the click back). Deletes get the same protection.
const pendingOrderOps = new Map();  // order id -> number of in-flight saves
const pendingDeletes = new Set();   // ids removed on screen, server catching up
const opBegin = (id) => pendingOrderOps.set(id, (pendingOrderOps.get(id) || 0) + 1);
const opEnd = (id) => { const n = (pendingOrderOps.get(id) || 1) - 1; n <= 0 ? pendingOrderOps.delete(id) : pendingOrderOps.set(id, n); };
let lastPollSig = "";               // fingerprint of the last drawn orders view
// While any FLOOR action (open/free/attend/approve…) is mid-save, the poll
// must not replace the board or redraw the Tables tab — it would briefly
// flicker the optimistic change back before the server confirms.
let floorOpsInFlight = 0;
let lastReqCount = null;   // pending requests (join/access/open/waiter) baseline
let unseenOrders = 0;

// updateOrdersBadge: show/hide the little red number on the Orders tab counting
// new things you haven't looked at yet.
function updateOrdersBadge() {
  const b = $("#ordersBadge");
  if (!b) return;
  b.textContent = unseenOrders;
  b.hidden = unseenOrders === 0;
}

// A short, soft two-note chime via the Web Audio API — no sound file needed.
function playOrderChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {}
}

// pollOrders: this runs once a second (see startOrderWatch). Each tick it re-fetches
// orders, waiter calls, and the sessions board, refreshes whatever tab is showing,
// and — by comparing the new counts to the last counts — chimes + toasts + badges
// whenever something NEW arrives, no matter which tab the owner is currently on.
async function pollOrders() {
  let orders, calls, board;
  try {
    orders = await api("GET", "/orders");
  } catch {
    return; // network blip — try again next tick
  }
  // Merge, don't clobber: keep the LOCAL copy of any order whose save is
  // still in flight, and keep optimistically-deleted rows gone — otherwise
  // this poll would flicker fresh clicks back to their old state.
  orders = orders
    .filter((o) => !pendingDeletes.has(o.id))
    .map((o) => (pendingOrderOps.has(o.id) ? ((state.data.orders || []).find((x) => x.id === o.id) || o) : o));
  state.data.orders = orders;
  try { calls = await api("GET", "/calls"); state.data.calls = calls; } catch { calls = state.data.calls || []; }
  // The session board (sessions + members + the requests queue + blocklist) is now
  // refreshed on every tick too, so the live cart and the request queue stay fresh
  // and we can chime for new requests from ANY tab.
  try {
    board = await api("GET", "/sessions");
    // Don't clobber the board while a floor action's save is still in flight.
    if (!floorOpsInFlight) state.board = board; else board = state.board || {};
    state.boardLoaded = true; // a poll fetch counts too: we now know the real floor
  } catch { board = state.board || {}; }

  // Remember the previous counts, then update to the new ones. The "did it grow?"
  // checks below compare prev vs now to detect something brand-new arriving.
  const prev = lastOrderCount;
  lastOrderCount = orders.length;
  const pending = (calls || []).filter((c) => !c.resolved).length;
  const prevC = lastCallCount;
  lastCallCount = pending;
  const reqCount = (board.requests || []).length;
  const prevR = lastReqCount;
  lastReqCount = reqCount;

  // While a serve flush is pending (staff is actively marking dishes), don't let
  // the poll redraw the view under their fingers — the optimistic local render is
  // already on screen and the debounced flush will reconcile it shortly. We still
  // fetched fresh data above, so the new-order/call/request alerts below still fire.
  if (!serveFlushPending()) {
    // Only redraw the Orders tab when something VISIBLE actually changed —
    // rebuilding 200 cards every second ate clicks and scroll position.
    const sig = JSON.stringify([
      orders.map((o) => [o.id, o.status, o.payment_status, o.archived ? 1 : 0]),
      (calls || []).filter((c) => !c.resolved).map((c) => c.id),
      (board && board.requests ? board.requests.length : 0),
    ]);
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (state.tab === "orders" && sig !== lastPollSig && !typing) { renderList(); renderEditor(); }
    lastPollSig = sig;
    if (state.tab === "tables" && !floorOpsInFlight) loadSessions(true); // keep the live floor fresh
  }

  // new order alert
  if (prev !== null && orders.length > prev) {
    const newCount = orders.length - prev;
    const latest = orders[0];
    const where = latest && latest.table_number ? "Table " + latest.table_number : "Walk-in";
    playOrderChime();
    toast(`🔔 ${newCount} new order${newCount > 1 ? "s" : ""} — ${where}`, "ok");
    if (state.tab !== "orders") { unseenOrders += newCount; updateOrdersBadge(); document.title = `(${unseenOrders}) Menu Editor`; }
  }
  // new waiter-call alert
  if (prevC !== null && pending > prevC) {
    const latest = (calls || []).find((c) => !c.resolved);
    const where = latest && latest.table_number ? "Table " + latest.table_number : "a guest";
    playOrderChime();
    toast(`🔔 Waiter call — ${where}`, "ok");
    if (state.tab !== "orders") { unseenOrders += (pending - prevC); updateOrdersBadge(); document.title = `(${unseenOrders}) Menu Editor`; }
  }
  // new request alert (a guest asked to join/access a table, or requested a waiter
  // when they couldn't be auto-let-in). Newest request is last (queue is ascending).
  if (prevR !== null && reqCount > prevR) {
    const latest = (board.requests || [])[reqCount - 1];
    const verb = latest && latest.type === "open" ? "wants to open" : latest && latest.type === "join" ? "wants to join" : "needs access to";
    const where = latest && latest.table_number ? `Table ${latest.table_number}` : "a table";
    playOrderChime();
    toast(`🙋 Request — ${verb} ${where}`, "ok");
    if (state.tab !== "tables") { unseenOrders += (reqCount - prevR); updateOrdersBadge(); document.title = `(${unseenOrders}) Menu Editor`; }
  }
}

// startOrderWatch: kick off the live polling. The first call sets the "baseline"
// counts so we don't alert for orders that were already there; then setInterval
// repeats it every second so the floor and alerts stay near-real-time.
function startOrderWatch() {
  pollOrders(); // sets the baseline immediately (no alert on first run)
  setInterval(pollOrders, 1000); // near-real-time floor: requests/orders/calls show within ~1s
}

// --- final wiring: connect the static page controls and start everything up ---
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setTab(t.dataset.tab))); // top tabs switch views
$("#newBtn").onclick = newRecord; // the "+ New" button

// Drag the left sidebar's right edge to resize it (width persists across reloads).
(function () {
  const layout = document.querySelector(".layout");
  const rz = document.getElementById("sidebarResizer");
  if (!layout || !rz) return;
  try { const saved = localStorage.getItem("lfh_editor_sidebar_w"); if (saved) layout.style.setProperty("--sidebar-w", saved + "px"); } catch {}
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { rz.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => { const w = Math.min(560, Math.max(220, ev.clientX)); layout.style.setProperty("--sidebar-w", w + "px"); try { localStorage.setItem("lfh_editor_sidebar_w", String(w)); } catch {} };
    const up = () => { rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up); };
    rz.addEventListener("pointermove", move);
    rz.addEventListener("pointerup", up);
  });
})();
// Typing in the search box filters the left-hand list live.
$("#search").oninput = (e) => { state.search = e.target.value; renderList(); };
// Ctrl+S (or Cmd+S on Mac) saves the current record instead of saving the web page.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (state.sel) save();
  }
});

// THE STARTING POINT.
// First, open the saved tab IMMEDIATELY — before any data has loaded. This is what
// stops the old "refresh flashes Dishes, then jumps to your real tab" bug: setTab
// used to run only after loadAll() finished, so you stared at the default tab for
// the whole network round-trip. Now the correct tab is shown right away (empty for
// a moment), and the data fills into it when it arrives.
setTab(state.tab);
// Then load all the data, refresh the current view in place, and start live polling.
// If the very first load fails, show "connection failed" so it's obvious the local
// server probably isn't running.
loadAll()
  .then(() => { renderCatFilter(); renderList(); renderEditor(); startOrderWatch(); })
  .catch((e) => {
    $("#conn").textContent = "connection failed";
    $("#conn").className = "conn err";
    toast("Could not load: " + e.message, "err");
  });
