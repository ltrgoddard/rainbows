const R = Math.PI / 180;
const compass = d => ['n','ne','e','se','s','sw','w','nw'][Math.round(d / 45) % 8];
const jpg = f => 'photos_web/' + f.replace('.HEIC', '.jpg');

const WEATHER = {
  0:'clear', 1:'mainly clear', 2:'partly cloudy', 3:'overcast',
  45:'fog', 51:'light drizzle', 53:'moderate drizzle', 55:'dense drizzle',
  61:'slight rain', 63:'moderate rain', 65:'heavy rain',
  80:'slight showers', 81:'moderate showers', 82:'violent showers', 95:'thunderstorm',
};

const SPECTRUM = ['#e44','#e82','#ec3','#3b3','#39f','#44c','#80a'];

// solar position → {elevation, azimuth, antiSolarAz}
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

// offset a point by bearing (deg) and distance (deg of latitude)
function offset(lat, lon, bearing, dist) {
  return [lat + dist * Math.cos(bearing * R), lon + dist * Math.sin(bearing * R) / Math.cos(lat * R)];
}

// group photos into sessions by date
function sessions(photos) {
  const m = {};
  photos.forEach(p => (m[p.taken_at.split(' ')[0]] ??= []).push(p));
  return Object.entries(m).map(([date, items]) => {
    const f = items[0];
    return { date, items, sun: sun(f.latitude, f.longitude, new Date(f.taken_at.replace(' ','T')+'Z')), weather: f };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

// average camera bearing for a session
function avgBearing(s) {
  const bs = s.items.filter(p => p.camera_bearing);
  return bs.length ? bs.reduce((a, p) => a + p.camera_bearing, 0) / bs.length : NaN;
}

// ── map layer for one session ───────────────────────────

function sessionLayer(s, map, activateCard) {
  const g = L.featureGroup();
  const lat = s.items.reduce((a, p) => a + p.latitude, 0) / s.items.length;
  const lon = s.items.reduce((a, p) => a + p.longitude, 0) / s.items.length;
  const rep = s.items[0];

  // marker
  const icon = L.divIcon({ className: '', html: '<div class="dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  L.marker([lat, lon], { icon }).on('click', activateCard).addTo(g);

  // camera FOV cone
  const b = avgBearing(s);
  if (!isNaN(b)) {
    const pts = [[lat, lon]];
    for (let a = -33; a <= 33; a += 3) pts.push(offset(lat, lon, b + a, 0.0018));
    pts.push([lat, lon]);
    L.polygon(pts, { color: '#1a1a1a', weight: 0.5, opacity: 0.3, fillColor: '#1a1a1a', fillOpacity: 0.06 }).addTo(g);
  }

  // sun line
  const [sLat, sLon] = offset(lat, lon, s.sun.azimuth, 0.0014);
  L.polyline([[lat, lon], [sLat, sLon]], { color: '#1a1a1a', weight: 1.5, opacity: 0.5 }).addTo(g);
  L.circleMarker([sLat, sLon], { radius: 3, fillColor: '#1a1a1a', fillOpacity: 0.5, stroke: false }).addTo(g);

  // wind arrow
  const [wLat, wLon] = offset(lat, lon, s.weather.wind_direction_deg, 0.0011);
  L.polyline([[wLat, wLon], [lat, lon]], { color: '#1a1a1a', weight: 1, opacity: 0.25, dashArray: '3 4' }).addTo(g);

  // photo dots
  s.items.forEach(p => L.circleMarker([p.latitude, p.longitude], { radius: 2, fillColor: '#1a1a1a', fillOpacity: 0.25, stroke: false }).addTo(g));

  // rainbow arc + pot of gold
  if (rep.left_foot_lat && rep.right_foot_lat) {
    const lf = [rep.left_foot_lat, rep.left_foot_lon];
    const rf = [rep.right_foot_lat, rep.right_foot_lon];
    const mid = [(lf[0]+rf[0])/2, (lf[1]+rf[1])/2];
    const chord = Math.hypot((lf[0]-rf[0])*111000, (lf[1]-rf[1])*111000*Math.cos(lat*R));
    const bulge = chord * 0.3 / 111000;
    const cpLat = mid[0] + bulge * Math.cos(s.sun.antiSolarAz * R);
    const cpLon = mid[1] + bulge * Math.sin(s.sun.antiSolarAz * R) / Math.cos(lat * R);

    SPECTRUM.forEach((color, ci) => {
      const off = ci * 0.0003;
      const cp = [cpLat + off * Math.cos(s.sun.antiSolarAz*R), cpLon + off * Math.sin(s.sun.antiSolarAz*R) / Math.cos(lat*R)];
      const pts = [];
      for (let t = 0; t <= 1; t += 0.02) {
        const u = 1 - t;
        pts.push([u*u*lf[0] + 2*u*t*cp[0] + t*t*rf[0], u*u*lf[1] + 2*u*t*cp[1] + t*t*rf[1]]);
      }
      L.polyline(pts, { color, weight: 2.5, opacity: 0.4, lineCap: 'round' }).addTo(g);
    });

    // gold markers
    const gi = label => L.divIcon({ className: '', html: `<div class="gold" title="${label}">\uD83D\uDCB0</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
    [['left', lf, rep.left_foot_dist_m, rep.left_foot_alt_m],
     ['right', rf, rep.right_foot_dist_m, rep.right_foot_alt_m]].forEach(([side, pos, dist, alt]) => {
      L.marker(pos, { icon: gi(`${side}: ${dist}m`) }).bindTooltip(`${dist}m, ${Math.round(alt)}m elev`).addTo(g);
      L.polyline([[lat, lon], pos], { color: '#d4a017', weight: 0.8, opacity: 0.3, dashArray: '4 6' }).addTo(g);
    });
  }

  return g;
}

// ── session card ────────────────────────────────────────

function card(s) {
  const dt = new Date(s.items[0].taken_at.replace(' ','T')+'Z');
  const date = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const times = s.items.map(p => p.taken_at.split(' ')[1].slice(0, 5));
  const time = times.length === 1 ? times[0] : times[0] + '\u2013' + times.at(-1);
  const b = avgBearing(s);
  const facing = isNaN(b) ? '?' : `${b.toFixed(0)}\u00b0 ${compass(b)}`;
  const w = s.weather;

  const el = document.createElement('div');
  el.className = 'session';
  el.innerHTML = `
    <div class="head"><span class="date">${date}</span><span class="meta">${s.items.length} \u00b7 ${time}</span></div>
    <div class="grid">
      <span class="k">temp</span><span class="v">${w.temperature_c}\u00b0c</span>
      <span class="k">humidity</span><span class="v">${w.relative_humidity}%</span>
      <span class="k">wind</span><span class="v">${w.wind_speed_kmh} km/h ${compass(w.wind_direction_deg)}</span>
      <span class="k">precip</span><span class="v">${w.precipitation_mm} mm</span>
      <span class="k">facing</span><span class="v">${facing}</span>
      <span class="k">altitude</span><span class="v">${Math.round(s.items[0].altitude_m || 0)}m</span>
      <span class="k">sun</span><span class="v">${s.sun.elevation.toFixed(1)}\u00b0 el \u00b7 ${s.sun.azimuth.toFixed(0)}\u00b0 az</span>
      <span class="k">rainbow</span><span class="v">${s.sun.antiSolarAz.toFixed(0)}\u00b0 az \u00b7 ${Math.max(0, 42 - s.sun.elevation).toFixed(0)}\u00b0 peak</span>
    </div>
    <span class="tag">${WEATHER[w.weather_code] || 'wmo ' + w.weather_code}</span>
    <div class="photos">${s.items.map(p => `<img src="${jpg(p.filename)}" data-file="${p.filename}" loading="lazy">`).join('')}</div>`;
  return el;
}

// ── init ────────────────────────────────────────────────

fetch('data/rainbow_data.json').then(r => r.json()).then(photos => {
  const ss = sessions(photos);

  // subtitle
  const dates = ss.map(s => s.date);
  document.getElementById('sub').textContent =
    `${photos.length} photos \u00b7 ${ss.length} sessions \u00b7 sheffield \u00b7 ${dates.at(-1).slice(0,4)}\u2013${dates[0].slice(0,4)}`;

  // map
  const map = L.map('map', { zoomControl: false }).setView([53.387, -1.498], 14);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '\u00a9 CARTO \u00a9 OSM', subdomains: 'abcd', maxZoom: 19
  }).addTo(map);

  // build layers + cards
  const container = document.getElementById('sessions');
  const layers = [];
  const cards = [];

  function show(i) {
    layers.forEach((l, j) => j === i ? map.addLayer(l) : map.removeLayer(l));
    cards.forEach((c, j) => c.classList.toggle('active', j === i));
    map.fitBounds(layers[i].getBounds(), { padding: [60, 60, 60, 60], maxZoom: 16 });
  }

  ss.forEach((s, i) => {
    const c = card(s);
    const l = sessionLayer(s, map, () => show(i));
    layers.push(l);
    cards.push(c);
    c.addEventListener('click', e => {
      if (e.target.tagName === 'IMG' && e.target.closest('.photos')) {
        document.getElementById('lb-img').src = e.target.src;
        document.getElementById('lb-cap').textContent = e.target.dataset.file;
        document.getElementById('lb').classList.add('open');
        return;
      }
      show(i);
    });
    container.appendChild(c);
  });

  show(0);

  // lightbox
  document.getElementById('lb').addEventListener('click', e => e.currentTarget.classList.remove('open'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('lb').classList.remove('open'); });
});
