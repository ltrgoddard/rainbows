import { weatherLabels, webFilename } from './solar.js';

const RAD = Math.PI / 180;

export function initMap() {
  const map = L.map('map', { zoomControl: false }).setView([53.387, -1.498], 14);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO &copy; OSM',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  return map;
}

export function buildSessionLayers(sessions) {
  return sessions.map((s, si) => {
    const group = L.featureGroup();
    const avgLat = s.items.reduce((a, p) => a + p.latitude, 0) / s.items.length;
    const avgLon = s.items.reduce((a, p) => a + p.longitude, 0) / s.items.length;

    addSessionMarker(group, s, si, avgLat, avgLon);
    addCameraViewCone(group, s, avgLat, avgLon);
    addSunLine(group, s, avgLat, avgLon);
    addWindArrow(group, s, avgLat, avgLon);
    addRainbowArc(group, s, avgLat, avgLon);
    addPhotoDots(group, s);
    addPotOfGold(group, s, avgLat, avgLon);

    return group;
  });
}

function addSessionMarker(map, s, si, avgLat, avgLon) {
  const icon = L.divIcon({
    className: '',
    html: `<div style="
      width:22px;height:22px;border-radius:50%;
      background:#fff;border:1.5px solid #1a1a1a;
      display:flex;align-items:center;justify-content:center;
      font:500 10px/1 'IBM Plex Sans',sans-serif;color:#1a1a1a;
      box-shadow:0 1px 4px rgba(0,0,0,0.1);
    ">${si + 1}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

  const dt = new Date(s.items[0].taken_at.replace(' ', 'T') + 'Z');
  const dateStr = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const thumb = webFilename(s.items[0].filename);

  const avgBearing = avgCameraBearing(s);
  const facingStr = isNaN(avgBearing) ? '?' : avgBearing.toFixed(0) + '°';

  const popup = `
    <div style="min-width:200px">
      <img src="${thumb}" style="width:100%;border-radius:4px;margin-bottom:8px;" onerror="this.style.display='none'">
      <div style="font-weight:500;font-size:12px;margin-bottom:6px;">${dateStr}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:10px;">
        <span style="color:#888">Temp</span><span style="text-align:right">${s.weather.temperature_c}&deg;C</span>
        <span style="color:#888">Humidity</span><span style="text-align:right">${s.weather.relative_humidity}%</span>
        <span style="color:#888">Wind</span><span style="text-align:right">${s.weather.wind_speed_kmh} km/h</span>
        <span style="color:#888">Facing</span><span style="text-align:right">${facingStr}</span>
        <span style="color:#888">Sun</span><span style="text-align:right">${s.sun.elevation.toFixed(1)}&deg; el, ${s.sun.azimuth.toFixed(0)}&deg; az</span>
        <span style="color:#888">Altitude</span><span style="text-align:right">${Math.round(s.items[0].altitude_m || 0)}m</span>
      </div>
      <div style="margin-top:6px;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.06em">
        ${weatherLabels[s.weather.weather_code]} &middot; ${s.items.length} photo${s.items.length > 1 ? 's' : ''}
      </div>
    </div>`;

  L.marker([avgLat, avgLon], { icon }).bindPopup(popup, { maxWidth: 280 }).addTo(map);
}

function avgCameraBearing(s) {
  const withBearing = s.items.filter((p) => p.camera_bearing);
  if (!withBearing.length) return NaN;
  return withBearing.reduce((a, p) => a + p.camera_bearing, 0) / withBearing.length;
}

function addCameraViewCone(map, s, avgLat, avgLon) {
  const avgBearing = avgCameraBearing(s);
  if (isNaN(avgBearing)) return;

  const coneR = 0.0018;
  const coneHalf = 33; // ~65° horizontal FOV for 28mm equivalent
  const pts = [[avgLat, avgLon]];
  for (let a = -coneHalf; a <= coneHalf; a += 2) {
    const ang = avgBearing + a;
    pts.push([
      avgLat + coneR * Math.cos(ang * RAD),
      avgLon + (coneR * Math.sin(ang * RAD)) / Math.cos(avgLat * RAD),
    ]);
  }
  pts.push([avgLat, avgLon]);

  L.polygon(pts, {
    color: '#1a1a1a', weight: 0.5, opacity: 0.3,
    fillColor: '#1a1a1a', fillOpacity: 0.06,
  })
    .bindTooltip(`Camera facing ${avgBearing.toFixed(0)}°`, { permanent: false })
    .addTo(map);
}

function addSunLine(map, s, avgLat, avgLon) {
  const len = 0.0014;
  const sunA = s.sun.azimuth;
  const sLat = avgLat + len * Math.cos(sunA * RAD);
  const sLon = avgLon + (len * Math.sin(sunA * RAD)) / Math.cos(avgLat * RAD);

  L.polyline([[avgLat, avgLon], [sLat, sLon]], {
    color: '#1a1a1a', weight: 1.5, opacity: 0.5,
  })
    .bindTooltip(`Sun ${sunA.toFixed(0)}°`, { permanent: false })
    .addTo(map);

  L.circleMarker([sLat, sLon], {
    radius: 3.5, fillColor: '#1a1a1a', fillOpacity: 0.5, stroke: false,
  }).addTo(map);
}

function addWindArrow(map, s, avgLat, avgLon) {
  const wLen = 0.0011;
  const wA = s.weather.wind_direction_deg;
  const wLat = avgLat + wLen * Math.cos(wA * RAD);
  const wLon = avgLon + (wLen * Math.sin(wA * RAD)) / Math.cos(avgLat * RAD);

  L.polyline([[wLat, wLon], [avgLat, avgLon]], {
    color: '#1a1a1a', weight: 1, opacity: 0.25, dashArray: '3 4',
  })
    .bindTooltip(`Wind from ${wA.toFixed(0)}°`, { permanent: false })
    .addTo(map);
}

function addRainbowArc(group, s, avgLat, avgLon) {
  const rep = s.items[0];
  const colors = ['#ff0000', '#ff6600', '#ffcc00', '#33cc33', '#0099ff', '#4400cc', '#8800aa'];

  if (rep.left_foot_lat && rep.right_foot_lat) {
    // Draw a curved arc from left foot to right foot.
    // The control point bulges outward from the observer along the antisolar azimuth.
    const lft = [rep.left_foot_lat, rep.left_foot_lon];
    const rft = [rep.right_foot_lat, rep.right_foot_lon];
    const mid = [(lft[0] + rft[0]) / 2, (lft[1] + rft[1]) / 2];

    // Bulge the midpoint away from observer along the antisolar direction
    const antiAz = s.sun.antiSolarAz;
    const chordLen = Math.sqrt(
      Math.pow((lft[0] - rft[0]) * 111000, 2) +
      Math.pow((lft[1] - rft[1]) * 111000 * Math.cos(avgLat * RAD), 2)
    );
    const bulge = chordLen * 0.3 / 111000; // 30% of chord length, in degrees

    const cpLat = mid[0] + bulge * Math.cos(antiAz * RAD);
    const cpLon = mid[1] + (bulge * Math.sin(antiAz * RAD)) / Math.cos(avgLat * RAD);

    colors.forEach((color, ci) => {
      // Offset each band slightly outward from observer
      const offset = ci * 0.0003;
      const cp = [
        cpLat + offset * Math.cos(antiAz * RAD),
        cpLon + (offset * Math.sin(antiAz * RAD)) / Math.cos(avgLat * RAD),
      ];

      // Quadratic bezier: P(t) = (1-t)²·A + 2(1-t)t·CP + t²·B
      const pts = [];
      for (let t = 0; t <= 1; t += 0.02) {
        const u = 1 - t;
        pts.push([
          u * u * lft[0] + 2 * u * t * cp[0] + t * t * rft[0],
          u * u * lft[1] + 2 * u * t * cp[1] + t * t * rft[1],
        ]);
      }
      L.polyline(pts, {
        color, weight: 2.5, opacity: 0.4, lineCap: 'round', lineJoin: 'round',
      }).addTo(group);
    });
  }
}

function addPhotoDots(map, s) {
  s.items.forEach((p) => {
    L.circleMarker([p.latitude, p.longitude], {
      radius: 2, fillColor: '#1a1a1a', fillOpacity: 0.25, stroke: false,
    }).addTo(map);
  });
}

function addPotOfGold(map, s, avgLat, avgLon) {
  const rep = s.items[0];
  if (!rep.left_foot_lat || !rep.right_foot_lat) return;

  const goldIcon = (label) =>
    L.divIcon({
      className: '',
      html: `<div style="font-size:16px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.2));cursor:help;" title="${label}">\uD83D\uDCB0</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

  const ld = rep.left_foot_dist_m, rd = rep.right_foot_dist_m;

  L.marker([rep.left_foot_lat, rep.left_foot_lon], { icon: goldIcon(`Left foot: ${ld}m`) })
    .bindTooltip(`Left foot: ${ld}m, ${Math.round(rep.left_foot_alt_m)}m elev`, { permanent: false })
    .addTo(map);

  L.marker([rep.right_foot_lat, rep.right_foot_lon], { icon: goldIcon(`Right foot: ${rd}m`) })
    .bindTooltip(`Right foot: ${rd}m, ${Math.round(rep.right_foot_alt_m)}m elev`, { permanent: false })
    .addTo(map);

  [[rep.left_foot_lat, rep.left_foot_lon], [rep.right_foot_lat, rep.right_foot_lon]].forEach((foot) => {
    L.polyline([[avgLat, avgLon], foot], {
      color: '#d4a017', weight: 0.8, opacity: 0.3, dashArray: '4 6',
    }).addTo(map);
  });
}
