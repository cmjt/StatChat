// End-to-end peer review: assignment, submission rules, unlocking, hidden items, deadline.

setSheets({
  Sessions: [
    ['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'peer_open', 'peer_opened_at', 'peer_required_reviews', 'peer_until'],
    ['s1', 'i1', 'review', 'FALSE', 'FALSE', H(-2), 'TRUE', H(-1), 2, H(24)]],
  Responses: [
    ['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden'],
    [1, 's1', 'alice', H(-3), 'Alice answer', '', 'FALSE'],
    [2, 's1', 'bob',   H(-3), 'Bob answer',   '', 'FALSE'],
    [3, 's1', 'carol', H(-3), 'Carol answer', '', 'FALSE'],
    [4, 's1', 'dave',  H(-3), 'Dave answer',  '', 'FALSE']],
  PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
  PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
  Settings: [['key', 'value']],
  ProfanityList: [['badword']],
});
const TEN = 'this is a perfectly reasonable piece of feedback with enough words';

const a = apiAssignPeerTargets('s1', 'alice').assigned;
eq('alice gets 2 assignments', a.length, 2);
eq('never assigned own response', a.includes('1'), false);
eq('repeat call returns same set', apiAssignPeerTargets('s1', 'alice').assigned, a);
eq('extra client arg ignored', apiAssignPeerTargets('s1', 'alice', 99).assigned.length, 2);
eq('non-submitter gets nothing', apiAssignPeerTargets('s1', 'mallory').assigned, []);
eq('feedback locked before reviewing', apiGetMyFeedback('s1', 'alice').locked, true);

const notMine = ['2', '3', '4'].find(id => !a.includes(id));
throws('cannot review unassigned response', () => apiSubmitPeerFeedback('s1', notMine, 'alice', TEN), /assigned to you/);
throws('cannot review own response',        () => apiSubmitPeerFeedback('s1', '1', 'alice', TEN), /assigned to you/);
throws('minimum words enforced',            () => apiSubmitPeerFeedback('s1', a[0], 'alice', 'too short'), /at least 10/);
eq('valid review accepted', apiSubmitPeerFeedback('s1', a[0], 'alice', TEN).ok, true);
throws('duplicate review rejected',         () => apiSubmitPeerFeedback('s1', a[0], 'alice', TEN), /already reviewed/);
eq('still locked after 1 of 2', apiGetMyFeedback('s1', 'alice').locked, true);
apiSubmitPeerFeedback('s1', a[1], 'alice', TEN);

// Give bob alice's response so she receives a review; add a hidden review too
sheetRows('PeerAssignments').push(['s1', 'bob', '1', new Date()], ['s1', 'bob', '3', new Date()]);
apiSubmitPeerFeedback('s1', '1', 'bob', TEN + ' from bob');
sheetRows('PeerFeedback').push([99, 'S1 ', '1', 'carol', 'hidden review text', new Date(), 'TRUE']);

const mine = apiGetMyFeedback('s1', 'alice');
eq('unlocked after all reviews', mine.locked, false);
eq("sees bob's review, not the hidden one", mine.feedback.map(f => f.feedback), [TEN + ' from bob']);
eq('session id matched case-insensitively', apiGetMyFeedback(' S1', 'alice').locked, false);

const target = apiAssignPeerTargets('s1', 'carol').assigned;
const hideId = target[0];
sheetRows('Responses').forEach(r => { if (String(r[0]) === hideId) r[6] = 'TRUE'; });
const after = apiAssignPeerTargets('s1', 'carol').assigned;
eq('hidden assignment dropped', after.includes(hideId), false);
eq('replacement assigned', after.length >= 1, true);
throws('cannot review a hidden response', () => apiSubmitPeerFeedback('s1', hideId, 'carol', TEN), /assigned to you/);

sheetRows('Sessions')[1][9] = H(-0.1);
throws('review rejected after deadline', () => apiSubmitPeerFeedback('s1', after[0], 'carol', TEN), /closed/);
eq('no new assignments after deadline', apiAssignPeerTargets('s1', 'dave').assigned, []);
eq('feedback still readable after deadline', apiGetMyFeedback('s1', 'alice').locked, false);
