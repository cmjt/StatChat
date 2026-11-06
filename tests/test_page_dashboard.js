// @page dashboard
// The activity chosen at login drives what the dashboard shows.

setSheets({
  Instructors: [['instructor_id', 'password'], ['i1', 'pw1']],
  Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
  Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden']],
  PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
  PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
  Settings: [['key', 'value']],
  ProfanityList: [['badword']],
});
let chosenPreset = 'respond';
document.querySelector = sel => (sel === 'input[name="preset"]:checked' ? { value: chosenPreset } : null);
function login(sessionId, preset) {
  chosenPreset = preset;
  el('inst').value = 'i1'; el('instPw').value = 'pw1'; el('newSessionId').value = sessionId; el('sessionDuration').value = '45';
  handleLoginAndStart();
}

login('quiz1', 'respond');
eq('quick response: dashboard shown', el('dashView').style.display, 'block');
eq('quick response: label', el('activityLabel').textContent, 'Quick response');
eq('quick response: peer controls hidden', el('peerControls').style.display, 'none');
eq('writing duration from login (45 min)', Math.round((new Date(SESSION_STATE.active_until) - Date.now()) / 60000), 45);

login('essay1', 'peer');
eq('peer review: label', el('activityLabel').textContent, 'Peer review');
eq('peer review: controls shown', el('peerControls').style.display, '');

// Mid-review, logging in again with a different activity keeps the review and says so
el('peerK').value = '1';
openPeerReview();
login('essay1', 'respond');
eq('mid-review: settings kept and explained', el('activityLabel').textContent.startsWith('Peer review (kept:'), true);
eq('mid-review: controls still shown', el('peerControls').style.display, '');
