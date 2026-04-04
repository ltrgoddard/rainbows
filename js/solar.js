export function solarPosition(lat, lon, date) {
  const rad = Math.PI / 180;
  const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5);
  const decl = 23.45 * Math.sin(rad * (360 / 365) * (doy - 81));
  const eot =
    9.87 * Math.sin(2 * rad * (360 / 365) * (doy - 81)) -
    7.53 * Math.cos(rad * (360 / 365) * (doy - 81)) -
    1.5 * Math.sin(rad * (360 / 365) * (doy - 81));
  const solarNoon = 12 - lon / 15 - eot / 60;
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const ha = 15 * (utcH - solarNoon);
  const sinE =
    Math.sin(lat * rad) * Math.sin(decl * rad) +
    Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad);
  const elevation = Math.asin(sinE) / rad;
  const cosAz =
    (Math.sin(decl * rad) - Math.sin(lat * rad) * sinE) /
    (Math.cos(lat * rad) * Math.cos(Math.asin(sinE)));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
  if (ha > 0) azimuth = 360 - azimuth;
  return { elevation, azimuth, antiSolarAz: (azimuth + 180) % 360 };
}

export const compassDir = (d) =>
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];

export const weatherLabels = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers', 95: 'Thunderstorm',
};

export function webFilename(f) {
  return 'photos_web/' + f.replace('.HEIC', '.jpg');
}

export function groupSessions(photos) {
  const m = {};
  photos.forEach((p) => {
    const d = p.taken_at.split(' ')[0];
    (m[d] || (m[d] = [])).push(p);
  });
  return Object.entries(m)
    .map(([date, items]) => {
      const f = items[0];
      const dt = new Date(f.taken_at.replace(' ', 'T') + 'Z');
      return { date, items, sun: solarPosition(f.latitude, f.longitude, dt), weather: f };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
