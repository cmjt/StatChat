// Profanity.gs — Profanity list, masking and detection.
// All .gs files share one global scope in Apps Script.

function getProfanityList() {
  const sh = getSheetByName(SHEET_PROFANITY);
  const n = Math.max(sh.getLastRow(), 1);
  const values = sh.getRange(1, 1, n, 1).getValues();
  return values.map(r => String(r[0] || '').trim()).filter(Boolean);
}

function maskProfanity(text, profList) {
  if (!text) return text;
  let output = text;
  const vegetables = [
  '🥕', // carrot
  '🥔', // potato
  '🥦', // broccoli
  '🌽', // corn
  '🥒', // cucumber
  '🥬', // leafy greens
  '🫛', // peas
  '🍅', // tomato 
  '🧅', // onion
  '🧄', // garlic
  '🫑', // bell pepper
  '🌶️', // chilli pepper
  '🥜', // peanut
  '🍠', // sweet potato
  '🌰'  // chestnut
];
  profList.forEach(term => {
    const escaped = term.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    output = output.replace(
      re,
      () => vegetables[
        Math.floor(Math.random() * vegetables.length)
      ]
    );
  });

  return output;
}

function hasProfanity(text, profList) {
  if (!text) return false;
  const t = text.toLowerCase();
  return profList.some(term => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    return re.test(t);
  });
}
