// Fabrique les agendas « abonnement » (fichiers .ics) à partir de la base Firebase.
// Un fichier par élève (ses cours) et un pour le prof (tous les cours),
// publiés sur le site à l'adresse /agenda/<code secret>.ics.
// Le téléphone abonné relit ce fichier tout seul et ajoute les nouveaux cours.
import { mkdirSync, writeFileSync } from 'node:fs';

const PROJET = 'lesmainsdejeremie';
const CLE = 'AIzaSyCNs5kcZkeKuH1o2fzx6Far-dtyI8dHNyQ';
const BASE = process.env.FIRESTORE_BASE || `https://firestore.googleapis.com/v1/projects/${PROJET}/databases/(default)/documents`;
const SORTIE = process.argv[2] || '_site/agenda';

// Convertit une valeur Firestore (format REST) en valeur JavaScript
function val(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) return champs(v.mapValue.fields);
  return null;
}
function champs(f) { const o = {}; for (const [k, v] of Object.entries(f || {})) o[k] = val(v); return o; }

async function collection(nom) {
  const out = []; let page = '';
  do {
    const r = await fetch(`${BASE}/${nom}?key=${CLE}&pageSize=300${page ? '&pageToken=' + page : ''}`);
    if (!r.ok) throw new Error(`${nom} : ${r.status}`);
    const j = await r.json();
    (j.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), ...champs(d.fields) }));
    page = j.nextPageToken || '';
  } while (page);
  return out;
}
async function document(chemin) {
  const r = await fetch(`${BASE}/${chemin}?key=${CLE}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${chemin} : ${r.status}`);
  return champs((await r.json()).fields);
}

// Les heures des cours sont celles de Paris : on les passe en heure universelle
function utc(date, heure) {
  const naif = new Date(`${date}T${heure}:00Z`);
  const parisVu = new Date(naif.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const utcVu = new Date(naif.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(naif.getTime() - (parisVu.getTime() - utcVu.getTime()));
}
const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const txt = t => String(t).replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
function lendemain(date) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

function evenement(s, titre, duree) {
  const lignes = ['BEGIN:VEVENT', `UID:${s.id}@lesmainsdejeremy.fr`, `DTSTAMP:${fmt(new Date())}`];
  if (s.heure) {
    const debut = utc(s.date, s.heure);
    lignes.push(`DTSTART:${fmt(debut)}`, `DTEND:${fmt(new Date(debut.getTime() + duree * 60000))}`);
  } else {
    lignes.push(`DTSTART;VALUE=DATE:${s.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${lendemain(s.date).replace(/-/g, '')}`);
  }
  lignes.push(`SUMMARY:${txt(titre)}`, `DESCRIPTION:${txt('Cours de langue des signes française. https://lesmainsdejeremy.fr')}`, 'URL:https://lesmainsdejeremy.fr');
  if (s.heure) lignes.push('BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${txt(titre)}`, 'END:VALARM');
  lignes.push('END:VEVENT');
  return lignes;
}
function calendrier(nom, evts) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Les Mains de Jeremy//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${txt(nom)}`, 'X-WR-TIMEZONE:Europe/Paris', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    ...evts.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
// Le code secret de l'agenda : seulement des lettres minuscules et des chiffres
const codeOk = t => typeof t === 'string' && /^[a-z0-9]{16,}$/.test(t);

const [eleves, compta, creneaux, prof] = await Promise.all([collection('students'), collection('compta'), collection('creneaux'), document('reglages/prof')]);
const durees = Object.fromEntries(creneaux.map(c => [c.id, c.duree || 60]));
// On garde les cours des 60 derniers jours et tous ceux à venir
const limite = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
const seancesDe = id => ((compta.find(c => c.id === id) || {}).seances || []).filter(s => s && s.id && s.date && s.date >= limite);
const duree = s => (s.creneauId && durees[s.creneauId]) || 60;

mkdirSync(SORTIE, { recursive: true });
let n = 0;
for (const e of eleves) {
  if (!codeOk(e.calToken)) continue;
  writeFileSync(`${SORTIE}/${e.calToken}.ics`, calendrier('Cours de LSF', seancesDe(e.id).map(s => evenement(s, 'Cours de LSF · Les Mains de Jérémy', duree(s)))));
  n++;
}
if (prof && codeOk(prof.calToken)) {
  const tous = eleves.flatMap(e => seancesDe(e.id).map(s => evenement(s, 'Cours LSF avec ' + (e.name || 'un élève'), duree(s))));
  writeFileSync(`${SORTIE}/${prof.calToken}.ics`, calendrier('Cours LSF (prof)', tous));
  n++;
}
console.log(`${n} agenda(s) fabriqué(s)`);
