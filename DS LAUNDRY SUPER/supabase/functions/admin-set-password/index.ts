// ============================================================================
//  Supabase Edge Function: admin-set-password
//
//  WHY THIS EXISTS
//  ----------------
//  The browser only ever holds the Supabase *anon* key, which is allowed to
//  change the password of the account that is CURRENTLY SIGNED IN (see
//  changeMyPassword in supabase-config.js) but nothing else. Resetting a
//  BRANCH account's password — a different user — requires the
//  service_role key, and that key must never be shipped to client code
//  (anyone could open dev tools and take over every account in the
//  project). So this one privileged action runs here instead, server-side,
//  where the service_role key stays a secret.
//
//  WHAT IT CHECKS
//  --------------
//  1. The caller sent a valid Supabase session token (they're signed in).
//  2. That signed-in user's profile has role = 'admin'. Only the Super
//     Admin can reset a branch's password — a branch account calling this
//     for itself, or for another branch, is refused.
//
//  DEPLOY
//  ------
//    supabase functions deploy admin-set-password
//
//  No manual secrets to add — Supabase automatically provides SUPABASE_URL
//  and SUPABASE_SERVICE_ROLE_KEY to every Edge Function in the project.
//
//  REQUEST BODY (POST, JSON)
//  -------------------------
//    { "branchId": "ubujan", "newPassword": "..." }
//
//  branchId must be one of: ubujan, taloto, bingag, catarman — matching
//  DS_BRANCHES in supabase-config.js. Each of those must already have a row
//  in `profiles` with role = 'branch' and that branch_id, created the same
//  way the Super Admin's own account was (Supabase Auth → add user).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BRANCH_IDS = ['ubujan', 'taloto', 'bingag', 'catarman'];

// Your admin.html/index.html are served from a different origin than this
// function (e.g. 127.0.0.1:5500 vs supabase.co), so the browser requires
// these CORS headers on EVERY response — including the automatic "preflight"
// OPTIONS request it sends before the real POST. Without this, supabase-js
// reports the generic "Failed to send a request to the Edge Function", which
// is really the browser silently blocking the response, not a server error.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  // The browser's CORS preflight — must be answered before it will send the
  // real POST at all.
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'Missing Authorization header.' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    // 1) Who is calling? Validate their token against the service client.
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: 'Not signed in.' }, 401);
    }
    const callerId = userData.user.id;

    // 2) Are they the Super Admin? Everyone else is refused, no exceptions.
    const { data: callerProfile, error: profErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', callerId)
      .maybeSingle();

    if (profErr || !callerProfile || callerProfile.role !== 'admin') {
      return json({ error: 'Only the Super Admin can change branch passwords.' }, 403);
    }

    // 3) Validate input.
    const body = await req.json().catch(() => ({}));
    const { branchId, newPassword } = body as { branchId?: string; newPassword?: string };

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return json({ error: 'Password must be at least 8 characters.' }, 400);
    }
    if (!branchId || !BRANCH_IDS.includes(branchId)) {
      return json({ error: 'Unknown branch.' }, 400);
    }

    // 4) Find that branch's login account.
    const { data: branchProfile, error: bpErr } = await admin
      .from('profiles')
      .select('id')
      .eq('branch_id', branchId)
      .eq('role', 'branch')
      .maybeSingle();

    if (bpErr || !branchProfile) {
      return json({ error: 'No login account is set up yet for that branch.' }, 404);
    }

    // 5) Reset it. This is the one call that genuinely requires service_role.
    const { error: setErr } = await admin.auth.admin.updateUserById(branchProfile.id, {
      password: newPassword,
    });
    if (setErr) return json({ error: setErr.message }, 400);

    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message || 'Unexpected error.' }, 500);
  }
});