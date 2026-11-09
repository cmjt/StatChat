// Activity presets (step 2): chosen at login, enforced on the server, visible to students.

setSheets({
  Instructors: [['instructor_id', 'password', 'display_name'], ['i1', 'pw1', 'Ann']],
  // Deliberately without submission_type / peer_review columns: they must be added automatically
  Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
  Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden']],
  PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
  PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
  Settings: [['key', 'value']],
  ProfanityList: [['badword']],
});
const token = apiInstructorLogin('i1', 'pw1').token;

// Quick response
let r = apiStartSession(token, 'q1', 60, 'respond');
eq('respond preset applied', [r.settings.preset, r.settings.submission_type, r.settings.peer_review], ['respond', 'text', false]);
eq('settings columns added to Sessions', ['submission_type', 'peer_review'].every(c => sheetRows('Sessions')[0].includes(c)), true);
let v = apiGetStudentView('i1');
eq('student sees quick response, writing', [v.session_id, v.phase, v.writing_open, v.settings.preset], ['q1', 'writing', true, 'respond']);
throws('peer review refused in quick response', () => apiStartPeerReview(token, 'q1', 1, ''), /not enabled/);
throws('review phase refused in quick response', () => apiSetPhase(token, 'q1', 'review'), /not enabled/);
eq('student can submit text', apiSubmitResponse('q1', { response_text_original: 'hello there', reviewer_token: 'stu1' }).ok, true);

// Switching preset while the session is live in writing is allowed
r = apiStartSession(token, 'q1', 60, 'peer');
eq('switch to peer while writing', [r.settings.preset, r.settings_kept], ['peer', false]);
eq('student view updates immediately (cache cleared)', apiGetStudentView('i1').settings.preset, 'peer');
eq('peer review opens', apiStartPeerReview(token, 'q1', 1, '').ok, true);
v = apiGetStudentView('i1');
eq('student sees review phase', [v.phase, v.reviews_open, v.settings.peer_review], ['review', true, true]);

// Mid-review, a different preset at login is not applied
r = apiStartSession(token, 'q1', 60, 'respond');
eq('settings kept during review', [r.settings.preset, r.settings_kept, r.phase], ['peer', true, 'review']);

// Back to writing, then the preset can change again
apiSetPhase(token, 'q1', 'writing');
r = apiStartSession(token, 'q1', 60, 'respond');
eq('after review ends, preset applies', [r.settings.preset, r.settings_kept], ['respond', false]);

throws('unknown preset rejected', () => apiStartSession(token, 'q2', 60, 'karaoke'), /Unknown activity/);
throws('blank session id rejected', () => apiStartSession(token, '  ', 60, 'respond'), /session ID/);
throws('instructor calls need a valid token', () => apiStartSession('bogus', 'q3', 60, 'respond'), /expired/);

// Legacy sessions (blank settings) behave as before: text + peer review allowed
eq('legacy session: peer allowed', getSessionSettings_({ submission_type: '', peer_review: '' }), { submission_type: 'text', peer_review: true, preset: 'peer', label: 'Peer review', background: 'blank' });

// Cache really serves repeat polls, and instructor actions invalidate it
const before = apiGetStudentView('i1');
sheetObjects('Sessions');                                  // edit the sheet behind the cache's back:
const S = sheetRows('Sessions'); S[1][S[0].indexOf('phase')] = 'review'; S[1][S[0].indexOf('peer_open')] = 'TRUE';
eq('poll within cache window returns cached view', apiGetStudentView('i1').phase, before.phase);
apiExtendSession(token, 'q1', 30);
eq('instructor action clears the cache', apiGetStudentView('i1').phase, 'review');
apiStopSession(token, 'q1');
eq('stop is visible to students at once', apiGetStudentView('i1').writing_open, false);
