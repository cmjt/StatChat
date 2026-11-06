// Web.gs — Web app entry points (doGet / doPost).
// All .gs files share one global scope in Apps Script.

function doGet(e) {
  const pageRaw = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : 'student';
  const page = pageRaw.toLowerCase();

  if (page === 'student') {
    const t = HtmlService.createTemplateFromFile('student');
    t.inst = (e && e.parameter && e.parameter.inst) ? String(e.parameter.inst) : '';
    return t.evaluate()
      .setTitle('Class Response')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (page === 'dashboard') {
    const t = HtmlService.createTemplateFromFile('dashboard');
    return t.evaluate()
      .setTitle('Instructor Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  return HtmlService.createHtmlOutput('<p>Invalid page</p>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** POST (e.g. an LMS launch) is routed like GET; e.parameter includes posted form fields */
function doPost(e) {
  try {
    return doGet(e);
  } catch (err) {
    const msg = String(err && err.message || err).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    return HtmlService.createHtmlOutput('<p>POST error: ' + msg + '</p>')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

/** Inline another HTML file into a page template: <?!= include('student_core') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
