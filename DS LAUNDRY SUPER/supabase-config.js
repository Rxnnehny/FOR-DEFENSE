// ============================================================================
//  DS LAUNDRY — supabase-config.js
//  Drop-in replacement for firebase-config.js
//
//  WHY THIS FILE LOOKS THE WAY IT DOES
//  -----------------------------------
//  app.js, index.html and admin.html contain roughly 200 Firestore calls
//  (db.collection(...).doc(...).onSnapshot(...), FieldValue.increment(), and
//  so on). Rewriting every one of them by hand is where migrations go to die:
//  one missed call site and a whole page silently stops saving.
//
//  So this file re-implements the small slice of the Firestore API that the
//  app actually uses, backed by Supabase. Your page code does not change.
//  Underneath:
//      collections  → Postgres tables
//      documents    → rows  (id text, branch_id text, data jsonb)
//      onSnapshot   → Supabase Realtime subscriptions
//      security     → Row Level Security, defined in supabase-schema.sql
//
//  Requires (load BEFORE this file):
//    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// ============================================================================


// =============================================
//  SUPABASE CONFIGURATION
//  Dashboard → Project Settings → Data API
//  The anon key is meant to be public. It is safe here ONLY because Row Level
//  Security is enabled on every table. Never paste the service_role key.
// =============================================
const SUPABASE_URL      = 'https://miahuimleljqkwmebnsk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_uIb8xp_yWI3WYXQsDyhnmw_mn4NFWgs';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:      true,
    autoRefreshToken:    true,
    detectSessionInUrl:  false,
  },
  realtime: { params: { eventsPerSecond: 10 } },
});
window.sb = sb;


// =============================================
//  BRANCH DEFINITIONS   (unchanged from Firebase)
// =============================================
window.DS_BRANCHES = [
  { id: 'ubujan',   name: 'Ubujan',   color: '#7C3AED', gradient: 'linear-gradient(135deg,#7C3AED,#9D6CF5)' },
  { id: 'taloto',   name: 'Taloto',   color: '#1D4ED8', gradient: 'linear-gradient(135deg,#1D4ED8,#3B82F6)' },
  { id: 'bingag',   name: 'Bingag',   color: '#D97706', gradient: 'linear-gradient(135deg,#D97706,#F59E0B)' },
  { id: 'catarman', name: 'Catarman', color: '#C0311A', gradient: 'linear-gradient(135deg,#C0311A,#E5533A)' },
];

// =============================================
//  LOAD SIZE CATEGORIES   (unchanged)
// =============================================
window.DS_LOAD_SIZES = [
  { value: '8kg', label: '8 kg — T-shirts, Shorts, Underwear & Regular Clothing' },
  { value: '6kg', label: '6 kg — Blankets, Towels & Beddings' },
  { value: '3kg', label: '3 kg — Heavy Comforters' },
];


// ============================================================================
//  PART 1 — COLLECTION → TABLE MAP
// ============================================================================
//  scoped:true  → the table has a branch_id column
//  mode:'jsonb' → the document body lives in the `data` column
//  mode:'cols'  → the document body maps onto real columns (see `map`)

const TABLE_MAP = {
  orders:         { table: 'orders',          scoped: true,  mode: 'jsonb' },
  customers:      { table: 'customers',       scoped: true,  mode: 'jsonb' },
  services:       { table: 'services',        scoped: true,  mode: 'jsonb' },
  addons:         { table: 'addons',          scoped: true,  mode: 'jsonb' },
  employees:      { table: 'employees',       scoped: true,  mode: 'jsonb' },
  // PIN-free view of `employees` (see db-hardening.sql). Branch dashboards
  // should read through this instead of `employees` for anything that
  // doesn't need to manage PINs — admin.html's employee management screens
  // are the one legitimate place that still reads the raw `employees` table.
  employeesPublic:{ table: 'employees_public', scoped: true,  mode: 'jsonb' },
  expenses:       { table: 'expenses',        scoped: true,  mode: 'jsonb' },
  employeeLogins: { table: 'employee_logins', scoped: true,  mode: 'jsonb' },
  priceHistory:   { table: 'price_history',   scoped: true,  mode: 'jsonb' },
  trash:          { table: 'trash',           scoped: true,  mode: 'jsonb' },

  system:         { table: 'system_settings', scoped: false, mode: 'jsonb' },
  announcements:  { table: 'announcements',   scoped: false, mode: 'jsonb' },

  branches: {
    table: 'branches', scoped: false, mode: 'cols',
    map: {
      name:            'name',
      color:           'color',
      gradient:        'gradient',
      orderIdMigrated: 'order_id_migrated',
      createdAt:       'created_at',
    },
  },
  users: {
    table: 'profiles', scoped: false, mode: 'cols',
    map: {
      email:     'email',
      name:      'name',
      role:      'role',
      branchId:  'branch_id',
      createdAt: 'created_at',
    },
  },
};

function tableSpec(collName) {
  const spec = TABLE_MAP[collName];
  if (!spec) throw new Error(`[DS] Unknown collection "${collName}". Add it to TABLE_MAP.`);
  return spec;
}


// ============================================================================
//  PART 2 — SENTINELS  (FieldValue.serverTimestamp / increment / delete)
// ============================================================================

const SENTINEL = '__ds_sentinel';
const isSentinel = v => v && typeof v === 'object' && v[SENTINEL];

// The literal string a Postgres trigger (see server-timestamp-trigger.sql)
// replaces with the DB's own now() before the row commits. Do NOT resolve
// this to a client Date here — that was the whole bug: a client with a wrong
// clock (or a user who changes it on purpose) could write false dates on
// money changing hands, and nothing server-side ever double-checked it.
const SERVER_NOW_MARKER = '__DS_SERVER_NOW__';

// Split a payload into: plain fields, fields to increment, fields to remove.
function splitSentinels(obj) {
  const plain = {}, incr = {}, remove = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (!isSentinel(v)) { plain[k] = v; continue; }
    if (v[SENTINEL] === 'serverTimestamp') plain[k] = SERVER_NOW_MARKER;
    else if (v[SENTINEL] === 'increment')  incr[k]  = v.amount;
    else if (v[SENTINEL] === 'delete')     remove.push(k);
  }
  return { plain, incr, remove };
}

// Anything non-JSON-safe (a Date, a Firestore-style Timestamp) becomes an ISO
// string. Every read site in the app does `ts.toDate ? ts.toDate() : new Date(ts)`,
// so ISO strings drop straight in.
function toJsonSafe(value) {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object' && !isSentinel(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value === undefined ? null : value;
}


// ============================================================================
//  PART 3 — ROW  ⇄  DOCUMENT TRANSLATION
// ============================================================================

function rowToDoc(spec, row) {
  if (!row) return null;
  if (spec.mode === 'jsonb') {
    const d = { ...(row.data || {}) };
    if (row.created_at && d.createdAt === undefined) d.createdAt = row.created_at;
    return d;
  }
  // column mode
  const out = { ...(row.extra || {}) };
  for (const [docKey, col] of Object.entries(spec.map)) {
    if (row[col] !== undefined && row[col] !== null) out[docKey] = row[col];
  }
  return out;
}

function docToRow(spec, id, branchId, body) {
  const safe = toJsonSafe(body);
  if (spec.mode === 'jsonb') {
    const row = { id, data: safe };
    if (spec.scoped) row.branch_id = branchId;
    return row;
  }
  const row = { id }, extra = {};
  const inverse = Object.entries(spec.map);
  for (const [k, v] of Object.entries(safe)) {
    const hit = inverse.find(([docKey]) => docKey === k);
    if (hit) row[hit[1]] = v;
    else extra[k] = v;
  }
  if (Object.keys(extra).length) row.extra = extra;
  return row;
}


// ============================================================================
//  PART 4 — SNAPSHOT OBJECTS
// ============================================================================

function makeDocSnapshot(id, data) {
  return {
    id,
    exists: data !== null && data !== undefined,
    data:   () => data,
    get:    field => (data ? data[field] : undefined),
  };
}

function makeQuerySnapshot(docs) {
  return {
    docs,
    empty:   docs.length === 0,
    size:    docs.length,
    forEach: fn => docs.forEach(fn),
  };
}


// ============================================================================
//  PART 5 — SORTING
//  Firestore sorts server-side. PostgREST cannot sort a JSONB field NUMERICALLY
//  (services.order would sort as "10" < "9"), so sorting happens here instead.
//  Per-branch collections are small — hundreds of rows, not millions — so this
//  costs nothing measurable.
// ============================================================================

function compareValues(a, b) {
  if (a === undefined || a === null) return (b === undefined || b === null) ? 0 : -1;
  if (b === undefined || b === null) return 1;

  const na = typeof a === 'number' ? a : (typeof a === 'string' && a.trim() !== '' && !isNaN(Number(a)) ? Number(a) : null);
  const nb = typeof b === 'number' ? b : (typeof b === 'string' && b.trim() !== '' && !isNaN(Number(b)) ? Number(b) : null);
  if (na !== null && nb !== null) return na - nb;

  const da = Date.parse(a), dbb = Date.parse(b);
  if (!isNaN(da) && !isNaN(dbb)) return da - dbb;

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function applyQuery(docs, opts) {
  let out = docs;
  for (const w of (opts.wheres || [])) {
    out = out.filter(d => {
      const v = d.data()?.[w.field];
      switch (w.op) {
        case '==': return v === w.value;
        case '!=': return v !== w.value;
        case '>':  return compareValues(v, w.value) > 0;
        case '>=': return compareValues(v, w.value) >= 0;
        case '<':  return compareValues(v, w.value) < 0;
        case '<=': return compareValues(v, w.value) <= 0;
        case 'in': return Array.isArray(w.value) && w.value.includes(v);
        case 'array-contains': return Array.isArray(v) && v.includes(w.value);
        default:   return true;
      }
    });
  }
  for (const o of [...(opts.orders || [])].reverse()) {
    out = [...out].sort((x, y) => {
      const r = compareValues(x.data()?.[o.field], y.data()?.[o.field]);
      return o.dir === 'desc' ? -r : r;
    });
  }
  if (opts.limitN) out = out.slice(0, opts.limitN);
  return out;
}


// ============================================================================
//  PART 6 — OFFLINE READ CACHE
//  Firestore's enablePersistence() is gone. This keeps the LAST SUCCESSFUL read
//  of each collection in localStorage so the dashboard still renders when the
//  shop's internet drops.
//  IMPORTANT LIMITATION: reads are cached, WRITES ARE NOT QUEUED. Saving an
//  order while offline will fail, exactly as it would in any online-first app.
//  See "Offline behaviour" in the setup guide before you rely on this.
// ============================================================================

const CACHE_PREFIX = 'ds_cache:';

function cacheKey(spec, branchId, opts) {
  return CACHE_PREFIX + spec.table + ':' + (branchId || 'global') + ':' +
         JSON.stringify(opts.orders || []) + ':' + (opts.limitN || 0);
}

function cacheWrite(key, docs) {
  try {
    localStorage.setItem(key, JSON.stringify(docs.map(d => ({ id: d.id, data: d.data() }))));
  } catch (e) { /* quota exceeded — not fatal */ }
}

function cacheRead(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw).map(r => makeDocSnapshot(r.id, r.data));
  } catch (e) { return null; }
}


// ============================================================================
//  PART 6b — OFFLINE WRITE QUEUE (pending overlay)
//  PART 6 above covers reads made while offline. This covers WRITES made
//  while offline: a doc created here is layered on top of normal reads
//  (tagged `_pending: true`) until it actually reaches Supabase. See
//  DsCollectionRef.add() below for where docs get queued, and PART 14 near
//  the end of this file for how a queued write is replayed once back online.
//  offline-queue.js owns the durable outbox itself (IndexedDB, ordering,
//  auto-drain); this part only owns what an app-visible "pending doc" looks
//  like. Only .add() is covered for now — editing or deleting an EXISTING
//  order while offline still fails immediately, same as before.
// ============================================================================

// A genuine connectivity problem (offline, DNS/fetch failure) — never a real
// Postgres/RLS/validation error, which must keep failing exactly as it
// always has, so a broken policy or a bad save still surfaces immediately.
function isNetworkFailure(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('load failed') ||
         msg.includes('networkerror') || msg.includes('network request failed') ||
         msg.includes('internet connection appears to be offline');
}

const PENDING_PREFIX = 'ds_pending:';
function pendingScopeKey(table, branchId) { return PENDING_PREFIX + table + ':' + (branchId || 'global'); }

function pendingReadRaw(table, branchId) {
  try { return JSON.parse(localStorage.getItem(pendingScopeKey(table, branchId)) || '[]'); }
  catch (e) { return []; }
}
function pendingWriteRaw(table, branchId, arr) {
  try { localStorage.setItem(pendingScopeKey(table, branchId), JSON.stringify(arr)); } catch (e) {}
}
function pendingNotify(table, branchId) {
  try { window.dispatchEvent(new CustomEvent('ds-pending-changed', { detail: { table: table, branchId: branchId } })); }
  catch (e) {}
}

// Lays a locally-created doc on top of the real table so .get()/onSnapshot()
// show it right away, tagged `_pending: true` so the UI can tell it apart
// from a saved row.
function pendingAdd(spec, branchId, id, displayData, queueId) {
  const key = spec.scoped ? branchId : null;
  const arr = pendingReadRaw(spec.table, key);
  arr.push({ id: id, data: Object.assign({}, displayData, { _pending: true, _queueId: queueId }) });
  pendingWriteRaw(spec.table, key, arr);
  pendingNotify(spec.table, key);
}
function pendingRemove(spec, branchId, id) {
  const key = spec.scoped ? branchId : null;
  const arr = pendingReadRaw(spec.table, key).filter(d => d.id !== id);
  pendingWriteRaw(spec.table, key, arr);
  pendingNotify(spec.table, key);
}

// Merges pending overlay docs into a normal result set. When nothing is
// pending for this table/branch — the common case — this returns `docs`
// completely untouched, so online behaviour is unchanged.
function mergePending(spec, branchId, docs) {
  const key  = spec.scoped ? branchId : null;
  const pend = pendingReadRaw(spec.table, key);
  if (!pend.length) return docs;
  const seen  = new Set(docs.map(d => d.id));
  const extra = pend.filter(p => !seen.has(p.id)).map(p => makeDocSnapshot(p.id, p.data));
  return extra.length ? docs.concat(extra) : docs;
}


// ============================================================================
//  PART 7 — DOCUMENT REFERENCE
// ============================================================================

class DsDocRef {
  constructor(collName, id, branchId) {
    this.collName = collName;
    this.id       = id;
    this.branchId = branchId;
    this.spec     = tableSpec(collName);
  }

  // Only meaningful under 'branches' — e.g. branches/ubujan/orders
  collection(subName) {
    return new DsCollectionRef(subName, this.id);
  }

  async get() {
    const { data, error } = await sb
      .from(this.spec.table).select('*').eq('id', this.id).maybeSingle();
    if (error) throw error;
    return makeDocSnapshot(this.id, data ? rowToDoc(this.spec, data) : null);
  }

  // Firestore set() replaces; set(_, {merge:true}) merges. Both are an upsert
  // here — the difference is whether we read the existing body first.
  async set(body, options = {}) {
    let finalBody = body;
    if (options.merge) {
      const existing = await this.get();
      finalBody = { ...(existing.data() || {}), ...body };
    }
    const { plain } = splitSentinels(finalBody);
    const row = docToRow(this.spec, this.id, this.branchId, plain);
    const { error } = await sb.from(this.spec.table).upsert(row, { onConflict: 'id' });
    if (error) throw error;
  }

  // Firestore update() merges top-level fields and fails if the doc is missing.
  async update(patch) {
    const { plain, incr, remove } = splitSentinels(patch);

    if (this.spec.mode === 'cols') {
      const row = docToRow(this.spec, this.id, this.branchId, plain);
      delete row.id;
      if (Object.keys(row).length) {
        const { error } = await sb.from(this.spec.table).update(row).eq('id', this.id);
        if (error) throw error;
      }
      return;
    }

    // JSONB path: one atomic RPC, so two cashiers saving at once cannot
    // overwrite each other's fields.
    if (Object.keys(plain).length || remove.length) {
      const { error } = await sb.rpc('ds_doc_patch', {
        p_table:  this.spec.table,
        p_id:     this.id,
        p_patch:  toJsonSafe(plain),
        p_remove: remove,
      });
      if (error) throw error;
    }
    if (Object.keys(incr).length) {
      const { error } = await sb.rpc('ds_doc_increment', {
        p_table:  this.spec.table,
        p_id:     this.id,
        p_fields: incr,
      });
      if (error) throw error;
    }
  }

  async delete() {
    const { error } = await sb.from(this.spec.table).delete().eq('id', this.id);
    if (error) throw error;
  }

  onSnapshot(onNext, onError) {
    const push = async () => {
      try { onNext(await this.get()); }
      catch (e) { if (onError) onError(e); else console.error('[DS] onSnapshot:', e); }
    };
    push();

    const channel = sb
      .channel(`doc:${this.spec.table}:${this.id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: this.spec.table,
        filter: `id=eq.${this.id}`,
      }, push)
      .subscribe();

    return () => sb.removeChannel(channel);
  }
}


// ============================================================================
//  PART 8 — COLLECTION REFERENCE / QUERY
// ============================================================================

class DsCollectionRef {
  constructor(collName, branchId, opts = {}) {
    this.collName = collName;
    this.branchId = branchId;
    this.spec     = tableSpec(collName);
    this.opts     = { orders: [], wheres: [], limitN: null, ...opts };
  }

  _derive(extra) {
    return new DsCollectionRef(this.collName, this.branchId, { ...this.opts, ...extra });
  }

  orderBy(field, dir = 'asc') {
    return this._derive({ orders: [...this.opts.orders, { field, dir }] });
  }

  where(field, op, value) {
    return this._derive({ wheres: [...this.opts.wheres, { field, op, value }] });
  }

  limit(n) { return this._derive({ limitN: n }); }

  // doc()      → a fresh client-generated id, like Firestore
  // doc('abc') → that specific document
  doc(id) {
    return new DsDocRef(this.collName, id || newId(), this.branchId);
  }

  async add(body) {
    const ref = this.doc();
    const { plain, incr } = splitSentinels(body);
    const merged = { ...plain };
    for (const [k, v] of Object.entries(incr)) merged[k] = v;   // no base row yet
    const row = docToRow(this.spec, ref.id, this.branchId, merged);

    try {
      const { error } = await sb.from(this.spec.table).insert(row);
      if (error) throw error;
      return ref;
    } catch (err) {
      // A real server/validation error (bad data, RLS, etc.) must still fail
      // exactly as it always has — only a genuine connectivity problem gets
      // queued for later. If the offline queue script isn't loaded on this
      // page for some reason, fail the old way too rather than half-work.
      if (!isNetworkFailure(err) || !window.DSOffline) throw err;

      const queueId = await window.DSOffline.enqueue({
        kind: 'add', table: this.spec.table, collName: this.collName,
        branchId: this.branchId, docId: ref.id, body: merged,
      });

      // What the UI sees immediately, before this ever reaches Supabase.
      const displayData = { ...merged };
      if (displayData.createdAt === SERVER_NOW_MARKER) displayData.createdAt = new Date().toISOString();
      // Orders never get a guessed number, online or offline (see genOrderId
      // in index.html) — show a clear placeholder until the real sequential
      // id is assigned at sync time.
      if (this.collName === 'orders' && (displayData.orderId === null || displayData.orderId === undefined)) {
        displayData.orderId = 'Syncing…';
      }
      pendingAdd(this.spec, this.branchId, ref.id, displayData, queueId);

      ref._pending = true;
      return ref;
    }
  }

  async get() {
    const key = cacheKey(this.spec, this.branchId, this.opts);
    let query = sb.from(this.spec.table).select('*');
    if (this.spec.scoped) {
      if (!this.branchId) throw new Error(`[DS] ${this.collName} needs a branch id.`);
      query = query.eq('branch_id', this.branchId);
    }

    const { data, error } = await query;
    if (error) {
      const cached = cacheRead(key);
      if (cached) {
        console.warn('[DS] Offline — serving cached', this.spec.table);
        return makeQuerySnapshot(applyQuery(mergePending(this.spec, this.branchId, cached), this.opts));
      }
      throw error;
    }

    const docs = (data || []).map(r => makeDocSnapshot(r.id, rowToDoc(this.spec, r)));
    cacheWrite(key, docs);
    return makeQuerySnapshot(applyQuery(mergePending(this.spec, this.branchId, docs), this.opts));
  }

  onSnapshot(onNext, onError) {
    let closed = false;
    const push = async () => {
      if (closed) return;
      try { onNext(await this.get()); }
      catch (e) { if (onError) onError(e); else console.error('[DS] onSnapshot:', e); }
    };
    push();

    const filter = this.spec.scoped ? `branch_id=eq.${this.branchId}` : undefined;
    const channel = sb
      .channel(`col:${this.spec.table}:${this.branchId || 'g'}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: this.spec.table, ...(filter ? { filter } : {}) },
          push)
      .subscribe();

    // Refresh the moment a write is queued or synced for this exact
    // table/branch, rather than waiting on the realtime round-trip.
    const onPendingChange = (e) => {
      const d = e.detail || {};
      if (d.table === this.spec.table && (!this.spec.scoped || d.branchId === this.branchId)) push();
    };
    window.addEventListener('ds-pending-changed', onPendingChange);

    return () => {
      closed = true;
      sb.removeChannel(channel);
      window.removeEventListener('ds-pending-changed', onPendingChange);
    };
  }
}

function newId() {
  return (crypto?.randomUUID?.() || 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
}


// ============================================================================
//  PART 9 — BATCH
//  Firestore batches are atomic. These are NOT — operations run in sequence and
//  a late failure leaves earlier ones applied. Every batch in this codebase is
//  a bulk delete or a one-time migration, where that is acceptable. If you ever
//  need real atomicity, move the whole batch into a Postgres function.
// ============================================================================

class DsBatch {
  constructor() { this.ops = []; }
  set(ref, data, options)  { this.ops.push(() => ref.set(data, options)); return this; }
  update(ref, data)        { this.ops.push(() => ref.update(data));       return this; }
  delete(ref)              { this.ops.push(() => ref.delete());           return this; }
  async commit() { for (const op of this.ops) await op(); this.ops = []; }
}


// ============================================================================
//  PART 10 — THE `db` OBJECT
// ============================================================================

const db = {
  collection: name => new DsCollectionRef(name, null),
  batch:      ()   => new DsBatch(),
  // Kept so the old call in firebase-config.js does not throw. Caching is
  // handled by PART 6 instead.
  enablePersistence: () => Promise.resolve(),
};
window.db = db;


// ============================================================================
//  PART 11 — `firebase` COMPATIBILITY OBJECT
//  So existing calls such as firebase.auth().signOut() and
//  firebase.firestore.FieldValue.serverTimestamp() keep working verbatim.
// ============================================================================

let _currentUser   = null;
let _authCallbacks = [];
let _authReady     = false;

function mapUser(session) {
  if (!session?.user) return null;
  const u = session.user;
  return { uid: u.id, email: u.email, displayName: u.user_metadata?.name || '', _raw: u };
}

// Translate Supabase auth errors into the Firebase codes login.html already
// knows how to display, so its error messages stay accurate.
function mapAuthError(err) {
  const m = (err?.message || '').toLowerCase();
  let code = 'auth/unknown';
  if (m.includes('invalid login credentials'))  code = 'auth/wrong-password';
  else if (m.includes('email not confirmed'))   code = 'auth/user-not-found';
  else if (m.includes('user not found'))        code = 'auth/user-not-found';
  else if (m.includes('invalid email'))         code = 'auth/invalid-email';
  else if (m.includes('rate limit') ||
           m.includes('too many'))              code = 'auth/too-many-requests';
  else if (m.includes('fetch') ||
           m.includes('network'))               code = 'auth/network-request-failed';
  const e = new Error(err?.message || 'Authentication failed');
  e.code = code;
  return e;
}

const authShim = {
  get currentUser() { return _currentUser; },

  onAuthStateChanged(cb) {
    _authCallbacks.push(cb);
    if (_authReady) cb(_currentUser);          // fire immediately if we already know
    return () => { _authCallbacks = _authCallbacks.filter(f => f !== cb); };
  },

  async signInWithEmailAndPassword(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw mapAuthError(error);
    return { user: mapUser(data.session) };
  },

  async signOut() {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k));
    const { error } = await sb.auth.signOut();
    if (error) throw mapAuthError(error);
  },

  async sendPasswordResetEmail(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email);
    if (error) throw mapAuthError(error);
  },
};

function fireAuthCallbacks() { _authCallbacks.forEach(cb => { try { cb(_currentUser); } catch (e) { console.error(e); } }); }

sb.auth.getSession().then(({ data }) => {
  _currentUser = mapUser(data.session);
  _authReady   = true;
  fireAuthCallbacks();
});

sb.auth.onAuthStateChange((_event, session) => {
  _currentUser = mapUser(session);
  _authReady   = true;
  fireAuthCallbacks();
});

window.firebase = {
  initializeApp: () => {},          // no-op, kept for compatibility
  auth:          () => authShim,
  firestore:     Object.assign(() => db, {
    FieldValue: {
      serverTimestamp: () => ({ [SENTINEL]: 'serverTimestamp' }),
      increment:  n    => ({ [SENTINEL]: 'increment', amount: Number(n) || 0 }),
      delete:     ()   => ({ [SENTINEL]: 'delete' }),
      arrayUnion:  (...v) => v,     // not used by this app; kept as a stub
      arrayRemove: (...v) => v,
    },
    Timestamp: {
      now:      () => new Date().toISOString(),
      fromDate: d  => d.toISOString(),
    },
  }),
};


// ============================================================================
//  PART 12 — USER / ROLE HELPERS   (same signatures as the Firebase version)
// ============================================================================

// Last-known-good profile per uid, refreshed on every successful fetch.
// Lets a previously-logged-in user resume their session while offline
// (see the fallback in getUserProfile below) instead of being signed out
// just because the role/branch lookup couldn't reach the network.
const PROFILE_CACHE_PREFIX = 'ds_profile_cache:';
function cacheProfile(uid, profile) {
  try { localStorage.setItem(PROFILE_CACHE_PREFIX + uid, JSON.stringify(profile)); } catch (e) {}
}
function readCachedProfile(uid) {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_PREFIX + uid);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

window.getUserProfile = async function (uid) {
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('role, branch_id, name, email')
      .eq('id', uid)
      .maybeSingle();

    if (error) {
      // Offline (or a dead connection) — fall back to whatever this device
      // last saw for this account rather than signing them out. A real
      // server-side error (RLS, etc.) still logs and returns null exactly
      // as before.
      if (isNetworkFailure(error)) {
        const cached = readCachedProfile(uid);
        if (cached) { console.warn('[DS] Offline — using cached profile for', uid); return cached; }
      }
      console.error('getUserProfile:', error);
      return null;
    }
    if (!data)  return null;

    const branchId = (data.branch_id || '').toLowerCase().trim() || null;
    const branch   = DS_BRANCHES.find(b => b.id === branchId) || null;

    // Auto-heal casing, exactly as the Firebase version did.
    if (data.branch_id && data.branch_id !== branchId) {
      sb.from('profiles').update({ branch_id: branchId }).eq('id', uid).then(() => {});
      console.warn(`[DS] Auto-fixed branchId casing: "${data.branch_id}" → "${branchId}"`);
    }

    const profile = {
      role:        data.role || 'branch',
      branchId:    branchId,
      branchName:  branch ? branch.name     : null,
      branchColor: branch ? branch.color    : null,
      branchGrad:  branch ? branch.gradient : null,
      name:        data.name || '',
      email:       data.email || '',
    };
    cacheProfile(uid, profile);
    return profile;
  } catch (e) {
    if (isNetworkFailure(e)) {
      const cached = readCachedProfile(uid);
      if (cached) { console.warn('[DS] Offline — using cached profile for', uid); return cached; }
    }
    console.error('getUserProfile:', e);
    return null;
  }
};

window.branchCol = function (branchId, collName) {
  return new DsCollectionRef(collName, (branchId || '').toLowerCase().trim());
};


// ============================================================================
//  PART 12b — PASSWORD MANAGEMENT
//  A signed-in user CAN change their own password with only the anon key —
//  that's what changeMyPassword/verifyCurrentPassword use below. Changing a
//  DIFFERENT account's password (the Super Admin resetting a branch login)
//  is not something the anon key is allowed to do, on purpose — that needs
//  the service_role key, which must never reach the browser. That one call
//  is proxied through a Supabase Edge Function ("admin-set-password") that
//  holds the service key server-side and re-checks the caller is an admin
//  before touching anything. See /supabase/functions/admin-set-password.
// ============================================================================

// Changes the currently signed-in user's own password.
window.changeMyPassword = async function (newPassword) {
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw mapAuthError(error);
};

// Re-authenticates the current user with a password, without disturbing the
// existing session, to confirm "yes, it's really you" before a sensitive
// change (used before changeMyPassword so a device left signed in isn't
// enough on its own to take over the account).
window.verifyCurrentPassword = async function (password) {
  const email = _currentUser?.email;
  if (!email) throw new Error('Not signed in.');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw mapAuthError(error);
};

// Changes a branch's login password. Only the Super Admin can call this
// successfully — the Edge Function checks that server-side regardless of
// what the browser sends. branchId must match a row in DS_BRANCHES.
window.changeBranchPassword = async function (branchId, newPassword) {
  const { data, error } = await sb.functions.invoke('admin-set-password', {
    body: { branchId, newPassword },
  });
  if (error) {
    let msg = error.message || 'Could not update the branch password.';
    try {
      if (error.context && typeof error.context.json === 'function') {
        const body = await error.context.json();
        if (body?.error) msg = body.error;
      }
    } catch (e) { /* fall back to error.message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
};


// ============================================================================
//  PART 13 — DEFAULT SERVICES SEEDING
//  Unchanged behaviour: only seeds a branch that has NO services at all.
//  Services are never deleted here — the admin Price Management panel owns them.
// ============================================================================

const _DEFAULT_SERVICES = [
  { name: 'Drop-Off, Wash, Fold', price: 210, duration: '1 day',    order: 1 },
  { name: 'Drop-Off, Wash',       price: 180, duration: 'Same day', order: 2 },
];

const _DEFAULT_ADDONS = [
  { name: 'Fabcon',    price: 15, order: 1 },
  { name: 'Bleach',    price: 15, order: 2 },
  { name: 'Detergent', price: 15, order: 3 },
];

async function _seedBranch(branchId) {
  if (!branchId) return;
  branchId = branchId.toLowerCase().trim();
  try {
    const svcSnap = await branchCol(branchId, 'services').limit(1).get();

    if (svcSnap.empty) {
      for (const svc of _DEFAULT_SERVICES) {
        await branchCol(branchId, 'services').add(svc);
      }
      const addonSnap = await branchCol(branchId, 'addons').limit(1).get();
      if (addonSnap.empty) {
        for (const a of _DEFAULT_ADDONS) {
          await branchCol(branchId, 'addons').add(a);
        }
      }
      console.log('[DS] Default services seeded for branch:', branchId);
    }

    // Make sure the branch row exists and carries its display name.
    const meta = DS_BRANCHES.find(b => b.id === branchId);
    await db.collection('branches').doc(branchId)
      .set({ name: meta?.name || branchId, color: meta?.color, gradient: meta?.gradient }, { merge: true });

  } catch (e) { console.error('Seed error:', branchId, e); }
}

firebase.auth().onAuthStateChanged(async user => {
  if (!user) return;
  const profile = await getUserProfile(user.uid);
  if (!profile) return;
  if (profile.role === 'admin') {
    for (const b of DS_BRANCHES) await _seedBranch(b.id);
  } else if (profile.branchId) {
    await _seedBranch(profile.branchId);
  }
});


// ============================================================================
//  PART 14 — OFFLINE SYNC: REPLAY A QUEUED WRITE
//  Called by offline-queue.js, strictly in order, once the browser is back
//  online. Only 'add' is ever queued right now (see PART 6b).
// ============================================================================

if (window.DSOffline) {
  window.DSOffline.registerHandler(async function (op) {
    if (op.kind !== 'add') return;   // future-proofing; nothing else is queued yet

    const spec = tableSpec(op.collName);
    const body = { ...op.body };

    // Orders never get a guessed number offline — the real, gap-free
    // sequential id is only ever assigned here, now that Postgres can
    // actually be asked for one. Same RPC, same guarantee, as an online
    // create (see genOrderId in index.html).
    if (op.collName === 'orders' && (body.orderId === null || body.orderId === undefined)) {
      const { data, error } = await sb.rpc('ds_next_order_id', { p_branch_id: op.branchId });
      if (error) throw error;
      body.orderId = data;
    }

    const row = docToRow(spec, op.docId, op.branchId, body);
    const { error } = await sb.from(spec.table).insert(row);
    if (error) throw error;

    pendingRemove(spec, op.branchId, op.docId);
  });
}