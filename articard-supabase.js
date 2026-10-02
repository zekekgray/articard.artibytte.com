/* =====================================================================
   articard-supabase.js — ArtiCard ⇄ Supabase connector
   Load AFTER the Supabase CDN and BEFORE your main <script>:

   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script src="/articard-supabase.js"></script>

   Exposes window.AC:
     AC.auth      sendOtp / verifyOtp / signOut / hasSession
     AC.contacts  list / insert / update / remove
     AC.notes     list / save / remove
     AC.personalInfo get / save
     AC.compat    get / post   (drop-in for your old apiGet / apiPost)
   ===================================================================== */
(function () {
  'use strict';

  /* ── CONFIG: Supabase Dashboard → Project Settings → API ───────────
     Only the anon (public) key goes here. NEVER put service_role in
     the frontend. */
  const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
  const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('Supabase SDK not loaded — AC disabled, legacy API stays active.');
    return;
  }
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  /* ── helpers ─────────────────────────────────────────────────────── */
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const pad2 = n => String(n).padStart(2, '0');

  function longToIso(s) {                       // "October 5, 2026" → "2026-10-05"
    const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(String(s || '').trim());
    const i = m ? MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase()) : -1;
    if (i < 0) throw new Error('Invalid date');
    return m[3] + '-' + pad2(i + 1) + '-' + pad2(+m[2]);
  }
  function isoToLong(s) {                       // "2026-10-05" → "October 5, 2026"
    const a = String(s).slice(0, 10).split('-').map(Number);
    return MONTHS[a[1] - 1] + ' ' + a[2] + ', ' + a[0];
  }
  function to24(s) {                            // "9:15 AM" → "09:15"
    const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(String(s || '').trim());
    if (!m) throw new Error('Invalid time');
    let h = (+m[1]) % 12; if (m[3] === 'PM') h += 12;
    return pad2(h) + ':' + m[2];
  }
  function to12(t) {                            // "09:15:00" → "9:15 AM"
    const a = String(t).split(':').map(Number);
    return ((a[0] % 12) || 12) + ':' + pad2(a[1]) + ' ' + (a[0] >= 12 ? 'PM' : 'AM');
  }

  function fail(error) {
    if (!error) return;
    if (error.code === '23505') throw new Error('That time slot is already booked.');
    throw new Error(error.message || 'Request failed');
  }
  async function need() {                       // owner-only calls
    const { data } = await sb.auth.getSession();
    if (!data.session) throw new Error('Please sign in again (session expired).');
    return data.session.user;
  }
  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    fail(error);
    return data;
  }

  /* ── AUTH (owner = Supabase Auth user, email OTP) ───────────────── */
  const auth = {
    sendOtp: async email => {
      const { error } = await sb.auth.signInWithOtp({ email: String(email).trim().toLowerCase(), options: { shouldCreateUser: false } });
      fail(error);
    },
    verifyOtp: async (email, code) => {
      const { data, error } = await sb.auth.verifyOtp({ email: String(email).trim().toLowerCase(), token: String(code).trim(), type: 'email' });
      fail(error);
      // keep your existing "is owner signed in?" checks working
      sessionStorage.setItem('athna-owner-token', 'supabase');
      sessionStorage.setItem('athna-owner-session', '1');
      return data.session;
    },
    signOut: async () => {
      await sb.auth.signOut();
      sessionStorage.removeItem('athna-owner-token');
      sessionStorage.removeItem('athna-owner-session');
    },
    hasSession: async () => !!(await sb.auth.getSession()).data.session
  };

  /* ── CARD ────────────────────────────────────────────────────────── */
  const CARD_COLS = { name:'name', position:'job_title', company:'company', phone:'phone', email:'email',
    linkedin:'linkedin', website:'website', theme:'theme', colorway:'colorway', mascotId:'mascot_id', qrLink:'qr_link' };

  function toApiCard(r) {
    return { cardId:r.card_id, athId:r.ath_id, no:r.card_no, name:r.name, position:r.job_title, company:r.company,
      phone:r.phone, email:r.email, linkedin:r.linkedin, website:r.website, theme:r.theme,
      colorway:r.colorway, mascotId:r.mascot_id, qrLink:r.qr_link };
  }

  /* ── MEETINGS ────────────────────────────────────────────────────── */
  function toApiMeeting(r) {
    return { meetingId:r.meeting_id, guestName:r.guest_name, guestEmail:r.guest_email, guestOrg:r.guest_org,
      guestPhone:r.guest_phone, notes:r.notes, type:r.meeting_type, date:isoToLong(r.meeting_date),
      time:to12(r.meeting_time), duration:r.duration, location:r.location, locationAddress:r.location_address,
      recurrence:r.recurrence, requestStatus:r.status, meetingLink:r.meeting_link || '', createdAt:r.created_at };
  }

  /* ── CONTACTS (canonical schema both ways) ──────────────────────── */
  function contactFromRow(r) {
    return { id:r.id, firstName:r.first_name, lastName:r.last_name, displayName:r.display_name,
      company:r.company, role:r.role, phones:r.phones || [], emails:r.emails || [], address:r.address,
      socials:r.socials || {}, tags:r.tags || [], notes:r.notes, avatar:{ bg:r.avatar_bg }, source:r.source,
      metAt:r.met_at, lastContactedAt:r.last_contacted_at || '', createdAt:r.created_at, updatedAt:r.updated_at };
  }
  function contactToRow(c) {
    return { first_name:c.firstName || '', last_name:c.lastName || '', display_name:c.displayName || c.name || 'Unnamed',
      company:c.company || '', role:c.role || '', phones:c.phones || [], emails:c.emails || [], address:c.address || '',
      socials:c.socials || {}, tags:c.tags || [], notes:c.notes || '', avatar_bg:(c.avatar && c.avatar.bg) || '#8E8E93',
      source:c.source || '', met_at:c.metAt || '', last_contacted_at:c.lastContactedAt || null };
  }
  const contacts = {
    list: async () => { await need(); const { data, error } = await sb.from('contacts').select('*').order('display_name'); fail(error); return data.map(contactFromRow); },
    insert: async c => { await need(); const { data, error } = await sb.from('contacts').insert(contactToRow(c)).select().single(); fail(error); return contactFromRow(data); },   // returns row WITH the real id
    update: async (id, c) => { await need(); const { data, error } = await sb.from('contacts').update(contactToRow(c)).eq('id', id).select().single(); fail(error); return contactFromRow(data); },
    remove: async id => { await need(); const { error } = await sb.from('contacts').delete().eq('id', id); fail(error); }
  };

  /* ── NOTES (Captures) ───────────────────────────────────────────── */
  const noteFromRow = r => ({ id:r.id, title:r.title, body:r.body, pinned:r.pinned, ts:Date.parse(r.updated_at) });
  const notes = {
    list: async () => { await need(); const { data, error } = await sb.from('notes').select('*').order('updated_at', { ascending:false }); fail(error); return data.map(noteFromRow); },
    save: async n => {                                    // n.id undefined/non-uuid → insert
      await need();
      const row = { title:n.title || 'New Note', body:n.body || '', pinned:!!n.pinned };
      const isUuid = /^[0-9a-f-]{36}$/i.test(String(n.id || ''));
      const q = isUuid ? sb.from('notes').update(row).eq('id', n.id) : sb.from('notes').insert(row);
      const { data, error } = await q.select().single(); fail(error); return noteFromRow(data);
    },
    remove: async id => { await need(); const { error } = await sb.from('notes').delete().eq('id', id); fail(error); }
  };

  /* ── PERSONAL INFO (one JSON doc) ───────────────────────────────── */
  const personalInfo = {
    get: async () => { await need(); const { data, error } = await sb.from('personal_info').select('data').maybeSingle(); fail(error); return (data && data.data) || {}; },
    save: async obj => { const u = await need(); const { error } = await sb.from('personal_info').upsert({ owner_id:u.id, data:obj }); fail(error); return true; }
  };

  /* ── COMPAT LAYER: same actions your app already calls ──────────── */
  const compat = {
    async get(action, p) {
      p = p || {};
      if (action === 'card') {
        const d = await rpc('get_public_card', { p_id: p.id });
        if (!d) throw new Error('Card not found');
        return d;
      }
      if (action === 'availability') {
        const times = await rpc('get_availability', { p_card_id: p.cardId, p_date: longToIso(p.date), p_duration: p.duration || '30 min' });
        return { times: times || [] };
      }
      throw new Error('Unsupported GET action: ' + action);
    },

    async post(action, p) {
      p = p || {};
      switch (action) {
        /* public */
        case 'saveMeeting': {
          const d = await rpc('request_meeting', {
            p_card_id: p.cardId, p_name: p.name, p_email: p.email, p_org: p.org || '', p_phone: p.phone || '',
            p_notes: p.notes || '', p_type: p.type, p_date: longToIso(p.date), p_time: to24(p.time),
            p_duration: p.duration, p_location: p.location, p_address: p.locationAddress || '',
            p_recurrence: p.recurrence, p_timezone: p.timezone });
          return d;
        }
        case 'saveLead':
          await rpc('save_lead', { p_card_id: p.cardId, p_name: p.name, p_title: p.title || '', p_email: p.email || '', p_mobile: p.mobile || '' });
          return true;

        /* owner */
        case 'ownerLogin':
          throw new Error('Owner login now uses email OTP. Use AC.auth.sendOtp / verifyOtp.');
        case 'ownerLogout':
          await auth.signOut(); return true;
        case 'ownerGetCard': {
          await need();
          const { data, error } = await sb.from('cards').select('*').maybeSingle(); fail(error);
          if (!data) throw new Error('No card linked to this account.');
          return toApiCard(data);
        }
        case 'ownerUpdateCard': {
          await need();
          const row = {};
          Object.keys(p.fields || {}).forEach(k => { if (CARD_COLS[k]) row[CARD_COLS[k]] = p.fields[k]; });
          if (!Object.keys(row).length) return true;
          const u = await need();
          const { error } = await sb.from('cards').update(row).eq('owner_id', u.id); fail(error);
          return true;
        }
        case 'ownerListMeetings': {
          await need();
          const { data, error } = await sb.from('meetings').select('*').order('created_at', { ascending:false }); fail(error);
          return data.map(toApiMeeting);
        }
        case 'ownerUpdateMeetingStatus': {
          await need();
          const { error } = await sb.from('meetings').update({ status: p.status }).eq('meeting_id', p.meetingId); fail(error);
          return true;
        }
        case 'ownerCreateMeeting': {
          await need();
          const { data, error } = await sb.from('meetings').insert({
            guest_name:p.name, guest_email:p.guestEmail || '', guest_org:p.guestOrg || '', guest_phone:p.guestPhone || '',
            notes:p.notes || '', meeting_type:p.type, meeting_date:longToIso(p.date), meeting_time:to24(p.time),
            duration:p.duration || '30 min', location:p.location || 'Videocall / Virtual Call',
            location_address:p.locationAddress || '', recurrence:p.recurrence || 'One-time',
            status:'Confirmed', created_by:'owner' }).select().single();
          fail(error); return toApiMeeting(data);
        }
        case 'ownerEditMeeting': {
          await need();
          const { data, error } = await sb.from('meetings').update({
            guest_name:p.name, meeting_type:p.type, meeting_date:longToIso(p.date), meeting_time:to24(p.time) })
            .eq('meeting_id', p.meetingId).select().single();
          fail(error); return toApiMeeting(data);
        }

        /* feedback (owner is signed in when rating) */
        case 'saveFeedback': {
          const u = await need();
          const { error } = await sb.from('feedback').insert({
            owner_id:u.id, type:p.type || 'feedback', context:p.context || '', category:p.category || '',
            ath_id:p.athId || '', name:p.name || '', stars:p.stars ?? null, remarks:p.remarks || '',
            client_ts:p.clientTs || null }); fail(error);
          return true;
        }
      }
      throw new Error('Unsupported POST action: ' + action);
    }
  };

  window.AC = { sb, auth, contacts, notes, personalInfo, compat };
})();
