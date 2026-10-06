/*! articardd SDK v1.0
 * Drop-in replacement for apiPost/apiGet. Routes each action to Apps Script or
 * Supabase (Edge Function "api"), same {action, payload} -> {success,data,error} contract.
 *
 * mode:    'appscript' (default, zero behavior change) | 'supabase'
 * routes:  per-action override, e.g. { card: 'supabase' }
 * dualLogin: on ownerLogin, also sign in to the other backend so hybrid routing keeps working
 *            (sessions/tokens are backend-specific).
 * fallback: if a PUBLIC action fails on a network/5xx error, retry on the other backend.
 */
(function (w) {
  'use strict';

  var GET_ACTIONS = { ping: 1, card: 1, availability: 1 };           // Apps Script uses GET for these
  var PUBLIC = { ping: 1, card: 1, availability: 1, saveMeeting: 1, guestLookup: 1, guestCancel: 1, saveLead: 1, saveFeedback: 1 };
  var TK = 'ac-sdk-tokens';

  var cfg = {
    mode: 'appscript',
    appscriptUrl: '',
    supabaseUrl: '',          // https://xxxx.supabase.co
    supabaseKey: '',          // anon / publishable key (safe to expose; tables are RLS-locked)
    functionName: 'api',
    routes: {},
    fallback: true,
    dualLogin: false,
    timeoutMs: 20000,
    debug: false
  };

  function configure(o) { for (var k in (o || {})) cfg[k] = o[k]; return cfg; }
  if (w.AC_CONFIG) configure(w.AC_CONFIG);

  function log() { if (cfg.debug) console.log.apply(console, ['[acsdk]'].concat([].slice.call(arguments))); }

  function available(b) { return b === 'supabase' ? !!(cfg.supabaseUrl && cfg.supabaseKey) : !!cfg.appscriptUrl; }
  function backendFor(action) {
    var b = cfg.routes[action] || cfg.mode;
    if (!available(b)) b = b === 'supabase' ? 'appscript' : 'supabase';
    return b;
  }

  /* ---- per-backend tokens ---- */
  function readTokens() { try { return JSON.parse(localStorage.getItem(TK) || '{}'); } catch (e) { return {}; } }
  function writeTokens(t) { try { localStorage.setItem(TK, JSON.stringify(t)); } catch (e) {} }
  function saveToken(b, d) {
    if (!d || !d.token) return;
    var t = readTokens(); t[b] = { t: d.token, exp: d.expiresAt || '' }; writeTokens(t);
  }
  function tokenFor(b) {
    var x = readTokens()[b];
    if (!x) return '';
    if (x.exp && Date.parse(x.exp) < Date.now()) return '';
    return x.t;
  }
  function clearTokens() { try { localStorage.removeItem(TK); } catch (e) {} }

  /* ---- transport ---- */
  function timedFetch(url, opts) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, cfg.timeoutMs) : null;
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; }, function (e) {
      clearTimeout(timer); e.network = true; throw e;
    });
  }

  function parse(res) {
    return res.json().then(function (j) {
      if (!j || !j.success) throw new Error((j && j.error) || 'Request failed');
      return j.data;
    }, function () {
      var e = new Error('Bad response from server'); e.network = true; throw e;
    });
  }

  function send(b, action, payload) {
    log(b, action);
    if (b === 'supabase') {
      return timedFetch(cfg.supabaseUrl.replace(/\/$/, '') + '/functions/v1/' + cfg.functionName, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseKey, Authorization: 'Bearer ' + cfg.supabaseKey },
        body: JSON.stringify({ action: action, payload: payload })
      }).then(function (res) {
        if (res.status >= 500) { var e = new Error('Server error'); e.network = true; throw e; }
        return parse(res);
      });
    }
    if (GET_ACTIONS[action]) {
      var qs = new URLSearchParams(Object.assign({ action: action }, payload)).toString();
      return timedFetch(cfg.appscriptUrl + '?' + qs, {}).then(parse);
    }
    return timedFetch(cfg.appscriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },     // avoids CORS preflight on Apps Script
      body: JSON.stringify({ action: action, payload: payload })
    }).then(parse);
  }

  function run(b, action, payload) {
    var p = Object.assign({}, payload);
    if ('token' in p) { var t = tokenFor(b); if (t) p.token = t; }  // swap in this backend's own token
    return send(b, action, p);
  }

  /* ---- auth actions (need both backends' tokens in hybrid mode) ---- */
  function login(payload, primary) {
    var other = primary === 'supabase' ? 'appscript' : 'supabase';
    if (cfg.dualLogin && available(other)) {
      run(other, 'ownerLogin', payload).then(function (d) { saveToken(other, d); }, function (e) { log('secondary login failed', e && e.message); });
    }
    return run(primary, 'ownerLogin', payload).then(function (d) { saveToken(primary, d); return d; });
  }
  function logout(payload) {
    var jobs = ['appscript', 'supabase'].filter(function (b) { return available(b) && tokenFor(b); })
      .map(function (b) { return run(b, 'ownerLogout', payload).catch(function () {}); });
    return Promise.all(jobs).then(function () { clearTokens(); return { ok: true }; });
  }

  /* ---- public API ---- */
  function call(action, payload) {
    payload = payload || {};
    var primary = backendFor(action);
    if (action === 'ownerLogin') return login(payload, primary);
    if (action === 'ownerLogout') return logout(payload);
    return run(primary, action, payload).catch(function (e) {
      var other = primary === 'supabase' ? 'appscript' : 'supabase';
      if (cfg.fallback && PUBLIC[action] && e && e.network && available(other)) {
        log('fallback ->', other, action);
        return run(other, action, payload);
      }
      throw e;
    });
  }

  function health() {
    var out = {};
    return Promise.all(['appscript', 'supabase'].filter(available).map(function (b) {
      return run(b, 'ping', {}).then(function (d) { out[b] = { ok: true, version: d && d.version }; },
                                     function (e) { out[b] = { ok: false, error: e.message }; });
    })).then(function () { return out; });
  }

  w.ACSDK = { configure: configure, call: call, backendFor: backendFor, clearTokens: clearTokens, health: health, config: cfg };
})(window);
