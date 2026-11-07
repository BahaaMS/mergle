const STATS_KEY = 'mergle_stats';
const MAX_ATTEMPTS = 6;

// ---------- Date helpers ----------
function getLocalDateString(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function getLocalYesterdayString() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return getLocalDateString(d);
}

// UTC-based (not local) to match daysSinceEpoch below - avoids off-by-one
// drift near midnight in timezones ahead/behind UTC.
function shiftDateString(dateStr, deltaDays) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86400000);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

// ---------- Basic geo helpers ----------
function getIso(feature) { return feature.properties.iso3; }
function getName(feature) { return feature.properties.name; }

// Fixed reference point for day-numbering. Not otherwise significant -
// just needs to stay constant across sessions/deploys.
const SCHEDULE_EPOCH = '2025-01-01';

function daysSinceEpoch(dateStr, epochStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [ey, em, ed] = epochStr.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed);
    return Math.round(ms / 86400000);
}

function getRings(geometry) {
    if (geometry.type === "Polygon") return geometry.coordinates;
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(1);
    return [];
}

// A country may legitimately need several disconnected pieces to cover ALL
// of its neighbors (e.g. Indonesia needs Kalimantan for Malaysia, Papua for
// PNG, and Timor for Timor-Leste). All kept pieces are always rendered in
// full - the game deliberately shows the whole country, not just whichever
// piece touches today's specific neighbor.

function getSharedBorderGeo(countryA, countryB) {
    const setA = new Set();
    getRings(countryA.geometry).forEach(ring => {
        for (let i = 0; i < ring.length - 1; i++) {
            const p1 = `${ring[i][0].toFixed(3)},${ring[i][1].toFixed(3)}`;
            const p2 = `${ring[i + 1][0].toFixed(3)},${ring[i + 1][1].toFixed(3)}`;
            setA.add(p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`);
        }
    });
    const sharedSegments = [];
    getRings(countryB.geometry).forEach(ring => {
        for (let i = 0; i < ring.length - 1; i++) {
            const p1 = `${ring[i][0].toFixed(3)},${ring[i][1].toFixed(3)}`;
            const p2 = `${ring[i + 1][0].toFixed(3)},${ring[i + 1][1].toFixed(3)}`;
            const key = p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
            if (setA.has(key)) sharedSegments.push([ring[i], ring[i + 1]]);
        }
    });
    return { type: "Feature", geometry: { type: "MultiLineString", coordinates: sharedSegments } };
}

function sortSegmentsForSweep(segments) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    segments.forEach(seg => seg.forEach(([x, y]) => {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }));
    const axis = (maxX - minX) >= (maxY - minY) ? 0 : 1;
    const axisMin = axis === 0 ? minX : minY;
    const axisMax = axis === 0 ? maxX : maxY;
    const withMid = segments.map(seg => ({ seg, mid: (seg[0][axis] + seg[1][axis]) / 2 }));
    withMid.sort((a, b) => a.mid - b.mid);
    return {
        segments: withMid.map(s => s.seg),
        mids: withMid.map(s => s.mid),
        axisMin,
        axisMax
    };
}

// The daily pair is looked up from a precomputed schedule (schedule.json) -
// a shuffled, non-repeating cycle covering every valid country pair in the
// game exactly once before it wraps around, with a guaranteed minimum
// spacing between any country's repeat appearances (>=20 days, including
// across the wraparound seam - see gen_schedule_sa.py). This is the same
// approach other daily geography games use, and replaces an earlier
// hash-of-the-date approach that had no such guarantee (could genuinely
// land on the same country several times in a short span by chance).
//
// schedule.json is generated offline by gen_schedule_sa.py, not at runtime.
// That script uses simulated annealing (not plain greedy) specifically
// because a naive greedy fill runs out of "safe" candidates near the end
// of the cycle and is forced into leftover pairs back-to-back - which is
// exactly the bug this replaced (Turkey landing on 3 of the cycle's last
// 6 days, and 5 valid border pairs getting dropped entirely because the
// greedy pass never reached them). Re-run that script whenever
// adjacency.json changes, rather than hand-editing schedule.json.
function getScheduledPair(features, schedule, dateStr) {
    const isoMap = new Map(features.map(f => [getIso(f), f]));
    const dayNum = daysSinceEpoch(dateStr, SCHEDULE_EPOCH);
    const index = ((dayNum % schedule.length) + schedule.length) % schedule.length;
    const { a: isoA, b: isoB } = schedule[index];
    const countryA = isoMap.get(isoA);
    const countryB = isoMap.get(isoB);
    if (!countryA || !countryB) {
        throw new Error(`Scheduled pair ${isoA}/${isoB} not found in current dataset (index ${index}).`);
    }
    const shared = getSharedBorderGeo(countryA, countryB);
    return { countryA, countryB, sharedSegments: shared.geometry.coordinates };
}

// ---------- Distance / direction (for proximity feedback) ----------
function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function haversineKm(a, b) { // a, b = [lon, lat]
    const R = 6371;
    const [lon1, lat1] = a, [lon2, lat2] = b;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const la1 = toRad(lat1), la2 = toRad(lat2);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg(a, b) {
    // Flat/planar bearing (simple lon/lat delta angle), not true great-circle
    // bearing. True great-circle bearing is "more correct" geometrically, but
    // it can swing surprisingly at high latitudes - two guesses that look
    // clearly "southwest" on an ordinary flat map could get different labels.
    // This matches what the player is actually looking at.
    //
    // The longitude difference is wrapped into [-180, 180] so the arrow takes
    // the SHORTER way around the globe. Without it, anything across the
    // Pacific pointed the long way (e.g. USA -> Russia read "east" even
    // though the closest approach, over the Bering Strait, is to the west).
    const [lon1, lat1] = a, [lon2, lat2] = b;
    const dx = ((lon2 - lon1 + 540) % 360) - 180, dy = lat2 - lat1;
    return (toDeg(Math.atan2(dx, dy)) + 360) % 360;
}

// 8-point compass arrows, discretized from the flat bearing above.
const COMPASS_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
function bearingToArrow(deg) { return COMPASS_ARROWS[Math.round(deg / 45) % 8]; }

// Direction is shown as one of 8 compass arrows (see bearingToArrow above).

// ---------- Color helpers (heat scale reads its colors from CSS variables) ----------
function hexToRgb(hex) {
    const v = hex.replace('#', '');
    return [parseInt(v.substring(0, 2), 16), parseInt(v.substring(2, 4), 16), parseInt(v.substring(4, 6), 16)];
}
function rgbToHex(rgb) {
    return '#' + rgb.map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}
function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    return rgbToHex(a.map((c, i) => c + (b[i] - c) * t));
}

function relativeLuminance(hex) {
    const [r, g, b] = hexToRgb(hex).map(c => c / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastTextColor(hexBg) {
    return relativeLuminance(hexBg) > 0.5 ? '#1c1526' : '#ffffff';
}

const rootStyles = getComputedStyle(document.documentElement);
const HEAT_COLD = rootStyles.getPropertyValue('--heat-cold').trim();
const HEAT_MID = rootStyles.getPropertyValue('--heat-mid').trim();
const HEAT_HOT = rootStyles.getPropertyValue('--heat-hot').trim();
const HEAT_BORDER = rootStyles.getPropertyValue('--heat-border').trim();
const HEAT_MAX_DIST_KM = 15000; // beyond this, fully cold (border-to-border max is ~19,600 km)

// 0 = fully cold ... 1 = on top of it. Distances are border-to-border (see
// borderDistanceKm), so close guesses are only tens or hundreds of km. A
// (1 - d)^1.5 curve keeps a visible gradient there instead of painting
// everything under ~3,000 km the same deep red. The share grid uses this too.
function heatT(distanceKm) {
    const dNorm = Math.min(distanceKm, HEAT_MAX_DIST_KM) / HEAT_MAX_DIST_KM;
    return Math.pow(1 - dNorm, 1.5);
}

function heatColor(distanceKm, isBordering) {
    if (isBordering) return HEAT_BORDER;
    const t = heatT(distanceKm);
    return t < 0.5 ? lerpColor(HEAT_COLD, HEAT_MID, t / 0.5) : lerpColor(HEAT_MID, HEAT_HOT, (t - 0.5) / 0.5);
}

// ---------- Safe storage ----------
// Merely touching `localStorage` can throw (blocked cookies, some private
// modes, sandboxed iframes), and setItem can throw when the quota is full.
// Every read/write goes through these helpers so the game never crashes on
// load; if real storage is unavailable, values live in memory for the
// session instead (settings still work, they just aren't remembered).
const memoryStore = new Map();
function storageGet(key) {
    try {
        const v = localStorage.getItem(key);
        if (v !== null) return v;
    } catch (e) { /* fall back to memory */ }
    return memoryStore.has(key) ? memoryStore.get(key) : null;
}
function storageSet(key, value) {
    memoryStore.set(key, value);
    try { localStorage.setItem(key, value); } catch (e) { /* kept in memory only */ }
}

// ---------- Stats (localStorage) ----------
function defaultDistribution() { return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, loss: 0 }; }

function loadStats() {
    const defaults = { totalSolves: 0, currentStreak: 0, maxStreak: 0, cleanSolves: 0, lastPlayedDate: null, lastResult: null, distribution: defaultDistribution(),
        // hard-mode games are also counted in the totals above; these track them separately
        hardPlayed: 0, hardSolves: 0, hardGuessTotal: 0 };
    const raw = storageGet(STATS_KEY);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                const merged = { ...defaults, ...parsed }; // fills any fields missing in older saves
                merged.distribution = { ...defaultDistribution(), ...(parsed.distribution || {}) };
                return merged;
            }
        } catch (e) { /* corrupted save - fall through to defaults */ }
    }
    return defaults;
}
function saveStats(stats) { storageSet(STATS_KEY, JSON.stringify(stats)); }

// ---------- Settings (localStorage) ----------
const SETTINGS_KEY = 'mergle_settings';
const KM_TO_MILES = 0.621371;

function loadSettings() {
    const defaults = { hardMode: false, useMiles: false };
    const raw = storageGet(SETTINGS_KEY);
    if (raw) {
        try { return { ...defaults, ...JSON.parse(raw) }; } catch (e) { /* fall through */ }
    }
    return defaults;
}
function saveSettings(s) { storageSet(SETTINGS_KEY, JSON.stringify(s)); }
let settings = loadSettings();

// The stored currentStreak only updates when a game is finished, so after
// missing a day it would keep showing the old number until the next win.
// A streak is alive only if the last game was today or yesterday (and was a
// win - a loss already resets it to 0 when recorded).
function getDisplayStreak(stats) {
    if (!stats.lastPlayedDate) return 0;
    const alive = stats.lastPlayedDate === getLocalDateString() ||
                  stats.lastPlayedDate === getLocalYesterdayString();
    return alive ? stats.currentStreak : 0;
}

function renderStatsUI(stats, todaysBucket) {
    const dist = stats.distribution || defaultDistribution();
    const gamesPlayed = Object.values(dist).reduce((sum, v) => sum + (v || 0), 0);
    const winRate = gamesPlayed > 0 ? Math.round((stats.totalSolves / gamesPlayed) * 100) : 0;
    const totalGuessesOnWins = ['1', '2', '3', '4', '5', '6']
        .reduce((sum, k) => sum + (dist[k] || 0) * Number(k), 0);
    const avgGuesses = stats.totalSolves > 0 ? (totalGuessesOnWins / stats.totalSolves) : null;

    const streak = getDisplayStreak(stats);
    document.getElementById('stat-played').textContent = stats.totalSolves;
    document.getElementById('stat-winrate').textContent = gamesPlayed > 0 ? winRate + '%' : '\u2013';
    document.getElementById('stat-avg').textContent = avgGuesses === null ? '\u2013' : avgGuesses.toFixed(1);
    document.getElementById('stat-streak').textContent = streak;
    document.getElementById('streak-current').classList.toggle('alive', streak > 0); // flame lights up while a streak is running
    document.getElementById('stat-max-streak').textContent = stats.maxStreak;
    document.getElementById('stat-clean').textContent = stats.cleanSolves;

    // Hard mode wins (also counted in the totals above)
    document.getElementById('stat-hard').textContent = stats.hardSolves || 0;

    document.getElementById('stats-empty').hidden = gamesPlayed > 0;
    renderDistribution(dist, todaysBucket);
}

function renderDistribution(distribution, todaysBucket) {
    const dist = distribution || defaultDistribution();
    const buckets = ['1', '2', '3', '4', '5', '6', 'loss'];
    const maxCount = Math.max(1, ...buckets.map(b => dist[b] || 0));
    const container = document.getElementById('dist-rows');
    container.innerHTML = buckets.map(b => {
        const count = dist[b] || 0;
        const pct = count === 0 ? 0 : Math.max(6, Math.round((count / maxCount) * 100));
        const isToday = todaysBucket != null && String(todaysBucket) === b;
        const rowClasses = ['dist-row'];
        if (b === 'loss') rowClasses.push('loss');
        if (isToday) rowClasses.push('today');
        return `
          <div class="${rowClasses.join(' ')}" role="img" aria-label="${b === 'loss' ? 'Not solved' : b + (b === '1' ? ' guess' : ' guesses')}: ${count} ${count === 1 ? 'game' : 'games'}${isToday ? ' (today)' : ''}">
            <div class="dist-label">${b === 'loss' ? 'X' : b}</div>
            <div class="dist-bar-track"><div class="dist-bar-fill" style="width:${pct}%${count === 0 ? ';padding:0' : ''}"><span>${count > 0 ? count : ''}</span></div></div>
          </div>`;
    }).join('');
}

function recordResult(won, hintUsed, attemptsUsed, today, hardMode) {
    const stats = loadStats();
    if (stats.lastPlayedDate === today) return stats;

    const yesterday = getLocalYesterdayString();
    if (hardMode) {
        stats.hardPlayed++;
        if (won) {
            stats.hardSolves++;
            stats.hardGuessTotal += attemptsUsed;
        }
    }
    if (won) {
        stats.totalSolves++;
        if (!hintUsed) stats.cleanSolves++;
        stats.currentStreak = (stats.lastPlayedDate === yesterday && stats.lastResult === 'win')
            ? stats.currentStreak + 1
            : 1;
        stats.distribution[attemptsUsed] = (stats.distribution[attemptsUsed] || 0) + 1;
    } else {
        stats.currentStreak = 0;
        stats.distribution.loss = (stats.distribution.loss || 0) + 1;
    }
    stats.maxStreak = Math.max(stats.maxStreak, stats.currentStreak);
    stats.lastPlayedDate = today;
    stats.lastResult = won ? 'win' : 'loss';
    saveStats(stats);
    return stats;
}

// ---------- Name matching (accents, punctuation, aliases) ----------
// Players type names however they remember them: "Cote d'Ivoire", "USA",
// "Czechia", "Burma". Everything is compared in a normalized form
// (lowercase, no accents, no punctuation, "St" = "Saint", leading "The"
// dropped), and COUNTRY_ALIASES maps common alternate names onto the
// canonical name used in world.json. Keys below MUST match world.json names
// exactly; a mismatch is reported in the console at startup.
function normalizeName(str) {
    return String(str)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['\u2019`.]/g, '')                       // apostrophes, dots
        .replace(/[-\u2013\u2014_,()]/g, ' ')              // hyphens etc. -> space
        .replace(/\bst\b/g, 'saint')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^the\s+/, '');                           // "The Gambia" -> "gambia"
}

const COUNTRY_ALIASES = {
    'United States': ['USA', 'US', 'U.S.', 'U.S.A.', 'United States of America', 'America'],
    'United Kingdom': ['UK', 'U.K.', 'GB', 'Great Britain', 'Britain'],
    'United Arab Emirates': ['UAE', 'Emirates'],
    'Czech Republic': ['Czechia'],
    "Côte d'Ivoire": ['Ivory Coast'],
    'Democratic Republic of the Congo': ['DR Congo', 'DRC', 'D.R. Congo', 'Congo Kinshasa', 'Congo-Kinshasa', 'Democratic Republic of Congo', 'Zaire'],
    'Republic of the Congo': ['Congo Brazzaville', 'Congo-Brazzaville', 'Republic of Congo', 'Congo Republic'],
    'Central African Republic': ['CAR'],
    'Myanmar': ['Burma'],
    'Eswatini': ['Swaziland'],
    'North Macedonia': ['Macedonia'],
    'Timor-Leste': ['East Timor', 'Timor'],
    'Cabo Verde': ['Cape Verde'],
    'Netherlands': ['Holland'],
    'Vatican': ['Vatican City', 'Holy See'],
    'Federated States of Micronesia': ['Micronesia', 'FSM'],
    'São Tomé and Principe': ['Sao Tome', 'Sao Tome and Principe'],
    'Saint Kitts and Nevis': ['Saint Kitts', 'Kitts and Nevis', 'Kitts'],
    'Saint Vincent and the Grenadines': ['Saint Vincent', 'Saint Vincent and Grenadines'],
    'Bosnia and Herzegovina': ['Bosnia', 'Herzegovina', 'BiH'],
    'Trinidad and Tobago': ['Trinidad'],
    'Antigua and Barbuda': ['Antigua'],
    'Papua New Guinea': ['PNG'],
    'South Korea': ['Republic of Korea', 'ROK'],
    'North Korea': ['DPRK', "Democratic People's Republic of Korea"],
    'Russia': ['Russian Federation'],
    'Turkey': ['Türkiye', 'Turkiye'],
    'Vietnam': ['Viet Nam'],
    'Laos': ['Lao PDR'],
    'Brunei': ['Brunei Darussalam'],
    'Palestine': ['State of Palestine', 'Palestinian Territories'],
    'The Gambia': ['Gambia'],
    'Bahamas': ['The Bahamas']
};

// ---------- Custom autocomplete ----------
// entries: [{ name, keys }] - `name` is what gets inserted into the box,
// `keys` are normalized strings to match against (canonical name first,
// then any aliases).
function setupAutocomplete(input, listEl, entries, onEnterSubmit) {
    let currentMatches = [];
    let activeIndex = -1;

    function closeList() { listEl.hidden = true; listEl.innerHTML = ''; activeIndex = -1; }

    function renderMatches(matches) {
        currentMatches = matches;
        listEl.innerHTML = matches.map((name, i) => `<li data-idx="${i}">${name}</li>`).join('');
        listEl.hidden = matches.length === 0;
        activeIndex = -1;
    }

    function updateActiveStyles() {
        [...listEl.children].forEach((li, i) => li.classList.toggle('active', i === activeIndex));
        if (activeIndex >= 0) listEl.children[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function selectMatch(i) { input.value = currentMatches[i]; closeList(); }

    // Rank: 0 = real name starts with query, 1 = an alias starts with it,
    // 2 = real name contains it, 3 = an alias contains it. Lower is better.
    function matchRank(entry, q) {
        const [nameKey, ...aliasKeys] = entry.keys;
        if (nameKey.startsWith(q)) return 0;
        if (aliasKeys.some(k => k.startsWith(q))) return 1;
        if (nameKey.includes(q)) return 2;
        if (aliasKeys.some(k => k.includes(q))) return 3;
        return -1;
    }

    input.addEventListener('input', () => {
        const q = normalizeName(input.value);
        if (!q) { closeList(); return; }
        const ranked = [];
        entries.forEach(e => {
            const r = matchRank(e, q);
            if (r >= 0) ranked.push({ name: e.name, r });
        });
        ranked.sort((a, b) => a.r - b.r || a.name.localeCompare(b.name));
        renderMatches(ranked.slice(0, 30).map(x => x.name));
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            // Suggestions open: Enter just confirms a match, same as before -
            // it does NOT submit yet. Only once the list is closed (nothing
            // left to pick) does Enter submit, so one keypress never does both.
            if (!listEl.hidden) {
                if (activeIndex >= 0) selectMatch(activeIndex);
                else if (currentMatches.length > 0) selectMatch(0);
                else closeList();
            } else {
                onEnterSubmit();
            }
            return;
        }
        if (listEl.hidden) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1); updateActiveStyles(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); updateActiveStyles(); }
        else if (e.key === 'Escape') { closeList(); }
    });

    listEl.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        e.preventDefault();
        selectMatch(Number(li.dataset.idx));
    });

    input.addEventListener('blur', () => setTimeout(closeList, 100));
}

// ---------- Main ----------
Promise.all([
    fetch('world.json').then(res => res.json()),
    fetch('adjacency.json').then(res => res.json()),
    fetch('schedule.json').then(res => res.json()),
    // Optional: if this fails to load the game falls back to centroid distances.
    fetch('distances.json').then(res => res.json()).catch(() => null)
]).then(([geoData, adjacencyMap, schedule, distanceData]) => {

    const svgNS = 'http://www.w3.org/2000/svg';

    // Norway's polygon includes Svalbard as separate ring(s) way up around
    // 74-81°N, far from the mainland (which tops out around 71°N). We don't
    // want that tiny arctic archipelago throwing off the silhouette, the
    // projection's fit, or the centroid fallback for distance/direction -
    // so drop any Norway sub-polygon that sits entirely north of it.
    const SVALBARD_LAT_CUTOFF = 74;
    geoData.features.forEach(f => {
        if (getIso(f) !== 'NOR') return;
        const geom = f.geometry;
        if (geom.type !== 'MultiPolygon') return;
        geom.coordinates = geom.coordinates.filter(polygon => {
            const allNorthOfCutoff = polygon.every(ring =>
                ring.every(([, lat]) => lat > SVALBARD_LAT_CUTOFF)
            );
            return !allNorthOfCutoff;
        });
    });

    // Kazakhstan's polygon stores the Baikonur Cosmodrome lease as an
    // interior ring (a hole), which renders as a punched-out circle showing
    // the dark background through the middle of the country. Drop it and
    // keep just the exterior ring so Kazakhstan fills solid.
    geoData.features.forEach(f => {
        if (getIso(f) !== 'KAZ') return;
        const geom = f.geometry;
        if (geom.type !== 'Polygon') return;
        geom.coordinates = geom.coordinates.slice(0, 1);
    });

    // Debug/QA tool: append ?date=YYYY-MM-DD to preview a future day's puzzle
    // (e.g. to check for rendering bugs before real players hit them).
    // Preview sessions never touch localStorage - no progress saved, no stats recorded.
    const urlParams = new URLSearchParams(window.location.search);
    const dateOverride = urlParams.get('date');
    const validOverride = dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride);
    const today = validOverride ? dateOverride : getLocalDateString();
    const isPreviewMode = validOverride && dateOverride !== getLocalDateString();

    if (isPreviewMode) {
        const banner = document.createElement('div');
        banner.className = 'preview-banner';
        banner.textContent = `Preview mode — showing ${today}'s puzzle. Nothing is saved.`;
        document.querySelector('.page').prepend(banner);
    }

    // ---------- Schedule tester (dev/testing tool) ----------
    // Hidden by default - visit once with ?test=1 to opt in, then Prev/Next/
    // Today all carry that flag forward automatically, so it's a one-time
    // link edit rather than something you re-type every time.
    const testerAllowed = isPreviewMode || urlParams.has('test');
    const testerRoot = document.getElementById('schedule-tester');
    const testToggleBtn = document.getElementById('test-toggle-btn');
    const testControls = document.getElementById('schedule-tester-controls');
    const testDateLabel = document.getElementById('schedule-tester-date');
    const prevDayBtn = document.getElementById('prev-day-btn');
    const nextDayBtn = document.getElementById('next-day-btn');
    const todayBtn = document.getElementById('today-btn');

    if (testerAllowed) testerRoot.hidden = false;
    testDateLabel.textContent = today;
    todayBtn.disabled = !isPreviewMode;
    if (isPreviewMode) testControls.hidden = false; // already testing - no need to re-click to expand

    testToggleBtn.addEventListener('click', () => {
        testControls.hidden = !testControls.hidden;
    });

    function navigateToDate(dateStr) {
        const url = new URL(window.location.href);
        url.searchParams.set('date', dateStr);
        url.searchParams.set('test', '1'); // keep the tester reachable after navigating
        window.location.href = url.toString();
    }

    prevDayBtn.addEventListener('click', () => navigateToDate(shiftDateString(today, -1)));
    nextDayBtn.addEventListener('click', () => navigateToDate(shiftDateString(today, 1)));
    todayBtn.addEventListener('click', () => {
        const url = new URL(window.location.href);
        url.searchParams.delete('date');
        url.searchParams.set('test', '1');
        window.location.href = url.toString();
    });

    const { countryA, countryB, sharedSegments } = getScheduledPair(geoData.features, schedule, today);
    const sweep = sortSegmentsForSweep(sharedSegments);

    const isoA = getIso(countryA);
    const isoB = getIso(countryB);

    const targets = [
        { iso: isoA, name: getName(countryA).trim().toLowerCase(), display: getName(countryA), solved: false },
        { iso: isoB, name: getName(countryB).trim().toLowerCase(), display: getName(countryB), solved: false }
    ];

    // "Ghost" territories (flagged in world.json, e.g. Western Sahara) are
    // drawn as unlabeled neighbor context only. They're not part of the game:
    // never selectable in autocomplete and never accepted as a guess.
    const playableFeatures = geoData.features.filter(f => !f.properties.ghost);
    const nameToFeature = new Map(playableFeatures.map(f => [getName(f).toLowerCase(), f]));
    const isoToCentroid = new Map(geoData.features.map(f => [getIso(f), d3.geoCentroid(f)]));

    // Guess distance = shortest distance between the two countries' borders
    // (closest point to closest point, like Globle), precomputed offline by
    // gen_distances.py into a triangular matrix. Centroid distance is
    // misleading for big or scattered countries (e.g. Kazakhstan can look
    // thousands of km from Russia while sharing a huge border). Centroids are
    // only a fallback now: if the matrix is missing or doesn't know a country,
    // and for the direction arrow of touching countries (see directionBearing).
    const distIndex = distanceData ? new Map(distanceData.isos.map((iso, i) => [iso, i])) : null;
    function borderDistanceKm(isoA, isoB) {
        if (isoA === isoB) return 0;
        const i = distIndex ? distIndex.get(isoA) : undefined;
        const j = distIndex ? distIndex.get(isoB) : undefined;
        if (i === undefined || j === undefined) {
            return haversineKm(isoToCentroid.get(isoA), isoToCentroid.get(isoB));
        }
        const lo = Math.min(i, j), hi = Math.max(i, j);
        return distanceData.d[lo][hi - lo - 1];
    }

    // Direction arrow from the guess toward the target. It points the same way
    // the distance is measured: from the guess's closest border point to the
    // target's closest border point (precomputed, 8 compass buckets). Where
    // that direction is meaningless - the countries touch or nearly touch (the
    // matrix stores '-'), or the pair is a listed border - it falls back to
    // center-to-center, which is what you want for neighbors anyway.
    function directionBearing(guessIso, targetIso, isBordering) {
        const centerBearing = () => bearingDeg(isoToCentroid.get(guessIso), isoToCentroid.get(targetIso));
        if (isBordering || !distIndex || !distanceData.b) return centerBearing();
        const i = distIndex.get(guessIso), j = distIndex.get(targetIso);
        if (i === undefined || j === undefined) return centerBearing();
        const lo = Math.min(i, j), hi = Math.max(i, j), k = hi - lo - 1;
        const ch = distanceData.b[lo][2 * k + (i < j ? 0 : 1)];
        return /^[0-7]$/.test(ch) ? Number(ch) * 45 : centerBearing();
    }

    // normalized name/alias -> canonical country name (as stored in world.json)
    const normalizedToCanonical = new Map();
    playableFeatures.forEach(f => normalizedToCanonical.set(normalizeName(getName(f)), getName(f)));
    const searchEntries = [...new Set(playableFeatures.map(getName).filter(Boolean))].sort().map(name => ({
        name,
        keys: [normalizeName(name), ...(COUNTRY_ALIASES[name] || []).map(normalizeName)]
    }));
    Object.entries(COUNTRY_ALIASES).forEach(([canonical, aliases]) => {
        if (!playableFeatures.some(f => getName(f) === canonical)) {
            console.warn(`COUNTRY_ALIASES: "${canonical}" doesn't match any country name in world.json`);
            return;
        }
        aliases.forEach(a => {
            const key = normalizeName(a);
            // never let an alias hijack a real country's own name
            if (!normalizedToCanonical.has(key)) normalizedToCanonical.set(key, canonical);
        });
    });
    // Typed text -> canonical country name, or null if nothing matches.
    function resolveCountryName(raw) {
        return normalizedToCanonical.get(normalizeName(raw)) || null;
    }
    // Assigned further down once the guess-submission logic exists. Safe to
    // reference here because this wrapper only ever runs later, in response
    // to a real keypress - by then the assignment below has already happened.
    let submitGuess;
    setupAutocomplete(document.getElementById('guess1'), document.getElementById('suggestions1'), searchEntries, () => submitGuess());
    setupAutocomplete(document.getElementById('guess2'), document.getElementById('suggestions2'), searchEntries, () => submitGuess());

    const svg = document.querySelector('svg.map');
    const pairCollection = { type: "FeatureCollection", features: [countryA, countryB] };
    const projection = d3.geoMercator().fitSize([360, 210], pairCollection);
    const pathGenerator = d3.geoPath().projection(projection);

    // Everything map-related lives inside one group so pan/zoom (added below)
    // can move and scale it all together with a single transform.
    const mapContent = document.createElementNS(svgNS, 'g');
    mapContent.setAttribute('class', 'map-content');
    svg.appendChild(mapContent);

    const neighborsGroup = document.createElementNS(svgNS, 'g');
    const targetsGroup = document.createElementNS(svgNS, 'g');
    const borderGroup = document.createElementNS(svgNS, 'g');
    mapContent.appendChild(neighborsGroup);
    mapContent.appendChild(targetsGroup);
    mapContent.appendChild(borderGroup);

    // Both countries are drawn as ONE path (not two overlapping ones). Two
    // separate <path> elements sharing an edge can leave a hairline seam from
    // independent anti-aliasing on each - which leaks exactly the border
    // we're trying to hide. A single combined path has one fill pass, so
    // there's no seam to leak.
    const combinedBlobData = [countryA, countryB].map(c => pathGenerator(c)).filter(Boolean).join(' ');
    const blobPath = document.createElementNS(svgNS, 'path');
    blobPath.setAttribute('d', combinedBlobData);
    blobPath.setAttribute('class', 'target-fill');
    targetsGroup.appendChild(blobPath);

    const borderPath = document.createElementNS(svgNS, 'path');
    borderPath.setAttribute('class', 'border-hint');
    borderPath.style.display = 'none';
    borderGroup.appendChild(borderPath);

    function borderSubsetPathData(fraction) {
        const { segments, mids, axisMin, axisMax } = sweep;
        const threshold = axisMin + (axisMax - axisMin) * fraction;
        let coords = segments.filter((_, i) => mids[i] <= threshold);
        // Guard against an all-clustered edge case (e.g. every midpoint sits
        // right at axisMin) still yielding nothing to show.
        if (coords.length === 0) coords = segments.slice(0, 1);
        const geo = { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: coords } };
        return pathGenerator(geo);
    }

    const neighborIsoSet = new Set([...(adjacencyMap[isoA] || []), ...(adjacencyMap[isoB] || [])]);
    neighborIsoSet.delete(isoA);
    neighborIsoSet.delete(isoB);
    const neighborFeatures = geoData.features.filter(f => neighborIsoSet.has(getIso(f)));

    function renderNeighborOutlines() {
        neighborsGroup.innerHTML = '';
        neighborFeatures.forEach(country => {
            const d = pathGenerator(country);
            if (!d) return;
            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('class', 'neighbor-outline');
            neighborsGroup.appendChild(path);
        });
        updateMinScale();
    }


    // ---------- Hints: two independent buttons, each with two stages ----------
    let hintUsedThisGame = false;
    let borderStage = 0;
    let neighborStage = 0;

    const hintBorderBtn = document.getElementById('hint-border-btn');
    const hintNeighborBtn = document.getElementById('hint-neighbor-btn');

    hintBorderBtn.addEventListener('click', () => {
        hintUsedThisGame = true;
        borderStage++;
        if (borderStage === 1) {
            borderPath.setAttribute('d', borderSubsetPathData(0.5));
            borderPath.style.display = 'inline';
            hintBorderBtn.textContent = 'Reveal full border';
        } else if (borderStage === 2) {
            borderPath.setAttribute('d', borderSubsetPathData(1));
            hintBorderBtn.textContent = 'Border fully revealed';
            hintBorderBtn.disabled = true;
        }
        saveProgress();
    });

    hintNeighborBtn.addEventListener('click', () => {
        hintUsedThisGame = true;
        neighborStage = 1;
        renderNeighborOutlines();
        hintNeighborBtn.textContent = 'Neighbors revealed';
        hintNeighborBtn.disabled = true;
        saveProgress();
    });

    // Used for every win (reward) AND for a loss (so the player sees what
    // they missed) - whether or not hints were used along the way. Once the
    // game is over there's nothing left to spoil, so withholding the full
    // reveal from a hint-assisted win doesn't protect anything; it just
    // denies the "aha" moment. Runs AFTER the outcome is already locked in,
    // so it never affects the "clean solve" stat either way.
    function revealMapAnimated() {
        if (neighborStage < 1) renderNeighborOutlines();

        // If the border hint already fully revealed it, leave it alone rather
        // than flashing it out and redrawing it for no visual reason.
        if (borderStage === 2) return;

        const fullPathData = borderSubsetPathData(1);
        borderPath.setAttribute('d', fullPathData);
        borderPath.style.display = 'inline';

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduceMotion) {
            borderPath.style.strokeDasharray = 'none';
            borderPath.style.strokeDashoffset = '0';
            return;
        }
        const length = borderPath.getTotalLength();
        borderPath.style.transition = 'none';
        borderPath.style.strokeDasharray = `${length}`;
        borderPath.style.strokeDashoffset = `${length}`;
        borderPath.getBoundingClientRect(); // force reflow so the next line animates
        borderPath.style.transition = 'stroke-dashoffset 1.1s ease-out';
        borderPath.style.strokeDashoffset = '0';
    }

    // ---------- Map pan & zoom ----------
    // Lets players zoom into cramped regions (a huge country like Russia
    // paired with several small, tightly-packed neighbors) instead of being
    // stuck with one fixed view where labels overlap and are unreadable.
    const HOME_SCALE = 1, MAX_SCALE = 8;
    // Normally you can't zoom out past the starting view (there's nothing outside
    // it). Once the neighbor outlines are on the map they can extend past the
    // frame, so updateMinScale() lowers this to let the player zoom out to see them.
    let minScale = HOME_SCALE;
    const MAP_W = 400, MAP_H = 250; // the svg's viewBox
    let view = { scale: 1, tx: 0, ty: 0 };

    // Panning is allowed at every zoom level (neighbor outlines often sit
    // outside the frame), with generous slack: the map can slide up to half a
    // frame past its normal edges, but not so far that it's lost completely.
    // The reset button (or zooming back out) brings it home.
    const PAN_SLACK = 0.5;
    function clampView() {
        const sx = MAP_W * PAN_SLACK, sy = MAP_H * PAN_SLACK;
        view.tx = Math.min(sx, Math.max(MAP_W * (1 - view.scale) - sx, view.tx));
        view.ty = Math.min(sy, Math.max(MAP_H * (1 - view.scale) - sy, view.ty));
    }

    function applyView() {
        clampView();
        mapContent.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.scale})`);
        svg.classList.toggle('zoomed', view.scale !== HOME_SCALE);
    }

    function svgPoint(clientX, clientY) {
        const pt = svg.createSVGPoint();
        pt.x = clientX; pt.y = clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        const p = pt.matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
    }

    function zoomAt(px, py, factor) {
        const oldScale = view.scale;
        const newScale = Math.min(MAX_SCALE, Math.max(minScale, oldScale * factor));
        if (newScale === oldScale) return;
        view.tx = px - (newScale / oldScale) * (px - view.tx);
        view.ty = py - (newScale / oldScale) * (py - view.ty);
        view.scale = newScale;
        applyView();
    }

    // Called whenever the neighbor outlines are drawn. Measures everything on the
    // map (the pair + its neighbors) and allows zooming out until it all fits,
    // with at least a little room to zoom out even if it already fits.
    function updateMinScale() {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        [countryA, countryB, ...neighborFeatures].forEach(f => {
            const b = pathGenerator.bounds(f);
            if (![b[0][0], b[0][1], b[1][0], b[1][1]].every(Number.isFinite)) return;
            x0 = Math.min(x0, b[0][0]); y0 = Math.min(y0, b[0][1]);
            x1 = Math.max(x1, b[1][0]); y1 = Math.max(y1, b[1][1]);
        });
        if (!Number.isFinite(x0)) { minScale = 0.5; return; }
        const fit = 0.9 * Math.min(MAP_W / Math.max(1, x1 - x0), MAP_H / Math.max(1, y1 - y0));
        minScale = Math.max(0.15, Math.min(0.7, fit));
    }

    function resetView() {
        view = { scale: 1, tx: 0, ty: 0 };
        applyView();
    }

    document.getElementById('zoom-in-btn').addEventListener('click', () => zoomAt(200, 125, 1.5));
    document.getElementById('zoom-out-btn').addEventListener('click', () => zoomAt(200, 125, 1 / 1.5));
    document.getElementById('zoom-reset-btn').addEventListener('click', resetView);

    // Wheel over the map zooms the map and never scrolls the page - even once
    // fully zoomed in or out - so the page can't jump away mid-zoom. (Scrolling
    // with the cursor anywhere else on the page works as normal.)
    svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { x, y } = svgPoint(e.clientX, e.clientY);
        // Proportional to the wheel delta so mouse wheels and (much smaller,
        // much more frequent) trackpad-pinch events both feel right.
        const delta = Math.max(-60, Math.min(60, e.deltaY));
        zoomAt(x, y, Math.exp(-delta * 0.004));
    }, { passive: false });

    // Mouse drag to pan (at any zoom level)
    let dragStart = null;
    svg.addEventListener('mousedown', (e) => {
        dragStart = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        svg.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragStart) return;
        const ctm = svg.getScreenCTM();
        const k = ctm ? 1 / ctm.a : 1; // CSS px -> viewBox units
        view.tx = dragStart.tx + (e.clientX - dragStart.x) * k;
        view.ty = dragStart.ty + (e.clientY - dragStart.y) * k;
        applyView();
    });
    window.addEventListener('mouseup', () => { dragStart = null; svg.classList.remove('dragging'); });

    // Touch:
    //  - two fingers: pinch-zoom AND pan together (any zoom level)
    //  - one finger, zoomed in: pan freely
    //  - one finger, not zoomed: a mostly-horizontal drag pans the map, while a
    //    mostly-vertical drag is left alone so the page can scroll (CSS keeps
    //    touch-action: pan-y until the map is zoomed, so the browser only
    //    claims vertical swipes at that point).
    let touchState = null;
    const AXIS_LOCK_PX = 8;
    svg.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            const t = e.touches[0];
            touchState = {
                mode: view.scale !== HOME_SCALE ? 'pan' : 'pending',
                x: t.clientX, y: t.clientY, tx: view.tx, ty: view.ty
            };
        } else if (e.touches.length === 2) {
            const [t0, t1] = e.touches;
            const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
            const mid = svgPoint((t0.clientX + t1.clientX) / 2, (t0.clientY + t1.clientY) / 2);
            touchState = { mode: 'pinch', dist, scale: view.scale, cx: mid.x, cy: mid.y, tx: view.tx, ty: view.ty };
        }
    }, { passive: true });

    svg.addEventListener('touchmove', (e) => {
        if (!touchState) return;
        if (touchState.mode === 'pending' && e.touches.length === 1) {
            const dx = e.touches[0].clientX - touchState.x, dy = e.touches[0].clientY - touchState.y;
            if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
            if (Math.abs(dx) > Math.abs(dy)) touchState.mode = 'pan';   // horizontal: pan the map
            else { touchState = null; return; }                         // vertical: let the page scroll
        }
        if (touchState.mode === 'pan' && e.touches.length === 1) {
            const ctm = svg.getScreenCTM();
            const k = ctm ? 1 / ctm.a : 1;
            view.tx = touchState.tx + (e.touches[0].clientX - touchState.x) * k;
            view.ty = touchState.ty + (e.touches[0].clientY - touchState.y) * k;
            applyView();
            e.preventDefault();
        } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
            const [t0, t1] = e.touches;
            const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
            const mid = svgPoint((t0.clientX + t1.clientX) / 2, (t0.clientY + t1.clientY) / 2);
            const newScale = Math.min(MAX_SCALE, Math.max(minScale, touchState.scale * (dist / touchState.dist)));
            // keep the map point that started under the fingers under their current midpoint
            view.tx = mid.x - (newScale / touchState.scale) * (touchState.cx - touchState.tx);
            view.ty = mid.y - (newScale / touchState.scale) * (touchState.cy - touchState.ty);
            view.scale = newScale;
            applyView();
            e.preventDefault();
        }
    }, { passive: false });

    svg.addEventListener('touchend', () => { touchState = null; });

    // Clicking anywhere on the dimmed backdrop (i.e. not inside the modal's
    // content card) closes it, same as hitting the × button.
    function closeOnBackdropClick(modalEl) {
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) modalEl.classList.add('hidden');
        });
    }

    // ---------- Stats modal ----------
    const modal = document.getElementById('stats-modal');
    document.getElementById('stats-btn').addEventListener('click', () => {
        renderStatsUI(loadStats(), getTodaysBucket());
        renderCountryReveal();
        modal.classList.remove('hidden');
    });
    document.getElementById('close-modal').addEventListener('click', () => modal.classList.add('hidden'));
    closeOnBackdropClick(modal);

    // ---------- How to play modal ----------
    const howtoModal = document.getElementById('howto-modal');
    document.getElementById('howto-btn').addEventListener('click', () => howtoModal.classList.remove('hidden'));
    document.getElementById('close-howto-modal').addEventListener('click', () => howtoModal.classList.add('hidden'));
    closeOnBackdropClick(howtoModal);

    // ---------- Settings modal ----------
    const settingsModal = document.getElementById('settings-modal');
    const hardModeToggle = document.getElementById('setting-hardmode');
    const milesToggle = document.getElementById('setting-miles');
    hardModeToggle.checked = settings.hardMode;
    milesToggle.checked = settings.useMiles;
    document.getElementById('settings-btn').addEventListener('click', () => {
        updateHardModeLock();
        settingsModal.classList.remove('hidden');
    });
    document.getElementById('close-settings-modal').addEventListener('click', () => settingsModal.classList.add('hidden'));
    closeOnBackdropClick(settingsModal);
    // Hard mode is fixed for a game once its first guess is made: otherwise
    // you could play on easy mode and flip hard mode on just to bank the
    // stats (or the reverse after seeing a hint). It unlocks again when the
    // game ends. `gameHardMode` is the value the current game is actually
    // being played with (null until the first guess); it is saved with the
    // game's progress so a refresh can't be used to dodge the lock.
    const hardModeLockNote = document.getElementById('hardmode-lock-note');
    const hardModeBadge = document.getElementById('hardmode-badge');
    const isHardModeLocked = () => gameHardMode !== null && !gameOver;
    const activeHardMode = () => gameHardMode !== null ? gameHardMode : settings.hardMode;
    function updateHardModeLock() {
        const locked = isHardModeLocked();
        hardModeToggle.disabled = locked;
        hardModeToggle.checked = locked ? gameHardMode : settings.hardMode;
        if (hardModeLockNote) hardModeLockNote.hidden = !locked;
        if (hardModeBadge) hardModeBadge.hidden = !activeHardMode();
    }
    hardModeToggle.addEventListener('change', () => {
        if (isHardModeLocked()) { updateHardModeLock(); return; } // revert any attempt to change it
        settings.hardMode = hardModeToggle.checked;
        saveSettings(settings);
        updateHardModeLock();
    });
    milesToggle.addEventListener('change', () => {
        settings.useMiles = milesToggle.checked;
        saveSettings(settings);
    });

    // ---------- Guess submission ----------
    const guessInputs = [document.getElementById('guess1'), document.getElementById('guess2')];
    const submitBtn = document.getElementById('submit-btn');
    const feedback = document.getElementById('feedback');
    const attemptsElem = document.getElementById('attempts');
    const historyEl = document.getElementById('history');
    let attempts = 0;
    let gameOver = false;
    let gameHardMode = null; // hard-mode value this game is played with; set on the first guess
    const guessedNamesHistory = new Set(); // every name ever submitted, any box, any attempt
    let historyLog = []; // plain-data copy of every attempt's results, so a refresh can rebuild the log
    const PROGRESS_KEY = 'mergle_progress';

    function lockInput(i, target) {
        guessInputs[i].value = target.display;
        guessInputs[i].disabled = true;
        guessInputs[i].classList.add('correct');
    }

    function allSolved() { return targets.every(t => t.solved); }

    // The bucket (1-6, or 'loss') for today's already-finished game, so the
    // distribution chart can highlight it. null while today's game is still
    // in progress, or during a schedule-tester preview.
    function getTodaysBucket() {
        if (isPreviewMode || !gameOver) return null;
        return allSolved() ? attempts : 'loss';
    }

    // Shows both target country names (even the ones a player never solved).
    // Only meaningful once the game is over - hidden otherwise so it can't
    // spoil a game still in progress if the player opens Stats mid-attempt.
    function renderCountryReveal() {
        const box = document.getElementById('reveal-countries');
        if (!gameOver) { box.hidden = true; updateShareUI(); return; }
        document.getElementById('reveal-countries-text').textContent =
            targets.map(t => t.display).join(' & ');
        document.getElementById('reveal-result-text').textContent = allSolved()
            ? `Solved in ${attempts} of ${MAX_ATTEMPTS} guesses`
            : 'Out of guesses. Come back tomorrow.';
        const flags = [];
        if (activeHardMode()) flags.push('hard mode');
        if (hintUsedThisGame) flags.push('hints used');
        const flagsText = flags.join(', ');
        document.getElementById('reveal-flags-text').textContent = flagsText.charAt(0).toUpperCase() + flagsText.slice(1);
        box.classList.toggle('lost', !allSolved());
        box.hidden = false;
        updateShareUI();
    }

    // ---------- Share ----------
    // A spoiler-free, Wordle-style summary: puzzle number, score and one emoji
    // square per guess (🟩 correct, 🟫 a neighbor, 🟥🟧🟨⬜ hot -> cold, ⬛ no
    // info). No country names or distances are included.
    const shareButtons = [...document.querySelectorAll('.share-btn')]; // stats screen + game page
    const shareMainBtn = document.getElementById('share-btn-main');

    function shareSquare(r) {
        if (r.type === 'correct') return '\u{1F7E9}';                                   // 🟩
        // Hard-mode guesses and the "other guess was closer" loser gave the player no
        // distance info, so they don't get a heat color in the grid either.
        if (r.type !== 'proximity' || r.suppressed || r.hardMode) return '\u2B1B';       // ⬛
        if (r.isBordering) return '\u{1F7EB}';                                          // 🟫
        const t = heatT(r.distance);
        if (t >= 0.75) return '\u{1F7E5}';                                              // 🟥 within ~2,600 km
        if (t >= 0.5) return '\u{1F7E7}';                                               // 🟧 ~2,600-5,500 km
        if (t >= 0.25) return '\u{1F7E8}';                                              // 🟨 ~5,500-9,000 km
        return '\u2B1C';                                                                // ⬜ farther
    }

    function shareUrl() {
        try {
            if (location.protocol === 'file:') return '';
            return location.origin + location.pathname.replace(/index\.html$/, '');
        } catch (e) { return ''; }
    }

    function buildShareText() {
        const puzzleNumber = daysSinceEpoch(today, SCHEDULE_EPOCH) + 1;
        const score = `${allSolved() ? attempts : 'X'}/${MAX_ATTEMPTS}`;
        const flags = (activeHardMode() ? ' \u{1F525}' : '') + (hintUsedThisGame ? ' \u{1F4A1}' : ''); // 🔥 hard mode, 💡 hints used
        const lines = [`Mergle #${puzzleNumber} ${score}${flags}`, ''];
        historyLog.forEach(entry => lines.push(entry.results.map(shareSquare).join('')));
        const url = shareUrl();
        if (url) lines.push('', url);
        return lines.join('\n');
    }

    function updateShareUI() {
        shareButtons.forEach(b => { b.hidden = !gameOver; }); // only offered once the game is finished
    }

    const isMobileDevice = () =>
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform || ''));

    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* fall through to the legacy method */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return !!ok;
        } catch (e) { return false; }
    }

    let shareFeedbackTimer = null;
    function flashShareFeedback() {
        shareButtons.forEach(b => { b.dataset.label = b.dataset.label || b.textContent; b.textContent = 'Copied \u2713'; });
        clearTimeout(shareFeedbackTimer);
        shareFeedbackTimer = setTimeout(() => {
            shareButtons.forEach(b => { if (b.dataset.label) b.textContent = b.dataset.label; });
        }, 2500);
    }

    async function shareResult() {
        if (!gameOver) return;
        const text = buildShareText();
        // Phones: the native share sheet. Desktop: copy to the clipboard.
        if (navigator.share && isMobileDevice()) {
            try { await navigator.share({ text }); return; }
            catch (e) {
                if (e && e.name === 'AbortError') return; // player closed the sheet
                /* any other failure: fall back to copying */
            }
        }
        if (await copyToClipboard(text)) {
            flashShareFeedback();
        } else {
            // Last resort when the browser blocks clipboard access: show the text so it can be copied by hand.
            window.prompt('Copy your result:', text);
        }
    }
    shareButtons.forEach(b => b.addEventListener('click', shareResult));

    function nearestUnsolvedTarget(guessedFeature) {
        const unsolved = targets.filter(t => !t.solved);
        const guessIso = getIso(guessedFeature);
        let best = null, bestDist = Infinity;
        unsolved.forEach(t => {
            // A listed border always counts as distance 0, even where the
            // simplified geometry doesn't quite touch (exclaves etc.).
            const isAdjacent = (adjacencyMap[guessIso] || []).includes(t.iso);
            const d = isAdjacent ? 0 : borderDistanceKm(guessIso, t.iso);
            if (d < bestDist) { bestDist = d; best = t; }
        });
        return { target: best, distance: bestDist };
    }

    // Builds the little "<name> <verdict>" span for one guess in the history
    // log. The name is rendered via textContent (not string-interpolated
    // into innerHTML) everywhere below, even where the source is one of our
    // own trusted country names - so that if a future change ever lets
    // unsanitized user text reach here (e.g. the 'unrecognized' branch,
    // which today's earlier validation makes unreachable), it's inert text
    // rather than an HTML/script injection.
    function nameSpan(name) {
        const span = document.createElement('span');
        span.className = 'history-chip-name';
        span.textContent = name;
        return span;
    }

    function buildChip(r) {
        const chip = document.createElement('span');
        chip.className = 'history-chip';

        // Use the hard-mode setting that was active WHEN THIS GUESS WAS MADE
        // (stamped by submitGuess), not whatever Settings says right now.
        // r.hardMode is undefined only for history saved before this fix
        // existed - fall back to the live setting for those legacy entries,
        // since we have no record of what was in effect at the time.
        const hardModeForThisGuess = r.hardMode !== undefined ? r.hardMode : settings.hardMode;

        if (r.type === 'correct') {
            chip.classList.add('correct');
            chip.appendChild(nameSpan(r.name));
            chip.appendChild(document.createTextNode(' Correct ✓'));
            return chip;
        }
        if (r.type === 'unrecognized') {
            // Defensive fallback only - submitGuess() already rejects any
            // guess that isn't in nameToFeature before a result object is
            // ever built, so this branch shouldn't fire in practice. Kept
            // (rather than removed) as a safety net in case that earlier
            // validation is ever changed; safe either way since the name
            // goes through nameSpan()'s textContent, not innerHTML.
            chip.appendChild(nameSpan(r.name));
            chip.appendChild(document.createTextNode(' not recognized'));
            return chip;
        }
        if (hardModeForThisGuess) {
            chip.appendChild(nameSpan(r.name));
            chip.appendChild(document.createTextNode(' Incorrect'));
            return chip;
        }
        if (r.suppressed) {
            chip.classList.add('suppressed');
            chip.appendChild(nameSpan(r.name));
            chip.appendChild(document.createTextNode(' — your other guess was closer'));
            return chip;
        }
        const color = heatColor(r.distance, r.isBordering);
        const textColor = contrastTextColor(color);
        const arrow = bearingToArrow(r.bearing);
        const shownDistance = settings.useMiles ? r.distance * KM_TO_MILES : r.distance;
        const unit = settings.useMiles ? 'mi' : 'km';
        const info = r.isBordering ? 'Bordering it!' : `${Math.round(shownDistance).toLocaleString()} ${unit}`;
        const badge = document.createElement('span');
        badge.className = 'direction-badge';
        badge.style.background = color;
        badge.style.color = textColor;
        badge.textContent = arrow;
        chip.appendChild(badge);
        chip.appendChild(nameSpan(r.name));
        chip.appendChild(document.createTextNode(` ${info}`));
        return chip;
    }

    function renderHistoryRow(attemptNumber, results) {
        const row = document.createElement('div');
        row.className = 'history-row';
        const label = document.createElement('div');
        label.className = 'history-row-label';
        label.textContent = `Attempt ${attemptNumber}`;
        row.appendChild(label);
        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'history-guesses';
        results.forEach(r => chipsWrap.appendChild(buildChip(r)));
        row.appendChild(chipsWrap);
        historyEl.insertBefore(row, historyEl.firstChild); // newest attempt on top
    }

    function saveProgress() {
        if (isPreviewMode) return; // QA sessions never touch real saved state
        const progress = {
            date: today,
            attempts,
            gameOver,
            won: gameOver ? allSolved() : null,
            hintUsedThisGame,
            hardMode: gameHardMode,
            borderStage,
            neighborStage,
            guessedNames: [...guessedNamesHistory],
            historyLog,
            inputs: guessInputs.map(inp => ({
                value: inp.value,
                disabled: inp.disabled,
                correct: inp.classList.contains('correct'),
                revealed: inp.classList.contains('revealed')
            })),
            targetsSolved: targets.map(t => t.solved),
            targets: targets.map(t => t.iso) // which pair this save belongs to
        };
        storageSet(PROGRESS_KEY, JSON.stringify(progress));
    }

    function finishGame(won) {
        gameOver = true;
        updateHardModeLock(); // game finished: the toggle is free again
        if (!won) {
            const unsolvedTargets = targets.filter(t => !t.solved);
            const activeIdx = [0, 1].filter(i => !guessInputs[i].disabled);
            activeIdx.forEach((i, idx) => {
                const t = unsolvedTargets[idx];
                guessInputs[i].value = t.display;
                guessInputs[i].disabled = true;
                guessInputs[i].classList.add('revealed');
            });
        }
        guessInputs.forEach(input => input.disabled = true);
        submitBtn.disabled = true;
        hintBorderBtn.disabled = true;
        hintNeighborBtn.disabled = true;

        if (won) {
            revealMapAnimated();
            feedback.textContent = `Correct! Solved in ${attempts}/${MAX_ATTEMPTS} attempts.`;
            feedback.style.color = 'var(--success)';
        } else {
            revealMapAnimated();
            feedback.textContent = `Out of attempts. Better luck tomorrow!`;
            feedback.style.color = 'var(--danger)';
        }

        if (!isPreviewMode) {
            const updatedStats = recordResult(won, hintUsedThisGame, attempts, today, activeHardMode());
            renderStatsUI(updatedStats, won ? attempts : 'loss');
        }
        renderCountryReveal();
        saveProgress();
        setTimeout(() => modal.classList.remove('hidden'), 900);
    }

    submitGuess = function() {
        if (gameOver) return;

        const activeIdx = [0, 1].filter(i => !guessInputs[i].disabled);
        const activeRaw = activeIdx.map(i => guessInputs[i].value.trim());
        // Resolve whatever was typed (alias, no accents, etc.) to the canonical
        // lowercase name the rest of the logic keys on. Unknown text is left
        // as-is so the "isn't a recognized country" check below still fires.
        const activeVals = activeRaw.map(v => {
            const canonical = resolveCountryName(v);
            return (canonical || v).toLowerCase();
        });

        if (activeVals.some(v => !v)) {
            feedback.textContent = "Please enter a country name.";
            feedback.style.color = "orange";
            return;
        }
        const unrecognizedPos = activeVals.findIndex(v => !nameToFeature.has(v));
        if (unrecognizedPos !== -1) {
            feedback.textContent = `"${activeRaw[unrecognizedPos]}" isn't a recognized country name — pick one from the suggestions.`;
            feedback.style.color = "orange";
            return;
        }
        if (activeVals.length === 2 && activeVals[0] === activeVals[1]) {
            feedback.textContent = "Enter two different countries.";
            feedback.style.color = "orange";
            return;
        }
        const repeatIdx = activeVals.findIndex(v => guessedNamesHistory.has(v));
        if (repeatIdx !== -1) {
            feedback.textContent = "You already tried that country — pick a different one.";
            feedback.style.color = "orange";
            return;
        }

        attempts++;
        attemptsElem.textContent = attempts;
        activeVals.forEach(v => guessedNamesHistory.add(v));
        if (gameHardMode === null) gameHardMode = settings.hardMode; // lock hard mode for this game
        updateHardModeLock();

        // Two passes on purpose: if one box is correct THIS attempt, it must be
        // marked solved before we compute the other box's proximity - otherwise
        // "nearest unsolved target" can still point at the country you just
        // correctly guessed in the same submission.
        const correctResults = [];
        const pendingWrong = [];
        activeIdx.forEach((i, idx) => {
            const val = activeVals[idx];
            const match = targets.find(t => !t.solved && t.name === val);
            if (match) {
                match.solved = true;
                correctResults.push({ boxIndex: i, name: match.display, type: 'correct', targetRef: match });
            } else {
                pendingWrong.push({ boxIndex: i, val });
            }
        });

        let newlySolved = correctResults.length;
        correctResults.forEach(r => lockInput(r.boxIndex, r.targetRef));

        const wrongResults = pendingWrong.map(({ boxIndex, val }) => {
            guessInputs[boxIndex].value = ''; // clear it - the result is recorded in the history log below
            const guessedFeature = nameToFeature.get(val);
            if (!guessedFeature) return { boxIndex, name: val, type: 'unrecognized' };
            const { target, distance } = nearestUnsolvedTarget(guessedFeature);
            const isBordering = (adjacencyMap[getIso(guessedFeature)] || []).includes(target.iso);
            const bearing = directionBearing(getIso(guessedFeature), target.iso, isBordering);
            // Geometry can touch at a single point without being a listed border
            // (e.g. Namibia/Zimbabwe) - show 1 km rather than a confusing "0 km".
            return { boxIndex, name: getName(guessedFeature), type: 'proximity', distance: isBordering ? distance : Math.max(1, distance), bearing, isBordering };
        });

        // Recombine in original box order for display
        const results = activeIdx.map(i =>
            correctResults.find(r => r.boxIndex === i) || wrongResults.find(r => r.boxIndex === i)
        );

        // Stamp each result with the hard-mode value this game is played with,
        // so history rendering stays faithful to what was in effect - not
        // whatever Settings happens to say later (e.g. after the game ends and
        // the toggle unlocks).
        results.forEach(r => { r.hardMode = activeHardMode(); });

        // Only the CLOSER of two simultaneous wrong guesses shows its distance/direction,
        // unless both happen to be bordering their nearest target - then both show.
        const infoCandidates = results.filter(r => r.type === 'proximity');
        if (infoCandidates.length === 2) {
            const bothBordering = infoCandidates.every(r => r.isBordering);
            if (!bothBordering) {
                const effDist = r => r.isBordering ? -1 : r.distance;
                const winner = effDist(infoCandidates[0]) <= effDist(infoCandidates[1]) ? infoCandidates[0] : infoCandidates[1];
                const loser = winner === infoCandidates[0] ? infoCandidates[1] : infoCandidates[0];
                loser.suppressed = true;
            }
        }

        historyLog.push({ attemptNumber: attempts, results });
        renderHistoryRow(attempts, results);

        if (allSolved()) {
            finishGame(true);
        } else if (attempts >= MAX_ATTEMPTS) {
            finishGame(false);
        } else if (newlySolved > 0) {
            feedback.textContent = "One correct! Now guess the other country.";
            feedback.style.color = "var(--hint-gold)";
            saveProgress();
        } else {
            feedback.textContent = "Incorrect. Try again.";
            feedback.style.color = "var(--danger)";
            saveProgress();
        }
    };
    submitBtn.addEventListener('click', submitGuess);

    function restoreProgress() {
        if (isPreviewMode) return;
        const raw = storageGet(PROGRESS_KEY);
        if (!raw) return;
        let progress;
        try { progress = JSON.parse(raw); } catch (e) { return; }
        if (!progress || progress.date !== today) return; // a new day's puzzle starts fresh
        // Ignore saves that belong to a different pair (e.g. the schedule was
        // updated after the player started) or that are malformed.
        if (!Array.isArray(progress.targets) || progress.targets.join() !== targets.map(t => t.iso).join()) return;
        if (!Number.isInteger(progress.attempts) ||
            !Array.isArray(progress.guessedNames) ||
            !Array.isArray(progress.targetsSolved) ||
            !Array.isArray(progress.inputs) || progress.inputs.length !== guessInputs.length) return;

        attempts = progress.attempts;
        attemptsElem.textContent = attempts;
        hintUsedThisGame = progress.hintUsedThisGame;
        if (attempts > 0) {
            // Which mode was this game started in? Newer saves store it; for older
            // ones, read it off the first stamped guess, else fall back to the setting.
            const firstResult = ((progress.historyLog || [])[0] || {}).results;
            gameHardMode = typeof progress.hardMode === 'boolean' ? progress.hardMode
                : (firstResult && typeof firstResult[0].hardMode === 'boolean' ? firstResult[0].hardMode : settings.hardMode);
        }
        borderStage = progress.borderStage;
        neighborStage = progress.neighborStage;
        progress.guessedNames.forEach(n => guessedNamesHistory.add(n));
        progress.targetsSolved.forEach((solved, i) => { targets[i].solved = solved; });

        progress.inputs.forEach((state, i) => {
            guessInputs[i].value = state.value;
            if (state.disabled) guessInputs[i].disabled = true;
            if (state.correct) guessInputs[i].classList.add('correct');
            if (state.revealed) guessInputs[i].classList.add('revealed');
        });

        historyLog = progress.historyLog || [];
        historyEl.innerHTML = '';
        historyLog.forEach(entry => renderHistoryRow(entry.attemptNumber, entry.results));

        if (borderStage >= 1) {
            borderPath.setAttribute('d', borderSubsetPathData(borderStage >= 2 ? 1 : 0.5));
            borderPath.style.display = 'inline';
            hintBorderBtn.textContent = borderStage >= 2 ? 'Border fully revealed' : 'Reveal full border';
            if (borderStage >= 2) hintBorderBtn.disabled = true;
        }
        if (neighborStage >= 1) {
            renderNeighborOutlines();
            hintNeighborBtn.textContent = 'Neighbors revealed';
            hintNeighborBtn.disabled = true;
        }

        if (progress.gameOver) {
            gameOver = true;
            guessInputs.forEach(inp => inp.disabled = true);
            submitBtn.disabled = true;
            hintBorderBtn.disabled = true;
            hintNeighborBtn.disabled = true;

            // Game over (win or loss) auto-reveals everything, regardless of
            // hints used along the way - that reveal isn't tracked by
            // borderStage/neighborStage, so restore it here.
            renderNeighborOutlines();
            borderPath.setAttribute('d', borderSubsetPathData(1));
            borderPath.style.display = 'inline';
            borderPath.style.strokeDasharray = 'none';
            borderPath.style.strokeDashoffset = '0';

            if (progress.won) {
                feedback.textContent = `Correct! Solved in ${attempts}/${MAX_ATTEMPTS} attempts.`;
                feedback.style.color = 'var(--success)';
            } else {
                feedback.textContent = `Out of attempts. Better luck tomorrow!`;
                feedback.style.color = 'var(--danger)';
            }
            renderStatsUI(loadStats(), progress.won ? attempts : 'loss');
            renderCountryReveal();
            modal.classList.remove('hidden');
        }
    }
    restoreProgress();
    updateHardModeLock();

}).catch(err => {
    console.error(err);
    document.body.innerHTML += `<p style="color:#d9622f">Failed to load the game: ${err.message}</p>`;
});
