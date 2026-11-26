/* =========================================================
   Okénečko — logique applicative (version simplifiée)
   Une seule façon d'afficher les paroles : en grand, qui défile.
   Tout est local : IndexedDB, aucun réseau, aucun compte.
   ========================================================= */
'use strict';

const $ = (id) => document.getElementById(id);

const DB_NAME = 'okenechko';
const DB_VERSION = 1;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const SCROLL_UNIT = 0.9; // px par image à ×1 — vitesse de base légèrement réduite

const ICON_MORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6Z"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>';
const ICON_PDF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M6 15h12v6H6v-6Z"/></svg>';
const ICON_TXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';
const ICON_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

let db = null;
let songs = [];
let editingId = null;

let currentSong = null;
let filter = 'all';
let query = '';
let speedIndex = 2;
let playing = false;
let scrollRemainder = 0; // garde les fractions de pixel perdues par l'arrondi de scrollTop
let rafId = null;
let wakeLock = null;

let deferredPrompt = null;
let backupHandle = null;
let importData = null;
let toastTimer = null;

/* Dictée vocale des paroles (Web Speech API) */
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let dictating = false;
let dictationBase = '';
let dictationTail = '';
let dictationInsertAt = 0;
let dictationRestarts = 0;

/* ---------------------------------------------------------
   Utilitaires
   --------------------------------------------------------- */

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function norm(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function slug(str) {
  return norm(str).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chanson';
}

function dateName() { return new Date().toISOString().slice(0, 10); }

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function toast(message, isError) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', !!isError);
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 220);
  }, 2900);
}

/* ---------------------------------------------------------
   IndexedDB
   --------------------------------------------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRead(store, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, 'readonly').objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbWrite(store, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    fn(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const getAllSongs = () => idbRead('songs', (s) => s.getAll());
const putSong = (song) => idbWrite('songs', (s) => s.put(song));
const deleteSongDB = (id) => idbWrite('songs', (s) => s.delete(id));
const getSetting = (key) => idbRead('settings', (s) => s.get(key));
const setSetting = (key, value) => idbWrite('settings', (s) => s.put({ key, value }));

async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch (e) { /* non bloquant */ }
}

async function reloadSongs() {
  songs = await getAllSongs();
  renderFilters();
  renderList();
}

/* ---------------------------------------------------------
   Navigation
   --------------------------------------------------------- */

function showView(name) {
  if (name !== 'editor') stopDictation();
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === name));
  $('bottom-nav').hidden = (name === 'editor' || name === 'tuto');
  $('fab').hidden = (name !== 'library');
  $('view-reader').hidden = true;
  document.body.classList.remove('reading');

  if (name === 'library') {
    if (filter === 'fav' && !songs.some((s) => s.favorite)) filter = 'all';
    renderFilters();
    renderList();
    window.scrollTo(0, 0);
  }
}

/* ---------------------------------------------------------
   Accueil
   --------------------------------------------------------- */

function renderFilters() {
  const items = [
    { key: 'all', label: 'Toutes' },
    { key: 'fav', label: '★ Favoris' }
  ];
  $('filter-chips').innerHTML = items.map((it) =>
    `<button type="button" class="chip${filter === it.key ? ' is-active' : ''}" data-filter="${it.key}">${it.label}</button>`
  ).join('');
}

function menuHTML(s) {
  return `
    <button type="button" role="menuitem" data-menu="pin">${ICON_PIN}<span>${s.pinned ? 'Désépingler' : 'Épingler'}</span></button>
    <button type="button" role="menuitem" data-menu="fav">${ICON_STAR}<span>${s.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}</span></button>
    <div class="menu-divider"></div>
    <button type="button" role="menuitem" data-menu="pdf">${ICON_PDF}<span>Exporter en PDF</span></button>
    <button type="button" role="menuitem" data-menu="txt">${ICON_TXT}<span>Exporter en texte</span></button>
    <button type="button" role="menuitem" data-menu="json">${ICON_SAVE}<span>Sauvegarder cette chanson (JSON)</span></button>
    <div class="menu-divider"></div>
    <button type="button" role="menuitem" data-menu="delete" class="danger">${ICON_TRASH}<span>Supprimer la chanson</span></button>`;
}

function visibleSongs() {
  let items = songs.slice();
  if (filter === 'fav') items = items.filter((s) => s.favorite);
  if (query.trim()) {
    const q = norm(query);
    items = items.filter((s) => norm([s.title, s.artist, s.lyrics].join(' ')).includes(q));
  }
  items.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return items;
}

function renderList() {
  const list = $('song-list');
  const empty = $('empty-state');
  const items = visibleSongs();

  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    if (!songs.length) {
      $('empty-title').textContent = "Aucune chanson pour l'instant";
      $('empty-text').textContent = 'Appuyez sur le bouton + pour écrire votre première chanson.';
    } else if (query.trim()) {
      $('empty-title').textContent = 'Aucun résultat';
      $('empty-text').textContent = 'Essayez un autre mot.';
    } else {
      $('empty-title').textContent = 'Aucun favori';
      $('empty-text').textContent = 'Ouvrez le menu ⋯ d\'une chanson pour l\'ajouter aux favoris.';
    }
    return;
  }

  empty.hidden = true;
  list.innerHTML = items.map((s) => {
    const preview = String(s.lyrics || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return `
      <article class="song-card${s.pinned ? ' is-pinned' : ''}${s.favorite ? ' is-favorite' : ''}" data-id="${escapeHtml(s.id)}" tabindex="0" role="button">
        <div class="song-main">
          <div class="song-title">${escapeHtml(s.title)}</div>
          <div class="song-sub">${escapeHtml(s.artist || 'Sans artiste')}</div>
          <p class="song-preview">${escapeHtml(preview) || 'Aucune parole pour le moment…'}</p>
        </div>
        <div class="song-actions">
          <button class="icon-btn menu-btn" type="button" data-act="menu" aria-label="Options de ${escapeHtml(s.title)}" aria-expanded="false">${ICON_MORE}</button>
        </div>
      </article>`;
  }).join('');
}

let menuSongId = null;
let menuButton = null;

function closeMenu() {
  const menu = $('song-menu');
  menu.hidden = true;
  menu.innerHTML = '';
  menu.style.maxHeight = '';
  menu.style.overflowY = '';
  menuSongId = null;
  menuButton = null;
  document.querySelectorAll('.menu-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

/* Place le menu dans la bande visible, entre le haut de l'écran et les onglets. */
function positionMenu(button) {
  const menu = $('song-menu');
  const rect = button.getBoundingClientRect();
  const nav = $('bottom-nav');
  const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
  const topLimit = safeTop + 12;
  const bottomLimit = (nav && !nav.hidden ? nav.getBoundingClientRect().top : window.innerHeight) - 8;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let left = rect.right - mw;
  if (left < 12) left = 12;
  if (left + mw > window.innerWidth - 12) left = window.innerWidth - mw - 12;

  let top = rect.bottom + 6;
  if (top + mh > bottomLimit) top = rect.top - mh - 6;
  if (top < topLimit) top = topLimit;

  const space = bottomLimit - top;
  if (mh > space) {
    menu.style.maxHeight = Math.max(120, space) + 'px';
    menu.style.overflowY = 'auto';
  }
  menu.style.left = Math.max(12, left) + 'px';
  menu.style.top = top + 'px';
}

function openMenu(card, button) {
  const song = songs.find((s) => s.id === card.dataset.id);
  if (!song) return;
  if (menuSongId === song.id && !$('song-menu').hidden) { closeMenu(); return; }

  closeMenu();
  menuSongId = song.id;
  menuButton = button;
  const menu = $('song-menu');
  menu.innerHTML = menuHTML(song);
  menu.hidden = false;
  positionMenu(button);
  button.setAttribute('aria-expanded', 'true');
}

async function handleMenuAction(action) {
  const song = songs.find((s) => s.id === menuSongId);
  closeMenu();
  if (!song) return;

  if (action === 'pin' || action === 'fav') {
    if (action === 'pin') song.pinned = !song.pinned;
    else song.favorite = !song.favorite;
    song.updatedAt = new Date().toISOString();
    await putSong(song);
    await reloadSongs();
    writeAutoBackup();
    toast(action === 'pin'
      ? (song.pinned ? 'Chanson épinglée.' : 'Chanson désépinglée.')
      : (song.favorite ? 'Ajoutée aux favoris.' : 'Retirée des favoris.'));
  } else if (action === 'pdf') {
    exportPDF(song);
  } else if (action === 'txt') {
    exportTXT(song);
  } else if (action === 'json') {
    exportSongJSON(song);
  } else if (action === 'delete') {
    if (!confirm(`Supprimer « ${song.title} » ? Cette action est définitive.`)) return;
    await deleteSongDB(song.id);
    await reloadSongs();
    writeAutoBackup();
    toast('Chanson supprimée.');
  }
}

/* ---------------------------------------------------------
   Éditeur
   --------------------------------------------------------- */

async function openEditor(id) {
  stopDictation();
  const song = id ? songs.find((s) => s.id === id) : null;
  editingId = song ? song.id : null;
  $('editor-heading').textContent = song ? 'Modifier la chanson' : 'Nouvelle chanson';
  $('f-title').value = song ? song.title : '';
  $('f-artist').value = song ? (song.artist || '') : '';
  $('f-lyrics').value = song ? (song.lyrics || '') : '';

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
  $('view-editor').classList.add('is-active');
  $('bottom-nav').hidden = true;
  $('fab').hidden = true;
  $('view-reader').hidden = true;
  closeMenu();
  window.scrollTo(0, 0);
  setTimeout(() => $('f-title').focus(), 60);
}

/* ---------------------------------------------------------
   Dictée des paroles
   --------------------------------------------------------- */

function setDictationStatus(message, isError) {
  const el = $('dictate-status');
  el.textContent = message || '';
  el.hidden = !message;
  el.classList.toggle('error', !!isError);
}

function updateDictationUI() {
  const btn = $('dictate-btn');
  btn.classList.toggle('is-listening', dictating);
  btn.setAttribute('aria-pressed', String(dictating));
  btn.setAttribute('aria-label', dictating ? 'Arrêter la dictée' : 'Dicter les paroles avec le micro');
  $('dictate-label').textContent = dictating ? 'Arrêter' : 'Dicter';
}

function initDictationUI() {
  const btn = $('dictate-btn');
  if (!SpeechRecognitionCtor) {
    btn.disabled = true;
    btn.title = 'Dictée non disponible sur ce navigateur';
    $('dictate-label').textContent = 'Indisponible';
    return;
  }
  btn.disabled = false;
  updateDictationUI();
}

/* Réécrit le champ avec le texte déjà dicté, le texte en cours et la suite. */
function applyDictationText(finalText, interimText) {
  const ta = $('f-lyrics');
  const spoken = finalText + (interimText ? (finalText ? ' ' : '') + interimText : '');
  ta.value = dictationBase + spoken + dictationTail;
  const pos = dictationInsertAt + spoken.length;
  ta.setSelectionRange(pos, pos);
}

function createRecognition() {
  const rec = new SpeechRecognitionCtor();
  rec.lang = 'fr-FR';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let finalText = '';
    let interimText = '';
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = (result[0] && result[0].transcript) ? result[0].transcript.trim() : '';
      if (!transcript) continue;
      if (result.isFinal) finalText += (finalText ? ' ' : '') + transcript;
      else interimText += (interimText ? ' ' : '') + transcript;
    }
    applyDictationText(finalText, interimText);
  };

  rec.onerror = (event) => {
    const code = event.error || '';
    if (code === 'aborted') return;
    if (code === 'no-speech') {
      setDictationStatus('Aucune parole entendue… continuez à parler.', true);
      return;
    }
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      stopDictation(true);
      setDictationStatus('Micro refusé.', true);
      toast('Autorisez le micro et ouvrez la page en HTTPS.', true);
      return;
    }
    if (code === 'audio-capture') {
      stopDictation(true);
      setDictationStatus('Aucun micro détecté.', true);
      toast('Aucun micro disponible sur cet appareil.', true);
      return;
    }
    stopDictation(true);
    setDictationStatus('Dictée interrompue (' + code + ').', true);
    if (code === 'network') toast('La dictée vocale nécessite une connexion Internet.', true);
  };

  rec.onend = () => {
    if (!dictating) return;
    dictationRestarts++;
    if (dictationRestarts > 8) {
      stopDictation(true);
      setDictationStatus('Dictée arrêtée. Appuyez sur Dicter pour reprendre.', true);
      return;
    }
    try {
      rec.start();
      setDictationStatus('Dictée en cours… appuyez sur Arrêter pour terminer.');
    } catch (e) {
      stopDictation(true);
    }
  };

  return rec;
}

function startDictation() {
  if (!SpeechRecognitionCtor) {
    toast('Dictée non disponible sur ce navigateur.', true);
    return;
  }
  if (dictating) return;

  const ta = $('f-lyrics');
  const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
  const end = ta.selectionEnd != null ? ta.selectionEnd : start;
  dictationInsertAt = start;
  dictationBase = ta.value.slice(0, start);
  dictationTail = ta.value.slice(end);
  dictationRestarts = 0;
  dictating = true;
  updateDictationUI();
  setDictationStatus('Dictée en cours… appuyez sur Arrêter pour terminer.');

  recognition = createRecognition();
  try {
    recognition.start();
  } catch (e) {
    dictating = false;
    recognition = null;
    updateDictationUI();
    setDictationStatus('Impossible de démarrer la dictée.', true);
    toast('Impossible de démarrer la dictée.', true);
  }
}

function stopDictation(keepStatus) {
  const wasActive = dictating || recognition;
  dictating = false;
  const rec = recognition;
  recognition = null;
  if (rec) {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try { rec.stop(); } catch (e) { /* déjà arrêté */ }
  }
  updateDictationUI();
  if (wasActive && !keepStatus) {
    setDictationStatus('');
    toast('Dictée terminée.');
  }
}

async function saveSong(event) {
  event.preventDefault();
  const title = $('f-title').value.trim();
  if (!title) { toast('Donnez un titre à la chanson.', true); $('f-title').focus(); return; }

  const now = new Date().toISOString();
  const existing = editingId ? songs.find((s) => s.id === editingId) : null;
  const song = {
    id: existing ? existing.id : (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now() + Math.random().toString(36).slice(2)),
    title,
    artist: $('f-artist').value.trim(),
    lyrics: $('f-lyrics').value,
    favorite: existing ? !!existing.favorite : false,
    pinned: existing ? !!existing.pinned : false,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };

  try {
    await putSong(song);
    await requestPersist();
    await reloadSongs();
    showView('library');
    writeAutoBackup();
    toast(existing ? 'Chanson mise à jour.' : 'Chanson enregistrée.');
  } catch (e) {
    console.error(e);
    toast("Impossible d'enregistrer la chanson.", true);
  }
}

/* ---------------------------------------------------------
   Lecteur grand écran
   --------------------------------------------------------- */

function openReader(song) {
  if (!song) return;
  currentSong = song;
  $('reader-title').textContent = song.title;
  $('reader-artist').textContent = song.artist || '';
  $('reader-lyrics').textContent = song.lyrics || '';
  $('reader-scroll').scrollTop = 0;

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
  $('view-reader').hidden = false;
  $('bottom-nav').hidden = true;
  $('fab').hidden = true;
  document.body.classList.add('reading');
  closeMenu();

  playing = false;
  scrollRemainder = 0;
  updatePlayUI();
  $('progress-fill').style.width = '0%';
  acquireWake();
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function closeReader() {
  playing = false;
  updatePlayUI();
  releaseWake();
  currentSong = null;
  showView('library');
}

function updatePlayUI() {
  const b = $('play-toggle');
  b.classList.toggle('is-playing', playing);
  b.setAttribute('aria-pressed', String(playing));
  b.setAttribute('aria-label', playing ? 'Mettre en pause' : 'Démarrer le défilement');
}

function setSpeed(index) {
  const next = Math.max(0, Math.min(SPEEDS.length - 1, index));
  const changed = next !== speedIndex;
  speedIndex = next;
  const label = $('speed-label');
  label.textContent = '×' + SPEEDS[speedIndex];
  setSetting('speed', speedIndex).catch(() => {});
  if (changed) {
    label.classList.remove('flash');
    void label.offsetWidth;
    label.classList.add('flash');
    toast('Vitesse : ×' + SPEEDS[speedIndex]);
  }
}

function tick() {
  if (playing && !$('view-reader').hidden) {
    const el = $('reader-scroll');
    scrollRemainder += SPEEDS[speedIndex] * SCROLL_UNIT;
    const step = Math.floor(scrollRemainder);
    if (step > 0) {
      el.scrollTop += step;
      scrollRemainder -= step;
    }
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
      playing = false;
      updatePlayUI();
      releaseWake();
      toast('Fin de la chanson.');
    }
    const max = el.scrollHeight - el.clientHeight;
    const pct = max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 100;
    $('progress-fill').style.width = pct + '%';
  }
  rafId = requestAnimationFrame(tick);
}

async function acquireWake() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { /* non critique */ }
}

function releaseWake() {
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
}

/* ---------------------------------------------------------
   Sauvegarde / restauration
   --------------------------------------------------------- */

async function buildBackup(list) {
  const all = list || await getAllSongs();
  return {
    format: 'okenechko-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    songs: all.map((s) => ({
      id: s.id, title: s.title, artist: s.artist || '', lyrics: s.lyrics || '',
      favorite: !!s.favorite, pinned: !!s.pinned,
      createdAt: s.createdAt, updatedAt: s.updatedAt
    }))
  };
}

async function exportJSON() {
  try {
    const backup = await buildBackup();
    download(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), 'okenechko-catalogue-' + dateName() + '.json');
    toast('Sauvegarde du catalogue créée.');
  } catch (e) { console.error(e); toast("Impossible de créer la sauvegarde.", true); }
}

async function exportSongJSON(song) {
  if (!song) return;
  try {
    const backup = await buildBackup([song]);
    download(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), slug(song.title) + '.json');
    toast('Chanson sauvegardée.');
  } catch (e) { console.error(e); toast("Impossible de sauvegarder la chanson.", true); }
}

function applyImport() {
  if (!importData) return;
  (async () => {
    try {
      const converted = importData.songs.map((s) => ({
        id: s.id || (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now() + Math.random().toString(36).slice(2)),
        title: s.title || 'Sans titre',
        artist: s.artist || '',
        lyrics: s.lyrics || '',
        favorite: !!s.favorite,
        pinned: !!s.pinned,
        createdAt: s.createdAt || new Date().toISOString(),
        updatedAt: s.updatedAt || new Date().toISOString()
      }));

      const existing = await getAllSongs();
      const map = new Map(existing.map((s) => [s.id, s]));
      for (const s of converted) {
        const current = map.get(s.id);
        if (!current || String(s.updatedAt).localeCompare(String(current.updatedAt)) > 0) await putSong(s);
      }

      importData = null;
      $('import-modal').hidden = true;
      await reloadSongs();
      requestPersist();
      writeAutoBackup();
      toast(converted.length + ' chanson(s) restaurée(s).');
    } catch (e) {
      console.error(e);
      toast('La restauration a échoué.', true);
    }
  })();
}

/* ---------------------------------------------------------
   Sauvegarde automatique (Android / Chromium)
   --------------------------------------------------------- */

async function initBackupHandle() {
  try {
    const stored = await getSetting('backupHandle');
    if (stored && stored.value) backupHandle = stored.value;
  } catch (e) { /* handle non sérialisable */ }
  updateBackupUI();
}

function updateBackupUI() {
  const btn = $('auto-backup-btn');
  if (!('showDirectoryPicker' in window)) { btn.hidden = true; return; }
  btn.hidden = false;
  $('auto-backup-label').textContent = backupHandle
    ? 'Sauvegarde auto : ' + backupHandle.name
    : 'Choisir un dossier de sauvegarde automatique';
  $('backup-hint').hidden = !backupHandle;
  if (backupHandle) $('backup-hint').textContent = 'Une copie JSON est écrite à chaque modification dans ce dossier.';
}

async function writeAutoBackup() {
  if (!backupHandle) return;
  try {
    let perm = backupHandle.queryPermission ? await backupHandle.queryPermission({ mode: 'readwrite' }) : 'granted';
    if (perm !== 'granted' && backupHandle.requestPermission) perm = await backupHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return;
    const fileHandle = await backupHandle.getFileHandle('okenechko-backup.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(await buildBackup(), null, 2));
    await writable.close();
  } catch (e) { console.warn('Sauvegarde auto :', e); }
}

/* ---------------------------------------------------------
   Exports d'une chanson
   --------------------------------------------------------- */

function exportPDF(song) {
  if (!song) return;
  const sheet = $('print-sheet');
  sheet.innerHTML = '<h1>' + escapeHtml(song.title) + '</h1>' +
    (song.artist ? '<p class="print-artist">' + escapeHtml(song.artist) + '</p>' : '') +
    '<pre>' + escapeHtml(song.lyrics || '') + '</pre>';
  const done = () => {
    document.body.classList.remove('printing');
    sheet.innerHTML = '';
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  document.body.classList.add('printing');
  window.print();
  setTimeout(done, 60000);
}

function exportTXT(song) {
  if (!song) return;
  const text = song.title + (song.artist ? '\n' + song.artist : '') + '\n\n' + (song.lyrics || '') + '\n';
  download(new Blob([text], { type: 'text/plain;charset=utf-8' }), slug(song.title) + '.txt');
  toast('Fichier texte exporté.');
}

/* ---------------------------------------------------------
   Installation PWA
   --------------------------------------------------------- */

function setupInstall() {
  const btn = $('install-btn');
  const help = $('install-help');
  const isIOS = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    btn.textContent = 'Comment installer sur iPhone';
    btn.addEventListener('click', () => { help.hidden = !help.hidden; });
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; btn.hidden = false; });
  btn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.hidden = true;
    } else {
      help.hidden = !help.hidden;
    }
  });
}

/* ---------------------------------------------------------
   Événements
   --------------------------------------------------------- */

function bindEvents() {
  $('search').addEventListener('input', (e) => { query = e.target.value; renderList(); });

  $('filter-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    filter = chip.dataset.filter;
    renderFilters();
    renderList();
  });

  $('song-list').addEventListener('click', (e) => {
    const card = e.target.closest('.song-card');
    if (!card) return;
    const song = songs.find((s) => s.id === card.dataset.id);
    const button = e.target.closest('[data-act="menu"]');
    if (button) {
      e.stopPropagation();
      openMenu(card, button);
      return;
    }
    if (song) openReader(song);
  });

  $('song-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-menu]');
    if (!item) return;
    e.stopPropagation();
    handleMenuAction(item.dataset.menu);
  });

  $('song-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.song-card');
    if (!card || e.target.closest('button')) return;
    e.preventDefault();
    const song = songs.find((s) => s.id === card.dataset.id);
    if (song) openReader(song);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#song-menu') && !e.target.closest('.menu-btn')) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  const refreshMenu = () => {
    if ($('song-menu').hidden) return;
    if (menuButton && menuButton.isConnected) positionMenu(menuButton);
    else closeMenu();
  };
  window.addEventListener('scroll', refreshMenu);
  window.addEventListener('resize', refreshMenu);

  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.nav)));
  $('fab').addEventListener('click', () => openEditor(null));
  $('empty-add').addEventListener('click', () => openEditor(null));
  $('editor-back').addEventListener('click', () => showView('library'));
  $('editor-cancel').addEventListener('click', () => showView('library'));
  $('dictate-btn').addEventListener('click', () => dictating ? stopDictation() : startDictation());
  $('open-tuto').addEventListener('click', () => showView('tuto'));
  $('tuto-back').addEventListener('click', () => showView('settings'));
  $('song-form').addEventListener('submit', saveSong);

  $('reader-close').addEventListener('click', closeReader);
  $('speed-down').addEventListener('click', () => {
    if (speedIndex === 0) { toast('Vitesse minimale.'); return; }
    setSpeed(speedIndex - 1);
  });
  $('speed-up').addEventListener('click', () => {
    if (speedIndex === SPEEDS.length - 1) { toast('Vitesse maximale.'); return; }
    setSpeed(speedIndex + 1);
  });
  $('play-toggle').addEventListener('click', () => {
    playing = !playing;
    updatePlayUI();
    if (playing) acquireWake(); else releaseWake();
  });
  $('reader-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('view-reader').requestFullscreen();
    } catch (e) { toast('Plein écran indisponible.', true); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playing && !$('view-reader').hidden) acquireWake();
  });

  $('export-json').addEventListener('click', exportJSON);
  $('import-json').addEventListener('click', () => $('import-file').click());
  $('auto-backup-btn').addEventListener('click', async () => {
    if (!('showDirectoryPicker' in window)) { toast('Non disponible sur ce navigateur.', true); return; }
    if (backupHandle) {
      backupHandle = null;
      await setSetting('backupHandle', null).catch(() => {});
      updateBackupUI();
      toast('Sauvegarde automatique désactivée.');
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      backupHandle = handle;
      await setSetting('backupHandle', handle).catch(() => {});
      updateBackupUI();
      await writeAutoBackup();
      toast('Sauvegarde automatique activée.');
    } catch (e) {
      if (e.name !== 'AbortError') toast("Impossible d'ouvrir le dossier.", true);
    }
  });

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.format !== 'okenechko-backup' || !Array.isArray(data.songs)) {
        throw new Error('Ce fichier n\'est pas une sauvegarde Okénečko.');
      }
      if (Number(data.version) > 1) throw new Error('Cette sauvegarde vient d\'une version plus récente.');
      importData = data;
      $('import-summary').textContent = data.songs.length + ' chanson(s) dans cette sauvegarde.';
      $('import-modal').hidden = false;
    } catch (err) {
      toast(err.message || 'Fichier invalide.', true);
    }
  });

  $('import-cancel').addEventListener('click', () => { importData = null; $('import-modal').hidden = true; });
  $('import-merge').addEventListener('click', applyImport);
  document.querySelector('.modal-backdrop').addEventListener('click', () => { importData = null; $('import-modal').hidden = true; });
}

/* ---------------------------------------------------------
   Démarrage
   --------------------------------------------------------- */

async function init() {
  try { db = await openDB(); }
  catch (e) { console.error(e); toast('Stockage local indisponible.', true); return; }

  const storedSpeed = await getSetting('speed');
  if (storedSpeed && typeof storedSpeed.value === 'number') {
    speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, storedSpeed.value));
  }
  setSpeed(speedIndex);

  bindEvents();
  initDictationUI();
  setupInstall();
  await reloadSongs();
  await initBackupHandle();
  requestPersist();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker :', e)));
  }
}

document.addEventListener('DOMContentLoaded', init);
