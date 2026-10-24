import csv
import io
import json
import math
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

try:
    import joblib
    import pandas as pd
except ImportError:  # pragma: no cover - dependency is installed via requirements.txt
    joblib = None

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
MODEL_PATH = BASE_DIR / "models" / "environment_model.pkl"
GLOBAL_CO2_URL = "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_gl.csv"
GLOBAL_CO2_CACHE_TTL = timedelta(hours=24)
_global_co2_cache = {"fetched_at": None, "value": None}
_global_co2_cache_lock = threading.Lock()

model = None
if joblib is not None and MODEL_PATH.exists():
    try:
        model = joblib.load(MODEL_PATH)
        print("Environmental ML model loaded successfully!")
    except Exception as exc:  # pragma: no cover - model may be invalid/corrupted
        print(f"Warning: failed to load ML model from {MODEL_PATH}: {exc}")
else:
    print(f"Warning: model file not found at {MODEL_PATH} or joblib is unavailable. Starting in fallback mode.")

app = Flask(
    __name__,
    static_folder=str(FRONTEND_DIR),
    static_url_path="",
)

CORS(app, resources={
    r"/api/*": {
        "origins": [
            r"^http://localhost(:\d+)?$",
            r"^http://127\.0\.0\.1(:\d+)?$",
        ]
    }
})


def get_city_name(lat, lon):
    try:
        url = (
            "https://nominatim.openstreetmap.org/reverse?"
            f"format=jsonv2&lat={lat}&lon={lon}&zoom=18&addressdetails=1"
            "&accept-language=en-IN"
        )
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "AI-Environmental-Intelligence/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
            address = payload.get("address", {})
            city = (
                address.get("city")
                or address.get("town")
                or address.get("village")
                or address.get("hamlet")
                or address.get("suburb")
                or address.get("municipality")
                or address.get("city_district")
                or address.get("county")
                or address.get("state")
            )
            state = address.get("state")
            if city:
                if state and city != state:
                    return f"{city}, {state}"
                return city

            display_name = payload.get("display_name", "")
            if display_name:
                parts = [part.strip() for part in display_name.split(",") if part.strip()]
                return parts[0] if parts else "Your area"
            return "Your area"
    except Exception:
        return None


def fetch_json(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "AI-Environmental-Intelligence/1.0"},
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Environmental data provider returned an invalid response.")
    return payload


def fetch_json_list(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "AI-Environmental-Intelligence/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Air-quality grid provider returned an invalid response.")
    return payload


def get_global_co2():
    now = datetime.now().astimezone()
    with _global_co2_cache_lock:
        fetched_at = _global_co2_cache["fetched_at"]
        if (
            fetched_at is not None
            and now - fetched_at < GLOBAL_CO2_CACHE_TTL
        ):
            return _global_co2_cache["value"]

        req = urllib.request.Request(
            GLOBAL_CO2_URL,
            headers={"User-Agent": "AI-Environmental-Intelligence/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            content = response.read().decode("utf-8")

        reader = csv.DictReader(
            line for line in io.StringIO(content) if not line.startswith("#")
        )
        latest = None
        for row in reader:
            try:
                value = float(row["average"])
                observed_at = f'{int(row["year"]):04d}-{int(row["month"]):02d}'
            except (KeyError, TypeError, ValueError):
                continue
            if math.isfinite(value) and value > 0:
                latest = {"co2": value, "co2_time": observed_at}

        if latest is None:
            raise ValueError("NOAA returned no valid global CO2 measurements.")

        _global_co2_cache["fetched_at"] = now
        _global_co2_cache["value"] = latest
        return latest


def get_location_environment(lat, lon):
    coordinates = {"latitude": lat, "longitude": lon}
    weather_params = {
        **coordinates,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,uv_index,wind_speed_10m",
        "hourly": "temperature_2m",
        "daily": "precipitation_probability_max,uv_index_max",
        "past_days": 1,
        "forecast_days": 1,
        "timezone": "auto",
    }
    air_quality_params = {
        **coordinates,
        "current": "us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone",
        "hourly": "us_aqi",
        "past_days": 1,
        "forecast_days": 7,
        "timezone": "auto",
    }
    weather_url = "https://api.open-meteo.com/v1/forecast?" + urlencode(weather_params)
    air_quality_url = "https://air-quality-api.open-meteo.com/v1/air-quality?" + urlencode(air_quality_params)

    with ThreadPoolExecutor(max_workers=4) as executor:
        city_future = executor.submit(get_city_name, lat, lon)
        weather_future = executor.submit(fetch_json, weather_url)
        air_quality_future = executor.submit(fetch_json, air_quality_url)
        co2_future = executor.submit(get_global_co2)
        city = city_future.result()
        weather = weather_future.result()
        air_quality = air_quality_future.result()
        try:
            global_co2 = co2_future.result()
        except (OSError, ValueError, UnicodeError) as exc:
            app.logger.warning("Global CO2 data unavailable: %s", exc)
            global_co2 = {"co2": None, "co2_time": None}

    current_weather = weather.get("current")
    current_air = air_quality.get("current")
    if not isinstance(current_weather, dict) or not isinstance(current_air, dict):
        raise ValueError("Environmental data provider did not return current conditions.")

    daily = weather.get("daily") or {}
    daily_times = daily.get("time") or []
    daily_rain = daily.get("precipitation_probability_max") or []
    daily_uv_max = daily.get("uv_index_max") or []
    hourly_weather = weather.get("hourly") or {}
    hourly_air = air_quality.get("hourly") or {}
    history = []
    current_time = current_weather.get("time")
    hourly_times = hourly_weather.get("time") or []
    hourly_temperatures = hourly_weather.get("temperature_2m") or []
    hourly_air_times = hourly_air.get("time") or []
    hourly_aqi = hourly_air.get("us_aqi") or []
    aqi_by_time = {
        timestamp: value
        for timestamp, value in zip(hourly_air_times, hourly_aqi)
        if isinstance(timestamp, str)
    }
    if isinstance(current_time, str):
        for timestamp, temperature in zip(hourly_times, hourly_temperatures):
            if not isinstance(timestamp, str) or timestamp > current_time:
                continue
            aqi = aqi_by_time.get(timestamp)
            if aqi is None:
                continue
            try:
                temperature = float(temperature)
                aqi = float(aqi)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(temperature) or not math.isfinite(aqi):
                continue
            history.append({
                "time": timestamp,
                "temperature": temperature,
                "aqi": aqi,
            })
    history = history[-24:]
    current_date = current_time[:10] if isinstance(current_time, str) else None
    rain_index = daily_times.index(current_date) if current_date in daily_times else 0
    rain_chance = daily_rain[rain_index] if rain_index < len(daily_rain) else None
    uv_max = daily_uv_max[rain_index] if rain_index < len(daily_uv_max) else None
    forecast_by_date = {}
    forecast_dates = []
    if current_date:
        forecast_dates = [
            (datetime.fromisoformat(current_date).date() + timedelta(days=offset)).isoformat()
            for offset in range(1, 8)
        ]
        for timestamp, value in zip(hourly_air_times, hourly_aqi):
            if not isinstance(timestamp, str):
                continue
            forecast_date = timestamp[:10]
            if forecast_date not in forecast_dates or (
                forecast_date == current_date and timestamp < current_time
            ):
                continue
            try:
                aqi_value = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(aqi_value):
                forecast_by_date[forecast_date] = max(
                    forecast_by_date.get(forecast_date, aqi_value),
                    aqi_value,
                )
    aqi_forecast = [
        {
            "date": forecast_date,
            "aqi": round(forecast_by_date[forecast_date])
            if forecast_date in forecast_by_date else None,
        }
        for forecast_date in forecast_dates
    ]
    carbon_monoxide = current_air.get("carbon_monoxide")
    carbon_monoxide_mg_m3 = (
        float(carbon_monoxide) / 1000
        if carbon_monoxide is not None and math.isfinite(float(carbon_monoxide))
        else None
    )
    result = {
        "source": "open-meteo",
        "city": city,
        "latitude": lat,
        "longitude": lon,
        "weather_grid_location": {
            "latitude": weather.get("latitude"),
            "longitude": weather.get("longitude"),
        },
        "air_quality_grid_location": {
            "latitude": air_quality.get("latitude"),
            "longitude": air_quality.get("longitude"),
        },
        "time": current_weather.get("time"),
        "air_quality_time": current_air.get("time"),
        "aqi": current_air.get("us_aqi"),
        "temperature": current_weather.get("temperature_2m"),
        "apparent_temperature": current_weather.get("apparent_temperature"),
        "uv": current_weather.get("uv_index"),
        "uv_max": uv_max,
        "humidity": current_weather.get("relative_humidity_2m"),
        **global_co2,
        "pm25": current_air.get("pm2_5"),
        "pm10": current_air.get("pm10"),
        "carbon_monoxide": carbon_monoxide,
        "carbon_monoxide_mg_m3": carbon_monoxide_mg_m3,
        "nitrogen_dioxide": current_air.get("nitrogen_dioxide"),
        "sulphur_dioxide": current_air.get("sulphur_dioxide"),
        "ozone": current_air.get("ozone"),
        "wind": current_weather.get("wind_speed_10m"),
        "rain_chance": rain_chance,
        "hourly_history": history,
        "aqi_forecast": aqi_forecast,
    }
    required_values = ("aqi", "temperature", "uv", "humidity", "pm25", "wind")
    if not all(
        value is not None and math.isfinite(float(value))
        for value in (result[field] for field in required_values)
    ):
        raise ValueError("Environmental data provider returned incomplete measurements.")

    result["aqi"] = round(float(result["aqi"]))
    return result


@app.route("/")
def home():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/api/health")
def health():
    return jsonify({
        "status": "success",
        "message": "AI Environmental Intelligence Backend is running.",
        "model_loaded": model is not None,
    })


@app.route("/docs/power-bi")
def powerbi_documentation():
    return send_from_directory(BASE_DIR / "backend", "POWER_BI.md")


@app.route("/api/environment")
def environment():
    has_lat = "lat" in request.args
    has_lon = "lon" in request.args
    if has_lat != has_lon:
        return jsonify({
            "success": False,
            "error": "Both latitude and longitude are required."
        }), 400

    if has_lat and has_lon:
        try:
            lat = float(request.args["lat"])
            lon = float(request.args["lon"])
        except ValueError:
            return jsonify({
                "success": False,
                "error": "Latitude and longitude must be numeric values."
            }), 400

        if not math.isfinite(lat) or not math.isfinite(lon) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
            return jsonify({
                "success": False,
                "error": "Latitude must be between -90 and 90 and longitude between -180 and 180."
            }), 400

        try:
            return jsonify(get_location_environment(lat, lon))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            app.logger.warning("Location environmental data unavailable: %s", exc)
            return jsonify({
                "success": False,
                "error": "Live environmental data is temporarily unavailable."
            }), 502

    return jsonify({
        "success": False,
        "error": "Location is required to load live environmental data."
    }), 400


@app.route("/api/pollution/map")
def pollution_map():
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify({
            "success": False,
            "error": "Provide numeric latitude and longitude values."
        }), 400

    if (
        not math.isfinite(lat)
        or not math.isfinite(lon)
        or not -90 <= lat <= 90
        or not -180 <= lon <= 180
    ):
        return jsonify({
            "success": False,
            "error": "Latitude must be between -90 and 90 and longitude between -180 and 180."
        }), 400

    latitude_offsets = (-0.15, -0.075, 0, 0.075, 0.15)
    longitude_scale = max(math.cos(math.radians(lat)), 0.2)
    longitude_offsets = tuple(offset / longitude_scale for offset in latitude_offsets)
    points = [
        (
            min(90, max(-90, lat + latitude_offset)),
            min(180, max(-180, lon + longitude_offset)),
        )
        for latitude_offset in latitude_offsets
        for longitude_offset in longitude_offsets
    ]
    params = {
        "latitude": ",".join(f"{point_lat:.5f}" for point_lat, _ in points),
        "longitude": ",".join(f"{point_lon:.5f}" for _, point_lon in points),
        "current": "us_aqi,pm2_5,pm10",
        "timezone": "auto",
    }
    url = "https://air-quality-api.open-meteo.com/v1/air-quality?" + urlencode(params)

    try:
        results = fetch_json_list(url)
        if len(results) != len(points):
            raise ValueError("Air-quality provider returned an incomplete grid.")

        readings = []
        seen_locations = set()
        for result in results:
            if not isinstance(result, dict):
                continue
            current = result.get("current")
            if not isinstance(current, dict):
                continue
            try:
                point_lat = float(result["latitude"])
                point_lon = float(result["longitude"])
                aqi = float(current["us_aqi"])
            except (KeyError, TypeError, ValueError):
                continue
            if not all(math.isfinite(value) for value in (point_lat, point_lon, aqi)):
                continue
            key = (round(point_lat, 4), round(point_lon, 4))
            if key in seen_locations:
                continue
            seen_locations.add(key)
            readings.append({
                "latitude": point_lat,
                "longitude": point_lon,
                "aqi": round(aqi),
                "pm25": current.get("pm2_5"),
                "pm10": current.get("pm10"),
                "observed_at": current.get("time"),
            })
    except (OSError, ValueError, TypeError, KeyError) as exc:
        app.logger.warning("Live pollution map unavailable: %s", exc)
        return jsonify({
            "success": False,
            "error": "Live pollution map data is temporarily unavailable."
        }), 502

    if not readings:
        return jsonify({
            "success": False,
            "error": "No live air-quality readings are available for this area."
        }), 502

    return jsonify({
        "success": True,
        "source": "Open-Meteo",
        "center": {"latitude": lat, "longitude": lon},
        "grid_radius_km": 20,
        "points": readings,
    })


def calculate_environmental_risk(aqi, temperature, uv, humidity):

    score = 0

    if aqi > 300:
        score += 60
    elif aqi > 200:
        score += 45
    elif aqi > 100:
        score += 30
    elif aqi > 50:
        score += 15

    if temperature >= 40:
        score += 20
    elif temperature >= 35:
        score += 10

    if uv >= 8:
        score += 15
    elif uv >= 6:
        score += 10

    if humidity >= 80:
        score += 5

    score = min(score, 100)

    if score <= 25:
        level = "Low"
    elif score <= 50:
        level = "Moderate"
    elif score <= 70:
        level = "High"
    elif score <= 85:
        level = "Very High"
    else:
        level = "Critical"

    return {
        "risk_score": score,
        "risk_level": level
    }


@app.route("/api/powerbi/environment")
def powerbi_environment():
    has_lat = "lat" in request.args
    has_lon = "lon" in request.args
    if has_lat != has_lon:
        return jsonify({
            "success": False,
            "error": "Both latitude and longitude are required."
        }), 400
    if not has_lat:
        return jsonify({
            "success": False,
            "error": "Provide latitude and longitude to select the Power BI report location."
        }), 400

    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
    except ValueError:
        return jsonify({
            "success": False,
            "error": "Latitude and longitude must be numeric values."
        }), 400

    if not math.isfinite(lat) or not math.isfinite(lon) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
        return jsonify({
            "success": False,
            "error": "Latitude must be between -90 and 90 and longitude between -180 and 180."
        }), 400

    try:
        data = get_location_environment(lat, lon)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        app.logger.warning("Power BI environmental data unavailable: %s", exc)
        return jsonify({
            "success": False,
            "error": "Live environmental data is temporarily unavailable."
        }), 502

    current_time = data.get("time") or datetime.now().astimezone().isoformat(timespec="seconds")
    history = [
        item for item in data.get("hourly_history", [])
        if item.get("time") != current_time
    ][-23:]
    measurements = {
        "apparent_temperature_c": data.get("apparent_temperature"),
        "uv_index": data.get("uv"),
        "uv_index_daily_max": data.get("uv_max"),
        "relative_humidity_percent": data.get("humidity"),
        "pm25_ug_m3": data.get("pm25"),
        "pm10_ug_m3": data.get("pm10"),
        "carbon_monoxide_ug_m3": data.get("carbon_monoxide"),
        "nitrogen_dioxide_ug_m3": data.get("nitrogen_dioxide"),
        "sulphur_dioxide_ug_m3": data.get("sulphur_dioxide"),
        "ozone_ug_m3": data.get("ozone"),
        "wind_speed_kmh": data.get("wind"),
        "precipitation_probability_percent": data.get("rain_chance"),
    }
    rows = [
        {
            "observed_at": item["time"],
            "record_type": "hourly",
            "source": data.get("source"),
            "city": data.get("city"),
            "latitude": data.get("latitude", lat),
            "longitude": data.get("longitude", lon),
            "aqi": item["aqi"],
            "temperature_c": item["temperature"],
            **{name: None for name in measurements},
            "risk_score": None,
            "risk_level": None,
        }
        for item in history
    ]
    risk = calculate_environmental_risk(
        float(data["aqi"]),
        float(data["temperature"]),
        float(data["uv"]),
        float(data["humidity"]),
    )
    rows.append({
        "observed_at": current_time,
        "record_type": "current",
        "source": data.get("source"),
        "city": data.get("city"),
        "latitude": data.get("latitude", lat),
        "longitude": data.get("longitude", lon),
        "aqi": data.get("aqi"),
        "temperature_c": data.get("temperature"),
        **measurements,
        "risk_score": risk["risk_score"],
        "risk_level": risk["risk_level"],
    })
    return jsonify({
        "data": rows,
        "metadata": {
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "history_hours": 24,
            "source": data.get("source"),
        },
    })


@app.route("/api/risk", methods=["POST", "OPTIONS"])
def environmental_risk():

    if request.method == "OPTIONS":
        return "", 200

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"success": False, "error": "Request body must be a JSON object."}), 400

    required_fields = ("aqi", "temperature", "uv", "humidity")
    missing_fields = [field for field in required_fields if field not in data]
    if missing_fields:
        return jsonify({
            "success": False,
            "error": "Missing required environmental measurements.",
            "missing": missing_fields
        }), 400

    try:
        measurements = {
            field: float(data[field])
            for field in required_fields
        }
    except (TypeError, ValueError):
        return jsonify({"success": False, "error": "AQI, temperature, UV, and humidity must be numeric values."}), 400

    if not all(math.isfinite(value) for value in measurements.values()):
        return jsonify({"success": False, "error": "Environmental measurements must be finite numbers."}), 400

    if measurements["aqi"] < 0 or measurements["uv"] < 0 or not 0 <= measurements["humidity"] <= 100:
        return jsonify({
            "success": False,
            "error": "AQI and UV must be non-negative, and humidity must be between 0 and 100."
        }), 400

    result = calculate_environmental_risk(
        measurements["aqi"],
        measurements["temperature"],
        measurements["uv"],
        measurements["humidity"]
    )

    return jsonify({
        "success": True,
        "data": result
    })

@app.route("/api/predict", methods=["POST"])
def predict_aqi():
    if model is None:
        return jsonify({
            "success": False,
            "error": "ML model is not loaded"
        }), 500

    try:
        data = request.get_json(silent=True) or {}

        features = [
            "PM2.5", "PM10", "NO", "NO2",
            "NOx", "NH3", "CO", "SO2",
            "O3", "Benzene", "Toluene", "Xylene"
        ]

        missing = [
            feature for feature in features
            if feature not in data
        ]

        if missing:
            return jsonify({
                "success": False,
                "error": "Missing input features",
                "missing": missing
            }), 400

        try:
            numeric_values = [float(data[name]) for name in features]
        except (TypeError, ValueError) as error:
            raise ValueError("All pollutant inputs must be numeric.") from error

        if not all(math.isfinite(value) and value >= 0 for value in numeric_values):
            return jsonify({
                "success": False,
                "error": "Pollutant inputs must be finite, non-negative values."
            }), 400

        values = pd.DataFrame([numeric_values], columns=features)
        prediction = float(model.predict(values)[0])
        model_values = values.to_numpy()
        tree_predictions = sorted(
            float(estimator.predict(model_values)[0])
            for estimator in model.estimators_
        )

        def percentile(sorted_values, percent):
            position = (len(sorted_values) - 1) * percent / 100
            lower = math.floor(position)
            upper = math.ceil(position)
            if lower == upper:
                return sorted_values[lower]
            weight = position - lower
            return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight

        return jsonify({
            "success": True,
            "predicted_aqi": round(prediction, 2),
            "model_tree_spread": {
                "p10": round(percentile(tree_predictions, 10), 2),
                "p90": round(percentile(tree_predictions, 90), 2),
                "tree_count": len(tree_predictions),
            }
        })

    except (ValueError, TypeError) as error:
        return jsonify({
            "success": False,
            "error": str(error)
        }), 400
    except Exception:
        app.logger.exception("AQI prediction failed")
        return jsonify({
            "success": False,
            "error": "Prediction failed. Check model inputs."
        }), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)