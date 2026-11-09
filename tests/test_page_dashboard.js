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
// The two login questions: what students submit, and whether there's peer review
let chosen = { submissionType: 'text', peerReview: 'false' };
document.querySelector = sel => {
  const m = /^input\[name="(\w+)"\]:checked$/.exec(sel);
  return m && chosen[m[1]] !== undefined ? { value: chosen[m[1]] } : null;
};
function login(sessionId, preset, type) {
  chosen = { submissionType: type || 'text', peerReview: preset === 'peer' ? 'true' : 'false' };
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

// Math: label, equations on cards, and correcting them
login('maths1', 'respond', 'math');
eq('math: label', el('activityLabel').textContent, 'Quick response · math');
eq('math: peer controls hidden', el('peerControls').style.display, 'none');
__SERVER.apiSubmitResponse('maths1', { math: ['\\bar{x}=4.2', 's^2=1.1'], reviewer_token: 's1' });
__SERVER.apiSubmitResponse('maths1', { math: ['x=1'], reviewer_token: 's2' });
loadResponses();
eq('math: cards get equations', RESPONSES.map(r => [r.math, r.corrected]), [[['\\bar{x}=4.2', 's^2=1.1'], false], [['x=1'], false]]);
const slotOf = i => el('listView').children[i].querySelector('.mathSlot');
eq('math: equations shown on cards (source without KaTeX), no text box', [slotOf(0).innerHTML.includes('\\bar{x}=4.2'), el('listView').children[0].innerHTML.includes('contenteditable')], [true, false]);
eq('math: click to correct', [slotOf(0).className, typeof slotOf(0).onclick], ['mathSlot mathView', 'function']);

// Click: editor loads (MathLive), one field per line holding the equations
slotOf(0).onclick();
eq('editing: waits for the editor', slotOf(0).innerHTML.includes('Loading the equation editor'), true);
mathLiveLoaded(true);
const rid0 = RESPONSES[0].response_id;
let draft = MATH_EDITS[rid0];
eq('editing: one math-field per line', [draft.fields.map(f => f.tagName), draft.fields.map(f => f.value)], [['MATH-FIELD', 'MATH-FIELD'], ['\\bar{x}=4.2', 's^2=1.1']]);

// A refresh mid-edit keeps the change in progress
draft.fields[1].value = 's^2=1.21';
loadResponses();
eq('refresh keeps the edit in progress', MATH_EDITS[rid0].fields.map(f => f.value), ['\\bar{x}=4.2', 's^2=1.21']);

// Save: the correction replaces the equations and is marked
saveMathEdit(slotOf(0), RESPONSES[0], new FakeEl('status'));
eq('saved: card shows the correction, marked', [RESPONSES[0].math, RESPONSES[0].corrected, MATH_EDITS[rid0], slotOf(0).innerHTML.includes('Corrected')],
   [['\\bar{x}=4.2', 's^2=1.21'], true, undefined, true]);
loadResponses();
eq('saved: survives a refresh', [RESPONSES[0].math, RESPONSES[0].corrected], [['\\bar{x}=4.2', 's^2=1.21'], true]);

// Cancel discards; an empty correction isn't saved
slotOf(0).onclick();
MATH_EDITS[rid0].fields[0].value = 'oops';
const status = new FakeEl('status');
MATH_EDITS[rid0].fields.forEach(f => { f.value = ' '; });
saveMathEdit(slotOf(0), RESPONSES[0], status);
eq('empty correction not saved', [/at least one equation/.test(status.textContent), RESPONSES[0].math.length], [true, 2]);
delete MATH_EDITS[rid0]; renderMathSlot(slotOf(0), RESPONSES[0]);
eq('cancel: back to the saved correction', slotOf(0).className, 'mathSlot mathView');

// Revert to the student's answer
window.confirm = () => true; globalThis.confirm = () => true;
revertMathEdit(slotOf(0), RESPONSES[0], new FakeEl('status'));
eq('revert: student\'s answer again, not marked', [RESPONSES[0].math, RESPONSES[0].corrected], [['\\bar{x}=4.2', 's^2=1.1'], false]);

login('maths2', 'peer', 'math');
eq('math with peer review: label', el('activityLabel').textContent, 'Peer review · math');
