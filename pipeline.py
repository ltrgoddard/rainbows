"""Rainbow photo analysis pipeline.

Extracts EXIF metadata, fetches historical weather, computes solar geometry
and rainbow-foot terrain intersections, loads everything into DuckDB, and
generates the map visualisation.

Usage:
    uv run python pipeline.py          # run full pipeline
    uv run python pipeline.py --skip-export   # skip Photos export (photos already in ./photos)
    uv run python pipeline.py --skip-weather  # skip weather API calls (reuse data/)
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import httpx

ROOT = Path(__file__).parent
PHOTOS_DIR = ROOT / "photos" / "raw"
WEB_DIR = ROOT / "photos" / "web"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "rainbows.duckdb"

RAINBOW_ANGLE = 42.0
EARTH_R = 6_371_000


# ── Helpers ──────────────────────────────────────────────────────────────────


def run(cmd: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


# ── 1. EXIF extraction ──────────────────────────────────────────────────────


def extract_metadata() -> list[dict]:
    """Read EXIF from every photo in photos/ via exiftool."""
    photos = sorted(PHOTOS_DIR.glob("*.HEIC")) + sorted(PHOTOS_DIR.glob("*.heic"))
    if not photos:
        sys.exit("No photos found in photos/")

    result = run(
        "exiftool -s -s -s -n -csv "
        "-DateTimeOriginal -OffsetTimeOriginal "
        "-GPSLatitude -GPSLongitude -GPSAltitude -GPSImgDirection "
        + " ".join(f'"{p}"' for p in photos)
    )
    rows = list(csv.DictReader(result.stdout.strip().splitlines()))

    out = []
    for r in rows:
        dt_raw = r.get("DateTimeOriginal", "")
        if not dt_raw:
            continue
        # "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DD HH:MM:SS"
        dt_iso = dt_raw[:4] + "-" + dt_raw[5:7] + "-" + dt_raw[8:10] + dt_raw[10:]

        # Convert local time to UTC using OffsetTimeOriginal (e.g. "+01:00", "Z")
        offset_str = r.get("OffsetTimeOriginal", "").strip()
        offset_hours = 0
        if offset_str and offset_str != "Z":
            try:
                sign = -1 if offset_str.startswith("-") else 1
                parts = offset_str.lstrip("+-").split(":")
                offset_hours = sign * (int(parts[0]) + int(parts[1]) / 60)
            except (ValueError, IndexError):
                pass

        dt_local = datetime.strptime(dt_iso, "%Y-%m-%d %H:%M:%S")
        dt_utc = dt_local - timedelta(hours=offset_hours)
        dt_utc_str = dt_utc.strftime("%Y-%m-%d %H:%M:%S")

        out.append({
            "filename": Path(r["SourceFile"]).name,
            "datetime_utc": dt_utc_str,
            "latitude": float(r["GPSLatitude"]) if r.get("GPSLatitude") else None,
            "longitude": float(r["GPSLongitude"]) if r.get("GPSLongitude") else None,
            "altitude_m": float(r["GPSAltitude"]) if r.get("GPSAltitude") else None,
            "camera_bearing": float(r["GPSImgDirection"]) if r.get("GPSImgDirection") else None,
        })
    return out


# ── 2. Weather ───────────────────────────────────────────────────────────────


def fetch_weather(photos: list[dict]) -> list[dict]:
    """Fetch hourly weather from Open-Meteo for each photo."""
    results = []
    with httpx.Client(timeout=15) as client:
        for p in photos:
            if not p["latitude"] or not p["longitude"]:
                continue
            date = p["datetime_utc"][:10]
            hour = int(p["datetime_utc"][11:13])

            params = {
                "latitude": p["latitude"],
                "longitude": p["longitude"],
                "start_date": date,
                "end_date": date,
                "hourly": "temperature_2m,relative_humidity_2m,precipitation,"
                          "cloud_cover,wind_speed_10m,wind_direction_10m,"
                          "weather_code,surface_pressure",
            }
            # Try archive first, fall back to forecast for recent dates
            for base in ("https://archive-api.open-meteo.com/v1/archive",
                         "https://api.open-meteo.com/v1/forecast"):
                resp = client.get(base, params=params).json()
                if "error" not in resp:
                    break

            h = resp.get("hourly", {})
            get = lambda key: (h.get(key) or [None] * 24)[hour]  # noqa: E731

            results.append({
                "filename": p["filename"],
                "temperature_c": get("temperature_2m"),
                "relative_humidity": get("relative_humidity_2m"),
                "precipitation_mm": get("precipitation"),
                "cloud_cover_pct": get("cloud_cover"),
                "wind_speed_kmh": get("wind_speed_10m"),
                "wind_direction_deg": get("wind_direction_10m"),
                "weather_code": get("weather_code"),
                "surface_pressure_hpa": get("surface_pressure"),
            })
            print(f"  weather: {p['filename']} → {get('temperature_2m')}°C, "
                  f"{get('relative_humidity_2m')}% RH, {get('precipitation')}mm")
            time.sleep(0.2)
    return results


# ── 3. Solar geometry ────────────────────────────────────────────────────────


def solar_position(lat: float, lon: float, dt: datetime) -> tuple[float, float]:
    """Return (elevation_deg, azimuth_deg)."""
    doy = dt.timetuple().tm_yday
    decl = 23.45 * math.sin(math.radians(360 / 365 * (doy - 81)))
    eot = (9.87 * math.sin(2 * math.radians(360 / 365 * (doy - 81)))
           - 7.53 * math.cos(math.radians(360 / 365 * (doy - 81)))
           - 1.5 * math.sin(math.radians(360 / 365 * (doy - 81))))
    solar_noon = 12 - lon / 15 - eot / 60
    utc_h = dt.hour + dt.minute / 60 + dt.second / 3600
    ha = 15 * (utc_h - solar_noon)

    sin_e = (math.sin(math.radians(lat)) * math.sin(math.radians(decl))
             + math.cos(math.radians(lat)) * math.cos(math.radians(decl))
             * math.cos(math.radians(ha)))
    elev = math.degrees(math.asin(max(-1, min(1, sin_e))))

    cos_az = ((math.sin(math.radians(decl)) - math.sin(math.radians(lat)) * sin_e)
              / (math.cos(math.radians(lat)) * math.cos(math.asin(max(-1, min(1, sin_e))))))
    az = math.degrees(math.acos(max(-1, min(1, cos_az))))
    if ha > 0:
        az = 360 - az
    return elev, az


def rainbow_foot_bearings(sun_el: float, sun_az: float) -> tuple[float, float]:
    """Horizontal bearings where the 42° cone crosses the horizon."""
    anti_az = (sun_az + 180) % 360
    cos_d = math.cos(math.radians(RAINBOW_ANGLE)) / math.cos(math.radians(sun_el))
    if abs(cos_d) > 1:
        return anti_az, anti_az
    delta = math.degrees(math.acos(cos_d))
    return (anti_az - delta) % 360, (anti_az + delta) % 360


# ── 4. Pot-of-gold terrain tracing ──────────────────────────────────────────


def destination_point(lat: float, lon: float, bearing: float, dist: float) -> tuple[float, float]:
    """Great-circle destination."""
    lr, lo, b = math.radians(lat), math.radians(lon), math.radians(bearing)
    d = dist / EARTH_R
    lat2 = math.asin(math.sin(lr) * math.cos(d) + math.cos(lr) * math.sin(d) * math.cos(b))
    lon2 = lo + math.atan2(math.sin(b) * math.sin(d) * math.cos(lr),
                            math.cos(d) - math.sin(lr) * math.sin(lat2))
    return math.degrees(lat2), math.degrees(lon2)


def fetch_elevations(coords: list[tuple[float, float]], client: httpx.Client) -> list[float]:
    """Batch elevation from Open-Meteo (90m Copernicus, no rate limit)."""
    lats = ",".join(f"{c[0]:.6f}" for c in coords)
    lons = ",".join(f"{c[1]:.6f}" for c in coords)
    resp = client.get("https://api.open-meteo.com/v1/elevation",
                      params={"latitude": lats, "longitude": lons}).json()
    return [float(e) for e in resp["elevation"]]


def fetch_elevations_hires(coords: list[tuple[float, float]], client: httpx.Client) -> list[float]:
    """30m SRTM via opentopodata, falling back to Open-Meteo."""
    locations = "|".join(f"{c[0]:.6f},{c[1]:.6f}" for c in coords)
    try:
        resp = client.get(f"https://api.opentopodata.org/v1/srtm30m",
                          params={"locations": locations}, timeout=15).json()
        if resp.get("status") == "OK":
            return [r["elevation"] or 0.0 for r in resp["results"]]
    except Exception:
        pass
    return fetch_elevations(coords, client)


def trace_foot(obs_lat: float, obs_lon: float, obs_alt: float,
               bearing: float, client: httpx.Client) -> dict:
    """Trace a ray to find where the rainbow foot meets terrain.

    The rainbow foot appears where the terrain is furthest below the
    observer's horizontal line of sight — the lowest point in the valley
    along this bearing. That's where raindrops at the 42° angle are closest
    to ground level, creating the visual impression of the bow touching down.

    Strategy:
    1. If terrain rises to meet the observer's altitude → foot is there.
    2. Otherwise, find the terrain minimum (deepest valley) along the bearing
       within a reasonable range — that's where the bow appears to land.
    """
    distances = [100, 200, 300, 400, 500, 700, 900, 1200,
                 1500, 2000, 2500, 3000, 4000, 5000]
    coords = [destination_point(obs_lat, obs_lon, bearing, d) for d in distances]
    elevations = fetch_elevations_hires(coords, client)
    time.sleep(1.1)

    prev_gap = None
    lowest_terrain = {"alt": float('inf'), "dist": 0, "lat": 0, "lon": 0}

    for d, (plat, plon), t in zip(distances, coords, elevations):
        curve_drop = d * d / (2 * EARTH_R)
        gap = obs_alt - t - curve_drop

        # Terrain rises to meet observer level → definitive foot
        if prev_gap is not None and prev_gap > 0 and gap <= 0:
            return {"lat": plat, "lon": plon, "alt": t, "dist": d}

        # Track the lowest terrain point (the valley floor)
        if t < lowest_terrain["alt"] and d >= 200:
            lowest_terrain = {"lat": plat, "lon": plon, "alt": t, "dist": d}

        prev_gap = gap

    # Terrain never rose to observer level — use the valley floor
    if lowest_terrain["dist"] > 0:
        return lowest_terrain

    # Absolute fallback
    return {"lat": coords[2][0], "lon": coords[2][1],
            "alt": elevations[2], "dist": distances[2]}


def compute_pot_of_gold(photos: list[dict]) -> list[dict]:
    """For each session, compute left/right rainbow foot locations."""
    # Deduplicate by date
    seen = set()
    sessions = []
    for p in photos:
        if not p["latitude"]:
            continue
        date = p["datetime_utc"][:10]
        if date in seen:
            continue
        seen.add(date)
        sessions.append(p)

    print(f"\nTracing {len(sessions)} rainbow feet against 30m terrain...\n")
    results = []

    with httpx.Client(timeout=15) as client:
        for p in sessions:
            dt = datetime.strptime(p["datetime_utc"], "%Y-%m-%d %H:%M:%S")
            sun_el, sun_az = solar_position(p["latitude"], p["longitude"], dt)
            left_az, right_az = rainbow_foot_bearings(sun_el, sun_az)
            anti_az = (sun_az + 180) % 360

            print(f"  {p['datetime_utc'][:10]}  sun {sun_el:.1f}° el {sun_az:.0f}° az → "
                  f"feet at {left_az:.0f}° / {right_az:.0f}°")

            lf = trace_foot(p["latitude"], p["longitude"], p["altitude_m"] or 0, left_az, client)
            rf = trace_foot(p["latitude"], p["longitude"], p["altitude_m"] or 0, right_az, client)

            print(f"           left:  {lf['dist']:,.0f}m  right: {rf['dist']:,.0f}m")

            results.append({
                "filename": p["filename"],
                "date": p["datetime_utc"][:10],
                "observer_lat": p["latitude"],
                "observer_lon": p["longitude"],
                "observer_alt_m": p["altitude_m"],
                "sun_elevation": round(sun_el, 2),
                "sun_azimuth": round(sun_az, 2),
                "antisolar_azimuth": round(anti_az, 2),
                "left_foot_bearing": round(left_az, 1),
                "left_foot_lat": round(lf["lat"], 6),
                "left_foot_lon": round(lf["lon"], 6),
                "left_foot_alt_m": round(lf["alt"], 1),
                "left_foot_dist_m": round(lf["dist"]),
                "right_foot_bearing": round(right_az, 1),
                "right_foot_lat": round(rf["lat"], 6),
                "right_foot_lon": round(rf["lon"], 6),
                "right_foot_alt_m": round(rf["alt"], 1),
                "right_foot_dist_m": round(rf["dist"]),
            })

    return results


# ── 5. DuckDB ────────────────────────────────────────────────────────────────


def load_db(photos: list[dict], weather: list[dict], gold: list[dict]):
    """Load all data into DuckDB and run analysis queries."""
    DB_PATH.unlink(missing_ok=True)
    db = duckdb.connect(str(DB_PATH))

    db.execute("CREATE TABLE photos AS SELECT * FROM read_csv_auto(?)", [str(DATA_DIR / "photos.csv")])
    db.execute("CREATE TABLE weather AS SELECT * FROM read_csv_auto(?)", [str(DATA_DIR / "weather.csv")])
    db.execute("CREATE TABLE pot_of_gold AS SELECT * FROM read_csv_auto(?)", [str(DATA_DIR / "pot_of_gold.csv")])

    db.execute("""
        CREATE TABLE rainbow_data AS
        SELECT
            p.filename,
            strptime(p.datetime_utc::VARCHAR, '%Y-%m-%d %H:%M:%S')::TIMESTAMP AS taken_at,
            p.latitude, p.longitude, p.altitude_m, p.camera_bearing,
            EXTRACT(HOUR FROM strptime(p.datetime_utc::VARCHAR, '%Y-%m-%d %H:%M:%S')) AS hour_of_day,
            EXTRACT(MONTH FROM strptime(p.datetime_utc::VARCHAR, '%Y-%m-%d %H:%M:%S')) AS month,
            MONTHNAME(strptime(p.datetime_utc::VARCHAR, '%Y-%m-%d %H:%M:%S')) AS month_name,
            w.temperature_c, w.relative_humidity, w.precipitation_mm,
            w.cloud_cover_pct, w.wind_speed_kmh, w.wind_direction_deg,
            w.weather_code, w.surface_pressure_hpa,
            g.sun_elevation, g.sun_azimuth, g.antisolar_azimuth,
            g.left_foot_bearing, g.left_foot_lat, g.left_foot_lon,
            g.left_foot_alt_m, g.left_foot_dist_m,
            g.right_foot_bearing, g.right_foot_lat, g.right_foot_lon,
            g.right_foot_alt_m, g.right_foot_dist_m
        FROM photos p
        LEFT JOIN weather w ON p.filename = w.filename
        LEFT JOIN pot_of_gold g ON p.filename = g.filename
    """)

    print("\n=== Rainbow Analysis ===\n")
    for label, query in [
        ("Overview", """
            SELECT COUNT(*) AS photos,
                   COUNT(DISTINCT datetime_utc::DATE) AS days,
                   MIN(datetime_utc::DATE) AS earliest,
                   MAX(datetime_utc::DATE) AS latest
            FROM photos"""),
        ("Weather summary", """
            SELECT ROUND(AVG(temperature_c),1) AS avg_temp,
                   ROUND(AVG(relative_humidity),0) AS avg_rh,
                   ROUND(AVG(precipitation_mm),2) AS avg_precip,
                   ROUND(AVG(cloud_cover_pct),0) AS avg_cloud,
                   ROUND(AVG(wind_speed_kmh),1) AS avg_wind
            FROM weather WHERE temperature_c IS NOT NULL"""),
        ("Camera facing (you→rainbow)", """
            SELECT CASE
                WHEN camera_bearing BETWEEN 337.5 AND 360 OR camera_bearing BETWEEN 0 AND 22.5 THEN 'N'
                WHEN camera_bearing BETWEEN 22.5 AND 67.5 THEN 'NE'
                WHEN camera_bearing BETWEEN 67.5 AND 112.5 THEN 'E'
                WHEN camera_bearing BETWEEN 112.5 AND 157.5 THEN 'SE'
                WHEN camera_bearing BETWEEN 157.5 AND 202.5 THEN 'S'
                WHEN camera_bearing BETWEEN 202.5 AND 247.5 THEN 'SW'
                WHEN camera_bearing BETWEEN 247.5 AND 292.5 THEN 'W'
                ELSE 'NW'
            END AS facing, COUNT(*) AS n
            FROM photos WHERE camera_bearing IS NOT NULL
            GROUP BY facing ORDER BY n DESC"""),
        ("Pot-of-gold distances", """
            SELECT date, ROUND(left_foot_dist_m) AS left_m, ROUND(right_foot_dist_m) AS right_m,
                   ROUND(sun_elevation,1) AS sun_el
            FROM pot_of_gold ORDER BY date"""),
    ]:
        print(f"--- {label} ---")
        print(db.execute(query).fetchdf().to_string(index=False))
        print()

    db.close()


# ── 6. Write CSVs ────────────────────────────────────────────────────────────


def write_csv(path: Path, rows: list[dict]):
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)


# ── 7. Convert photos for web ────────────────────────────────────────────────


def convert_for_web():
    WEB_DIR.mkdir(exist_ok=True)
    for heic in sorted(PHOTOS_DIR.glob("*.HEIC")):
        jpg = WEB_DIR / heic.with_suffix(".jpg").name
        if jpg.exists():
            continue
        run(f'sips -s format jpeg -Z 800 "{heic}" --out "{jpg}"')
    print(f"  web thumbnails: {len(list(WEB_DIR.glob('*.jpg')))} files")


# ── 8. Generate map HTML ────────────────────────────────────────────────────


def _num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _int(v):
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return None


def generate_data_json(photos: list[dict], weather: list[dict], gold: list[dict]):
    """Write data/rainbow_data.json for the map to consume."""
    wx = {w["filename"]: w for w in weather}
    gold_by_date = {}
    for g in gold:
        gold_by_date.setdefault(g["date"], g)

    merged = []
    for p in photos:
        if not p["latitude"]:
            continue
        w = wx.get(p["filename"]) or {}
        g = gold_by_date.get(p["datetime_utc"][:10]) or {}
        merged.append({
            "filename": p["filename"],
            "taken_at": p["datetime_utc"],
            "latitude": p["latitude"],
            "longitude": p["longitude"],
            "altitude_m": p["altitude_m"],
            "camera_bearing": p["camera_bearing"],
            "temperature_c": _num(w.get("temperature_c")),
            "relative_humidity": _num(w.get("relative_humidity")),
            "precipitation_mm": _num(w.get("precipitation_mm")),
            "cloud_cover_pct": _num(w.get("cloud_cover_pct")),
            "wind_speed_kmh": _num(w.get("wind_speed_kmh")),
            "wind_direction_deg": _num(w.get("wind_direction_deg")),
            "weather_code": _int(w.get("weather_code")),
            "surface_pressure_hpa": _num(w.get("surface_pressure_hpa")),
            "left_foot_lat": _num(g.get("left_foot_lat")),
            "left_foot_lon": _num(g.get("left_foot_lon")),
            "left_foot_alt_m": _num(g.get("left_foot_alt_m")),
            "left_foot_dist_m": _num(g.get("left_foot_dist_m")),
            "right_foot_lat": _num(g.get("right_foot_lat")),
            "right_foot_lon": _num(g.get("right_foot_lon")),
            "right_foot_alt_m": _num(g.get("right_foot_alt_m")),
            "right_foot_dist_m": _num(g.get("right_foot_dist_m")),
        })

    out = DATA_DIR / "rainbow_data.json"
    out.write_text(json.dumps(merged, indent=2))
    print(f"  data/rainbow_data.json: {len(merged)} photos")


# ── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-weather", action="store_true")
    parser.add_argument("--skip-gold", action="store_true")
    args = parser.parse_args()

    print("1. Extracting EXIF metadata...")
    photos = extract_metadata()
    write_csv(DATA_DIR / "photos.csv", photos)
    print(f"   {len(photos)} photos\n")

    if args.skip_weather and (DATA_DIR / "weather.csv").exists():
        print("2. Skipping weather (reusing data/weather.csv)\n")
        with open(DATA_DIR / "weather.csv") as f:
            weather = list(csv.DictReader(f))
    else:
        print("2. Fetching weather from Open-Meteo...")
        weather = fetch_weather(photos)
        write_csv(DATA_DIR / "weather.csv", weather)
        print()

    if args.skip_gold and (DATA_DIR / "pot_of_gold.csv").exists():
        print("3. Skipping pot-of-gold (reusing data/pot_of_gold.csv)\n")
        with open(DATA_DIR / "pot_of_gold.csv") as f:
            gold = list(csv.DictReader(f))
    else:
        print("3. Computing pot-of-gold locations...")
        gold = compute_pot_of_gold(photos)
        write_csv(DATA_DIR / "pot_of_gold.csv", gold)
        print()

    print("4. Converting photos for web...")
    convert_for_web()
    print()

    print("5. Loading DuckDB...")
    load_db(photos, weather, gold)

    print("6. Writing data JSON for map...")
    generate_data_json(photos, weather, gold)

    print("\nDone. Serve with: uv run python -m http.server -d . 8000")


if __name__ == "__main__":
    main()
