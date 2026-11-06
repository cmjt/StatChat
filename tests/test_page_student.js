// @page student
// The student page follows the instructor's choices: run a whole class as a script and check
// what the page shows after each poll.

setSheets({
  Instructors: [['instructor_id', 'password'], ['i1', 'pw1']],
  Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
  Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden']],
  PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
  PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
  Settings: [['key', 'value']],
  ProfanityList: [['badword']],
});
const tok = __SERVER.apiInstructorLogin('i1', 'pw1').token;
const snapshot = () => ({
  activity: el('activityLabel').textContent, status: el('sessionStatus').textContent,
  writing: !el('responseText').disabled, submit: !el('submitBtn').disabled,
  review: el('reviewPanel').style.display === 'block', note: el('modeNote').style.display === 'block',
});

// 1. No activity yet
init();
eq('no activity: nothing to do, polling continues', snapshot(),
   { activity: '—', status: 'No active session', writing: false, submit: false, review: false, note: false });

// 2. Instructor starts a quick response: the page switches on the next poll
__SERVER.apiStartSession(tok, 'poll1', 60, 'respond');
pollView();
eq('quick response appears', snapshot(),
   { activity: 'Quick response', status: 'Open', writing: true, submit: true, review: false, note: false });
eq('student is told', el('phaseToast').textContent, 'A new activity has started: Quick response.');

// 3. Polling with no change doesn't disturb a draft
el('responseText').value = 'my half-written answer';
const sig = VIEW_SIG;
pollView();
eq('unchanged poll keeps draft and state', [el('responseText').value, VIEW_SIG], ['my half-written answer', sig]);

// 4. Submit
el('responseText').value = 'blue';
submitResponse();
eq('response saved on the server', sheetObjects('Responses').map(r => [r.session_id, r.response_text_original]), [['poll1', 'blue']]);
eq('confirmation shown', el('status').textContent, 'Submitted. Thank you!');

// 5. Instructor stops: the page closes writing but keeps any draft
el('responseText').value = 'unsent draft';
__SERVER.apiStopSession(tok, 'poll1');
pollView();
eq('stopped: writing closed', [snapshot().writing, snapshot().status], [false, 'No active session']);
eq('stopped: draft kept', el('responseText').value, 'unsent draft');
eq('stopped: student told', el('phaseToast').textContent, 'This activity has ended.');

// 6. Instructor starts a peer review activity
__SERVER.apiStartSession(tok, 'essay1', 60, 'peer');
pollView();
eq('peer activity: writing + note about review', snapshot(),
   { activity: 'Peer review', status: 'Open', writing: true, submit: true, review: false, note: true });
el('responseText').value = 'A mean is sensitive to outliers because every value contributes.';
submitResponse();
eq('peer submission message', el('status').textContent, 'Submitted. Thank you! Peer review will appear here when your instructor opens it.');
// two classmates
__SERVER.apiSubmitResponse('essay1', { response_text_original: 'classmate one answer', reviewer_token: 'c1' });
__SERVER.apiSubmitResponse('essay1', { response_text_original: 'classmate two answer', reviewer_token: 'c2' });

// 7. Instructor opens peer review: the page switches to reviewing
__SERVER.apiStartPeerReview(tok, 'essay1', 1, '');
pollView();
eq('review open: review panel, writing off', snapshot(),
   { activity: 'Peer review', status: 'Peer review', writing: false, submit: false, review: true, note: false });
eq('review open: told', el('phaseToast').textContent, 'Peer review is now open.');
eq('review open: one assignment card built', [ASSIGNED_IDS.length, el('assignments').children.length], [1, 1]);
eq('review open: not own response', sheetObjects('Responses').find(r => String(r.response_id) === ASSIGNED_IDS[0]).reviewer_token !== REVIEWER_TOKEN, true);

// 8. Instructor closes reviews
__SERVER.apiCloseReviews(tok, 'essay1');
pollView();
eq('reviews closed: status + told', [snapshot().status, el('phaseToast').textContent], ['Peer review closed', 'Peer review has closed.']);

// 9. Back to writing
__SERVER.apiSetPhase(tok, 'essay1', 'writing');
pollView();
eq('back to writing', [snapshot().status, snapshot().writing, el('phaseToast').textContent], ['Open', true, 'Writing is open again.']);

// 10. Hidden tab: no server calls; showing it again polls at once
document.hidden = true;
__serverCalls = [];
pollView();
eq('hidden tab: no polling', __serverCalls.length, 0);
document.hidden = false;
fireDocEvent('visibilitychange');   // schedules an immediate poll (timers are manual here)
pollView();
eq('visible again: polls', __serverCalls.includes('apiGetStudentView'), true);
