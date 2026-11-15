// Words for the scan step of "Build this place" (docs/PROTOTYPE.md §10a): what the search found, or why the place
// is drawn instead. Pure; app.js wires it to the progress list.

const fmtArea = m2 => `${Math.round(Number(m2) || 0).toLocaleString('en-US')} m²`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The scan's listing name only when it says what the place is: an address or a size is not a name.
function shownName(name) {
  const s = String(name ?? '').trim();
  if (!s || /^\d|\b\d[\d,]*\s?(sf|sq\.? ?ft)\b|^(\d+(st|nd|rd|th)|first|ground|main)\s+floor$/i.test(s)) return null;
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** The progress line once a scan is found: "Found a scanned salon: 2 rooms, 126 m²". */
export function foundLine(found) {
  if (!found) return '';
  const name = shownName(found.name);
  const size = `${plural(Number(found.rooms) || 0, 'room')}, ${fmtArea(found.areaM2)}`;
  if (found.strength === 'shell') return `No scan of this kind of place; using an empty ${found.query} space: ${size}`;
  return name ? `Found a scanned building, "${name}": ${size}` : `Found a scanned ${found.query} building: ${size}`;
}

/** The progress line when no scan is used, from the server's reason. */
export function noScanLine(result) {
  if (result?.reason && /keys/i.test(result.reason)) return 'No Matterport access here, so Claude draws the place';
  if (result?.reason && /do not name/i.test(result.reason)) return 'Not a kind of place the scans cover, so Claude draws it';
  return 'No scanned building fits, so Claude draws the place';
}

/** The note under the progress list. */
export function buildNote(found) {
  return found
    ? 'Claude is placing the counters, doors people use and the people who come inside the real, measured walls. The walls are from the scan; what happens inside is invented. Two or three minutes.'
    : 'Claude draws the floor plan and writes the people from your words. This takes two or three minutes.';
}

/** Why a scan could not be used, in one short sentence from the server's error. */
export function fitoutFailure(message) {
  const m = String(message ?? '');
  if (/timed out/i.test(m)) return 'Claude ran out of time fitting out the scan.';
  if (/attempt/i.test(m)) return 'Claude could not place everything inside the scan\'s walls in three tries.';
  if (/no door to the outside|walked to/i.test(m)) return 'The scan has no way in that people can walk through.';
  const first = m.replace(/^Claude could not fit out the scanned building:\s*/, '').split('\n')[0].trim();
  return first ? `The scan could not be used (${first.length > 120 ? `${first.slice(0, 119)}…` : first}).` : 'The scan could not be used.';
}
