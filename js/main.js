import { groupSessions } from './solar.js';
import { initMap, buildSessionLayers } from './map.js';
import { buildSessionCards } from './cards.js';

fetch('data/rainbow_data.json')
  .then((r) => r.json())
  .then((photos) => {
    const sessions = groupSessions(photos);

    const dates = sessions.map((s) => s.date);
    document.getElementById('subtitle').textContent =
      photos.length + ' photos \u00b7 ' + sessions.length + ' sessions \u00b7 Sheffield \u00b7 ' +
      dates[0].slice(0, 4) + '\u2013' + dates.at(-1).slice(0, 4);

    const map = initMap();
    const sessionLayers = buildSessionLayers(sessions);
    buildSessionCards(sessions, map, sessionLayers);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('open');
    });
  });
