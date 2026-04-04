import { weatherLabels, webFilename, compassDir } from './solar.js';

export function buildSessionCards(sessions, map, sessionLayers) {
  const container = document.getElementById('sessions');

  sessions.forEach((s, si) => {
    const dt = new Date(s.items[0].taken_at.replace(' ', 'T') + 'Z');
    const dateStr = dt.toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
    const times = s.items.map((p) => p.taken_at.split(' ')[1].slice(0, 5));
    const timeRange = times.length === 1 ? times[0] : times[0] + '\u2013' + times.at(-1);

    const withBearing = s.items.filter((p) => p.camera_bearing);
    const facingStr = withBearing.length
      ? (() => { const b = withBearing.reduce((a, p) => a + p.camera_bearing, 0) / withBearing.length; return b.toFixed(0) + '\u00b0 ' + compassDir(b); })()
      : '?';

    const card = document.createElement('div');
    card.className = 'session';
    if (si === 0) card.classList.add('active');
    card.innerHTML = `
      <div class="session-head">
        <span class="session-date">${dateStr}</span>
        <span class="session-meta">${s.items.length} &middot; ${timeRange}</span>
      </div>
      <div class="session-grid">
        <div><span class="mk">Temp</span></div><div class="mv">${s.weather.temperature_c}\u00b0C</div>
        <div><span class="mk">Humidity</span></div><div class="mv">${s.weather.relative_humidity}%</div>
        <div><span class="mk">Wind</span></div><div class="mv">${s.weather.wind_speed_kmh} km/h ${compassDir(s.weather.wind_direction_deg)}</div>
        <div><span class="mk">Precip</span></div><div class="mv">${s.weather.precipitation_mm} mm</div>
        <div><span class="mk">Facing</span></div><div class="mv">${facingStr}</div>
        <div><span class="mk">Altitude</span></div><div class="mv">${Math.round(s.items[0].altitude_m || 0)}m</div>
        <div><span class="mk">Sun</span></div><div class="mv">${s.sun.elevation.toFixed(1)}\u00b0 el &middot; ${s.sun.azimuth.toFixed(0)}\u00b0 az</div>
        <div><span class="mk">Rainbow</span></div><div class="mv">${s.sun.antiSolarAz.toFixed(0)}\u00b0 az &middot; ${Math.max(0, 42 - s.sun.elevation).toFixed(0)}\u00b0 peak</div>
      </div>
      <span class="tag">${weatherLabels[s.weather.weather_code] || 'WMO ' + s.weather.weather_code}</span>
      <div class="photo-strip">
        ${s.items.map((p) => `<img src="${webFilename(p.filename)}" alt="${p.filename}" data-file="${p.filename}" loading="lazy">`).join('')}
      </div>`;

    card.addEventListener('click', (e) => {
      // If they clicked a photo thumbnail, open lightbox instead
      if (e.target.tagName === 'IMG' && e.target.closest('.photo-strip')) {
        document.getElementById('lb-img').src = e.target.src;
        document.getElementById('lb-caption').textContent = e.target.dataset.file;
        document.getElementById('lightbox').classList.add('open');
        return;
      }
      document.querySelectorAll('.session').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      showSession(map, sessionLayers, si);
    });

    container.appendChild(card);
  });

  // Show first session by default
  showSession(map, sessionLayers, 0);
}

function showSession(map, sessionLayers, index) {
  sessionLayers.forEach((layer, i) => {
    if (i === index) {
      map.addLayer(layer);
      map.fitBounds(layer.getBounds(), { padding: [60, 60, 60, 60], maxZoom: 16 });
    } else {
      map.removeLayer(layer);
    }
  });
}
