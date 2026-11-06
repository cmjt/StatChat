// Auth.gs — Instructor login tokens, password hashing and ownership checks.
// All .gs files share one global scope in Apps Script.

function getInstructorById_(instructor_id) {
  const sh = getSheetByName(SHEET_INSTRUCTORS);
  const { header: hdr, rows } = readTable(sh);
  const idCol = hdr.indexOf('instructor_id');
  if (idCol === -1) throw new Error('Missing column instructor_id in Instructors.');
  for (const r of rows) {
    if (String(r[idCol]) === String(instructor_id)) {
      const rec = {}; hdr.forEach((h,i)=>rec[h]=r[i]);
      return rec;
    }
  }
  return null;
}

// Login issues a random token kept server-side in CacheService. Every instructor API call
// must present that token; the instructor_id is taken from the token, never from the client.
// NOTE: any top-level function whose name does NOT end in "_" can be called from the
// browser via google.script.run, so internal helpers must end in "_".
const AUTH_TOKEN_TTL_SECS = 6 * 60 * 60;  // CacheService maximum; renewed on every call

const LOGIN_MAX_FAILS     = 5;            // failed attempts per instructor ID...

const LOGIN_LOCKOUT_SECS  = 15 * 60;      // ...before logins are refused for this long

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + String(password), Utilities.Charset.UTF_8);
  return 'sha256$' + salt + '$' + Utilities.base64Encode(bytes);
}

/** Accepts salted hashes ("sha256$salt$hash") and, for backwards compatibility, plaintext. */
function checkPassword_(stored, password) {
  stored = String(stored == null ? '' : stored);
  if (!stored) return false;
  if (stored.indexOf('sha256$') === 0) {
    const salt = stored.split('$')[1] || '';
    return hashPassword_(password, salt) === stored;
  }
  return stored === String(password);
}

/** Resolve a login token to its instructor_id, or throw. Renews the token's lifetime. */
function requireInstructor_(token) {
  const t = String(token || '');
  const cache = CacheService.getScriptCache();
  const instructor_id = t ? cache.get('inst_tok_' + t) : null;
  if (!instructor_id) {
    throw new Error('Your login has expired. Please reload the dashboard and log in again.');
  }
  cache.put('inst_tok_' + t, instructor_id, AUTH_TOKEN_TTL_SECS);
  return instructor_id;
}

/** Throw unless session_id exists and belongs to instructor_id. */
function requireSessionOwner_(instructor_id, session_id) {
  const session = getSession(session_id);
  if (!session || String(session.instructor_id) !== String(instructor_id)) {
    throw new Error('Session not found or not owned by instructor.');
  }
  return session;
}

/** Login with instructor_id + password; returns a token for subsequent instructor calls */
function apiInstructorLogin(instructor_id, password) {
  const id = String(instructor_id || '').trim();
  if (!id || !password) throw new Error('Invalid instructor ID or password.');

  const cache = CacheService.getScriptCache();
  const failKey = 'login_fail_' + id.toLowerCase();
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAILS) {
    throw new Error('Too many failed attempts. Please wait 15 minutes and try again.');
  }

  const sh = getSheetByName(SHEET_INSTRUCTORS);
  const { header: hdr, rows } = readTable(sh);

  const col = (name)=>{ const i = hdr.indexOf(name); if (i===-1) throw new Error(`Missing column: ${name}`); return i; };
  const idCol = col('instructor_id');
  const pwCol = col('password');
  const dnCol = hdr.indexOf('display_name');

  const match = rows.find(r => String(r[idCol]).trim() === id && checkPassword_(r[pwCol], password));
  if (!match) {
    cache.put(failKey, String(fails + 1), LOGIN_LOCKOUT_SECS);
    throw new Error('Invalid instructor ID or password.');
  }
  cache.remove(failKey);

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('inst_tok_' + token, id, AUTH_TOKEN_TTL_SECS);
  return { ok:true, instructor_id: id, display_name: dnCol>=0 ? String(match[dnCol]||'') : '', token };
}

/**
 * Run once from the Apps Script editor (select it in the function dropdown and click Run)
 * to replace plaintext passwords in the Instructors sheet with salted hashes.
 * Safe to re-run: already-hashed passwords are left alone. Reveals nothing if called remotely.
 */
function hashInstructorPasswords() {
  const sh = getSheetByName(SHEET_INSTRUCTORS);
  const { header: hdr, rows } = readTable(sh);
  const pwCol = idxRequired(hdr, 'password');
  let converted = 0;
  rows.forEach((r, i) => {
    const pw = String(r[pwCol] == null ? '' : r[pwCol]);
    if (!pw || pw.indexOf('sha256$') === 0) return;
    const salt = Utilities.getUuid().replace(/-/g, '');
    sh.getRange(2 + i, pwCol + 1).setValue(hashPassword_(pw, salt));
    converted++;
  });
  Logger.log(`Hashed ${converted} password(s).`);
  return converted;
}
