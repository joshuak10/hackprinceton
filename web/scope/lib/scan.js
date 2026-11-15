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
