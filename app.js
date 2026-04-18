import exifr from 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs';

// photo filenames — add new photos here
const PHOTOS = [
  'IMG_6945.avif','IMG_6879.avif','IMG_6856.avif','IMG_1783.avif','IMG_1779.avif',
  'IMG_6622.avif','IMG_6168.avif','IMG_8348.avif','IMG_6052.avif','IMG_5952.avif',
  'IMG_5950.avif','IMG_5825.avif','IMG_5743.avif','IMG_5741.avif','IMG_5737.avif',
  'IMG_5710.avif','IMG_5701.avif','IMG_5074.avif','IMG_4124.avif','IMG_3860.avif'
];

const R = Math.PI / 180;
const EARTH_R = 6_371_000;
const SPECTRUM = ['#e44','#e82','#ec3','#3b3','#39f','#44c','#80a'];
const compass = d => ['n','ne','e','se','s','sw','w','nw'][Math.round(d / 45) % 8];
const cache = new Map();


// ── exif ────────────────────────────────────────────────

async function readExif(url) {
  const data = await exifr.parse(url, {
    pick: ['DateTimeOriginal', 'OffsetTimeOriginal',
           'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef',
           'GPSAltitude', 'GPSImgDirection'],
    reviveValues: false, // keep DateTimeOriginal as raw string
  });
  if (!data || !data.GPSLatitude) return null;

  // parse GPS — exifr with reviveValues:false gives arrays [deg,min,sec]
  const gps = (arr, ref) => {
    if (typeof arr === 'number') return arr; // already decimal
    const [d, m, s] = arr;
    const dec = d + m / 60 + s / 3600;
    return (ref === 'S' || ref === 'W') ? -dec : dec;
  };
  const lat = gps(data.GPSLatitude, data.GPSLatitudeRef);
  const lon = gps(data.GPSLongitude, data.GPSLongitudeRef);

  // parse datetime to UTC
  // raw string like "2024:11:30 10:43:35"
  const raw = data.DateTimeOriginal;
  if (!raw) return null;
  const dtStr = String(raw).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  // build as UTC first, then adjust for offset
  const localMs = new Date(dtStr + 'Z').getTime(); // treat as UTC initially
  const ofs = data.OffsetTimeOriginal;
  let utcMs = localMs;
  if (ofs && typeof ofs === 'string' && ofs !== 'Z') {
    const sign = ofs.startsWith('-') ? 1 : -1;
    const parts = ofs.replace(/[+-]/, '').split(':');
    utcMs = localMs + sign * (parseInt(parts[0]) * 60 + parseInt(parts[1] || 0)) * 60000;
  }

  return {
    taken_at: new Date(utcMs),
    latitude: lat,
    longitude: lon,
    altitude_m: parseFloat(data.GPSAltitude) || 0,
    camera_bearing: parseFloat(data.GPSImgDirection) || null,
  };
}

// ── solar position ──────────────────────────────────────

function sun(lat, lon, d) {
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
  const b = R * 360 / 365 * (doy - 81);
  const decl = 23.45 * Math.sin(b);
  const eot = 9.87 * Math.sin(2*b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const ha = 15 * (d.getUTCHours() + d.getUTCMinutes()/60 + d.getUTCSeconds()/3600 - 12 + lon/15 + eot/60);
  const sinE = Math.sin(lat*R)*Math.sin(decl*R) + Math.cos(lat*R)*Math.cos(decl*R)*Math.cos(ha*R);
  const el = Math.asin(sinE) / R;
  const cosAz = (Math.sin(decl*R) - Math.sin(lat*R)*sinE) / (Math.cos(lat*R)*Math.cos(el*R));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / R;
  if (ha > 0) az = 360 - az;
  return { elevation: el, azimuth: az, antiSolarAz: (az + 180) % 360 };
}

// ── rainbow geometry ────────────────────────────────────

function rainbowFootBearings(sunEl, sunAz) {
  const antiAz = (sunAz + 180) % 360;
  const cosD = Math.cos(42 * R) / Math.cos(sunEl * R);
  if (Math.abs(cosD) > 1) return [antiAz, antiAz];
  const delta = Math.acos(cosD) / R;
  return [(antiAz - delta + 360) % 360, (antiAz + delta) % 360];
}

function destinationPoint(lat, lon, bearing, dist) {
  const lr = lat * R, lo = lon * R, b = bearing * R, d = dist / EARTH_R;
  const lat2 = Math.asin(Math.sin(lr)*Math.cos(d) + Math.cos(lr)*Math.sin(d)*Math.cos(b));
  const lon2 = lo + Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(lr), Math.cos(d) - Math.sin(lr)*Math.sin(lat2));
  return [lat2 / R, lon2 / R];
}

function offset(lat, lon, bearing, dist) {
  return [lat + dist * Math.cos(bearing * R), lon + dist * Math.sin(bearing * R) / Math.cos(lat * R)];
}

// ── elevation api ───────────────────────────────────────

async function fetchElevations(coords) {
  const lats = coords.map(c => c[0].toFixed(6)).join(',');
  const lons = coords.map(c => c[1].toFixed(6)).join(',');
  const resp = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
  const data = await resp.json();
  return data.elevation.map(Number);
}

// ── terrain tracing ─────────────────────────────────────

async function traceFoot(obsLat, obsLon, obsAlt, bearing) {
  const dists = [100,200,300,400,500,700,900,1200,1500,2000,2500,3000,4000,5000];
  const coords = dists.map(d => destinationPoint(obsLat, obsLon, bearing, d));
  const elevs = await fetchElevations(coords);

  let prevGap = null;
  let lowest = { alt: Infinity, dist: 0, lat: 0, lon: 0 };

  for (let i = 0; i < dists.length; i++) {
    const d = dists[i], [plat, plon] = coords[i], t = elevs[i];
    const gap = obsAlt - t - d*d / (2*EARTH_R);
    if (prevGap !== null && prevGap > 0 && gap <= 0)
      return { lat: plat, lon: plon, alt: t, dist: d };
    if (t < lowest.alt && d >= 200)
      lowest = { lat: plat, lon: plon, alt: t, dist: d };
    prevGap = gap;
  }
  return lowest.dist > 0 ? lowest : { lat: coords[2][0], lon: coords[2][1], alt: elevs[2], dist: dists[2] };
}

// ── weather api ─────────────────────────────────────────

async function fetchWeather(lat, lon, dt) {
  const dateStr = dt.toISOString().slice(0, 10);
  const hour = dt.getUTCHours();
  const params = new URLSearchParams({
    latitude: lat, longitude: lon, start_date: dateStr, end_date: dateStr,
    hourly: 'temperature_2m,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,weather_code,surface_pressure',
  });
  for (const base of ['https://archive-api.open-meteo.com/v1/archive', 'https://api.open-meteo.com/v1/forecast']) {
    try {
      const resp = await fetch(`${base}?${params}`);
      const data = await resp.json();
      if (!data.error) {
        const h = data.hourly;
        return {
          temperature_c: h.temperature_2m[hour],
          relative_humidity: h.relative_humidity_2m[hour],
          precipitation_mm: h.precipitation[hour],
          wind_speed_kmh: h.wind_speed_10m[hour],
          wind_direction_deg: h.wind_direction_10m[hour],
        };
      }
    } catch(e) { /* try next */ }
  }
  return null;
}

// ── compute everything for one photo ────────────────────

async function computeAll(filename) {
  if (cache.has(filename)) return cache.get(filename);

  const url = 'photos/web/' + filename;
  const exif = await readExif(url);
  if (!exif) { cache.set(filename, null); return null; }

  const s = sun(exif.latitude, exif.longitude, exif.taken_at);
  const [leftAz, rightAz] = rainbowFootBearings(s.elevation, s.azimuth);

  const [weather, lf, rf] = await Promise.all([
    fetchWeather(exif.latitude, exif.longitude, exif.taken_at),
    traceFoot(exif.latitude, exif.longitude, exif.altitude_m, leftAz),
    traceFoot(exif.latitude, exif.longitude, exif.altitude_m, rightAz),
  ]);

  const result = { exif, sun: s, weather, leftFoot: lf, rightFoot: rf };
  cache.set(filename, result);
  return result;
}

// ── map rendering ───────────────────────────────────────

let minimap = null;
let mapLayer = null;

function initMap() {
  if (minimap) return;
  minimap = L.map('minimap', { zoomControl: false }).setView([53.387, -1.498], 14);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '\u00a9 CARTO \u00a9 OSM', subdomains: 'abcd', maxZoom: 19,
  }).addTo(minimap);
}

function renderMap(data) {
  initMap();
  if (mapLayer) { minimap.removeLayer(mapLayer); mapLayer = null; }
  if (!data) return;

  const g = L.featureGroup();
  const { exif, sun: s, leftFoot: lf, rightFoot: rf } = data;
  const lat = exif.latitude, lon = exif.longitude;

  // observer dot
  const icon = L.divIcon({ className: '', html: '<div class="dot"></div>', iconSize: [10, 10], iconAnchor: [5, 5] });
  L.marker([lat, lon], { icon }).addTo(g);

  // camera fov
  if (exif.camera_bearing) {
    const b = exif.camera_bearing, pts = [[lat, lon]];
    for (let a = -33; a <= 33; a += 3) pts.push(offset(lat, lon, b + a, 0.0018));
    pts.push([lat, lon]);
    L.polygon(pts, { color: '#1a1a1a', weight: 0.5, opacity: 0.3, fillColor: '#1a1a1a', fillOpacity: 0.06 }).addTo(g);
  }

  // sun line
  const [sLat, sLon] = offset(lat, lon, s.azimuth, 0.0014);
  L.polyline([[lat, lon], [sLat, sLon]], { color: '#1a1a1a', weight: 1.5, opacity: 0.5 }).addTo(g);
  L.circleMarker([sLat, sLon], { radius: 3, fillColor: '#1a1a1a', fillOpacity: 0.5, stroke: false }).addTo(g);

  // wind arrow
  if (data.weather?.wind_direction_deg) {
    const [wLat, wLon] = offset(lat, lon, data.weather.wind_direction_deg, 0.0011);
    L.polyline([[wLat, wLon], [lat, lon]], { color: '#1a1a1a', weight: 1, opacity: 0.25, dashArray: '3 4' }).addTo(g);
  }

  // rainbow arc
  if (lf && rf) {
    const lfp = [lf.lat, lf.lon], rfp = [rf.lat, rf.lon];
    const mid = [(lfp[0]+rfp[0])/2, (lfp[1]+rfp[1])/2];
    const chord = Math.hypot((lfp[0]-rfp[0])*111000, (lfp[1]-rfp[1])*111000*Math.cos(lat*R));
    const bulge = chord * 0.3 / 111000;
    const cpLat = mid[0] + bulge * Math.cos(s.antiSolarAz * R);
    const cpLon = mid[1] + bulge * Math.sin(s.antiSolarAz * R) / Math.cos(lat * R);

    SPECTRUM.forEach((color, ci) => {
      const off = ci * 0.0003;
      const cp = [cpLat + off*Math.cos(s.antiSolarAz*R), cpLon + off*Math.sin(s.antiSolarAz*R)/Math.cos(lat*R)];
      const pts = [];
      for (let t = 0; t <= 1; t += 0.02) {
        const u = 1 - t;
        pts.push([u*u*lfp[0]+2*u*t*cp[0]+t*t*rfp[0], u*u*lfp[1]+2*u*t*cp[1]+t*t*rfp[1]]);
      }
      L.polyline(pts, { color, weight: 2.5, opacity: 0.4, lineCap: 'round' }).addTo(g);
    });

    // gold markers
    const gi = label => L.divIcon({ className: '', html: `<div class="gold" title="${label}">\uD83D\uDCB0</div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
    [[lf, 'left'], [rf, 'right']].forEach(([foot, side]) => {
      L.marker([foot.lat, foot.lon], { icon: gi(side) })
        .bindTooltip(`${foot.dist}m, ${Math.round(foot.alt)}m elev`).addTo(g);
      L.polyline([[lat, lon], [foot.lat, foot.lon]], { color: '#d4a017', weight: 0.8, opacity: 0.3, dashArray: '4 6' }).addTo(g);
    });
  }

  mapLayer = g;
  g.addTo(minimap);
  minimap.fitBounds(g.getBounds(), { padding: [30, 30], maxZoom: 15 });
}

// ── detail view ─────────────────────────────────────────

const detail = document.getElementById('detail');
const detailImg = document.getElementById('detail-img');
const meta = document.getElementById('meta');
let currentFilename = null;

function showDetail(filename) {
  currentFilename = filename;
  const src = 'photos/web/' + filename;
  detailImg.src = src;
  detail.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('detail-head').textContent = '';
  meta.innerHTML = '<div class="loading"><span class="spinner"></span>reading exif &amp; fetching data\u2026</div>';

  // update url hash without triggering hashchange
  history.replaceState(null, '', '#' + encodeURIComponent(filename));

  // clear map
  renderMap(null);
  initMap();
  setTimeout(() => minimap.invalidateSize(), 50);

  computeAll(filename).then(data => {
    if (!data) {
      meta.innerHTML = '<div class="loading">no gps data in this photo</div>';
      return;
    }
    renderMeta(data);
    renderMap(data);
  }).catch(() => {
    meta.innerHTML = '<div class="loading">failed to load data</div>';
  });
}

function renderMeta(data) {
  const { exif, sun: s, weather: w } = data;
  const dt = exif.taken_at;
  const date = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = dt.toISOString().slice(11, 16);
  const bearing = exif.camera_bearing;
  const facing = bearing ? `${bearing.toFixed(0)}\u00b0 ${compass(bearing)}` : '\u2014';
  const rbPeak = Math.max(0, 42 - s.elevation).toFixed(0);

  document.getElementById('detail-head').textContent = `${date} \u00b7 ${time} utc`;
  let html = '';
  const rows = [
    ['facing', facing],
    ['altitude', `${Math.round(exif.altitude_m)}m`],
    ['sun', `${s.elevation.toFixed(1)}\u00b0 el \u00b7 ${s.azimuth.toFixed(0)}\u00b0 az`],
    ['rainbow', `${s.antiSolarAz.toFixed(0)}\u00b0 az \u00b7 ${rbPeak}\u00b0 peak`],
  ];
  if (w) {
    rows.push(
      ['temp', `${w.temperature_c}\u00b0c`],
      ['humidity', `${w.relative_humidity}%`],
      ['wind', `${w.wind_speed_kmh} km/h ${compass(w.wind_direction_deg)}`],
      ['precip', `${w.precipitation_mm} mm`],
    );
  }
  rows.forEach(([k, v]) => { html += `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`; });
  if (data.leftFoot && data.rightFoot) {
    html += `<div class="row"><span class="k">left foot</span><span class="v">${data.leftFoot.dist}m \u00b7 ${Math.round(data.leftFoot.alt)}m elev</span></div>`;
    html += `<div class="row"><span class="k">right foot</span><span class="v">${data.rightFoot.dist}m \u00b7 ${Math.round(data.rightFoot.alt)}m elev</span></div>`;
  }
  meta.innerHTML = html;
}

function hideDetail() {
  detail.classList.add('hidden');
  document.body.style.overflow = '';
  currentFilename = null;
  history.replaceState(null, '', location.pathname + location.search);
}

document.getElementById('close').addEventListener('click', hideDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideDetail(); });

// ── copy link button ────────────────────────────────────

document.getElementById('copy-link').addEventListener('click', () => {
  if (!currentFilename) return;
  const url = location.origin + location.pathname + '#' + encodeURIComponent(currentFilename);
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copy-link');
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  });
});

// ── deep link handling ──────────────────────────────────

function openFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!hash) return;
  if (PHOTOS.includes(hash)) {
    showDetail(hash);
  }
}

window.addEventListener('hashchange', openFromHash);

// ── gallery ─────────────────────────────────────────────

const gallery = document.getElementById('gallery');
PHOTOS.forEach(filename => {
  const img = document.createElement('img');
  img.src = 'photos/thumb/' + filename;
  img.loading = 'lazy';
  img.alt = filename;
  img.addEventListener('click', () => showDetail(filename));
  gallery.appendChild(img);
});

// ── init ────────────────────────────────────────────────

// open deep link on page load (after gallery is built)
openFromHash();
