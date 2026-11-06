// Writing window, review deadline, and what the student page is shown.

eq('active & future -> writing open', isSessionActive({ is_active: 'TRUE', active_until: H(1) }), true);
eq('Sheets boolean true works',        isSessionActive({ is_active: true,   active_until: H(1) }), true);
eq('expired -> writing closed',        isSessionActive({ is_active: 'TRUE', active_until: H(-1) }), false);
eq('stopped -> writing closed',        isSessionActive({ is_active: 'FALSE', active_until: H(1) }), false);
eq('no session -> closed',             isSessionActive(null), false);

eq('peer open, no deadline -> open',     areReviewsOpen_({ peer_open: 'TRUE', peer_until: '' }), true);
eq('peer open, future deadline -> open', areReviewsOpen_({ peer_open: 'TRUE', peer_until: H(24) }), true);
eq('peer open, past deadline -> closed', areReviewsOpen_({ peer_open: 'TRUE', peer_until: H(-1) }), false);
eq('peer not open -> closed',            areReviewsOpen_({ peer_open: 'FALSE', peer_until: '' }), false);
eq('reviews outlast the session',        areReviewsOpen_({ peer_open: 'TRUE', is_active: 'FALSE', active_until: H(-5), peer_until: H(48) }), true);

eq('blank deadline -> none', parseDeadline_(''), null);
throws('bad deadline rejected', () => parseDeadline_('nonsense'), /Invalid review deadline/);

const HDR = ['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'peer_open', 'peer_opened_at', 'peer_until'];
const row = o => HDR.map(h => (o[h] === undefined ? '' : o[h]));
const view = rows => { setSheets({ Sessions: [HDR, ...rows.map(row)] }); __cache.clear(); return apiGetStudentView('i1'); };

let v = view([{ session_id: 'old', instructor_id: 'i1', phase: 'review', is_active: 'FALSE', active_until: H(-30), peer_open: 'TRUE', peer_opened_at: H(-30), peer_until: H(18) }]);
eq('after session, before deadline -> review, open', [v.session_id, v.phase, v.writing_open, v.reviews_open], ['old', 'review', false, true]);

v = view([{ session_id: 'old', instructor_id: 'i1', phase: 'review', is_active: 'FALSE', active_until: H(-30), peer_open: 'TRUE', peer_opened_at: H(-30), peer_until: H(-1) }]);
eq('after deadline -> review, read-only', [v.session_id, v.phase, v.reviews_open], ['old', 'review', false]);

v = view([
  { session_id: 'old', instructor_id: 'i1', phase: 'review', is_active: 'FALSE', active_until: H(-30), peer_open: 'TRUE', peer_opened_at: H(-30), peer_until: H(18) },
  { session_id: 'new', instructor_id: 'i1', phase: 'writing', is_active: 'TRUE', active_until: H(1), peer_open: 'FALSE' }]);
eq('live session takes priority', [v.session_id, v.phase, v.writing_open], ['new', 'writing', true]);

v = view([{ session_id: 'x', instructor_id: 'i1', phase: 'writing', is_active: 'FALSE', active_until: H(-1), peer_open: 'FALSE' }]);
eq('ended, no review -> nothing', v.session_id, '');
eq('other instructor ignored', (setSheets({ Sessions: [HDR, row({ session_id: 'y', instructor_id: 'i1', is_active: 'TRUE', active_until: H(1) })] }), __cache.clear(), apiGetStudentView('i2')).session_id, '');
