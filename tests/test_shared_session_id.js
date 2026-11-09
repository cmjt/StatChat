// Two instructors using the same session ID (e.g. "testing"), and stray spaces in IDs.

const SHDR = ['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'archived', 'peer_open'];
function setup(extraSessions) {
  setSheets({
    Instructors: [['instructor_id', 'password'], ['alice', 'pw'], ['bob', 'pw']],
    Sessions: [SHDR].concat(extraSessions || []),
  });
  __cache.clear();
}

// Alice already has a "testing" row higher up the sheet; Bob starts his own "testing".
setup([['testing', 'alice', 'writing', 'TRUE', 'TRUE', H(1), H(-1), 'FALSE', 'FALSE']]);
let tok = apiInstructorLogin('bob', 'pw').token;
apiStartSession(tok, 'testing', 30, 'peer');
let st = apiGetSessionState(tok, 'testing');
eq('second instructor with same session ID can load it', [st.ok, st.session_id], [true, 'testing']);
eq('their own settings are used', st.settings.preset, 'peer');
const objs = sheetObjects('Sessions');
eq('second instructor gets their own row', objs.map(o => o.instructor_id), ['alice', 'bob']);
eq('first instructor\'s row is untouched', objs[0].peer_review, '');

// Instructor ID typed into the sheet with a trailing space
setup([['testing', 'bob ', 'writing', 'TRUE', 'TRUE', H(1), H(-1), 'FALSE', 'FALSE']]);
tok = apiInstructorLogin('bob', 'pw').token;
apiStartSession(tok, 'testing', 30, 'respond');
eq('trailing space in instructor_id: reuses the row', sheetRows('Sessions').length, 2);
eq('trailing space in instructor_id: state loads', apiGetSessionState(tok, 'testing').ok, true);

// Someone else's session is still refused
setup([['secret', 'alice', 'writing', 'TRUE', 'TRUE', H(1), H(-1), 'FALSE', 'FALSE']]);
throws('other instructor\'s session refused', () => apiGetSessionState(apiInstructorLogin('bob', 'pw').token, 'secret'), /not owned/);
