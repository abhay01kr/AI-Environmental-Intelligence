# Power BI data connection

The web dashboard and Power BI use the same Flask environmental-data provider.
The Power BI endpoint returns a flat `data` table with the current reading and
up to 23 preceding hourly readings. Hourly history comes from the provider; it
is not stored as a long-term archive. Historical rows leave current-only
measurements and risk fields blank rather than reusing today's values.
The dashboard's CO₂ card uses NOAA's latest monthly global mean, not a local
measurement; the Open-Meteo air-quality feed provides carbon monoxide (CO),
which is a different gas.
The dashboard's UV card shows today's forecast maximum (`uv_index_daily_max`)
so nighttime readings of the current UV index (`uv_index`) are not mistaken for
the day's peak. Risk calculations continue to use the current UV reading.

## Live pollution map

The **Environmental Analytics** tab also includes an interactive map. It calls
`/api/pollution/map?lat=<latitude>&lon=<longitude>` for up to 25 nearby,
deduplicated Open-Meteo US AQI, PM2.5, and PM10 model estimates around the
selected point.
The map uses OpenStreetMap tiles. These grid estimates are not ground-station
measurements; location access is optional, and the map can be refreshed around
its current center.

## Connect from Power BI Desktop

1. Start the backend from the project root:

   ```powershell
   .\.venv\Scripts\python.exe -m flask --app backend.app run --host 127.0.0.1 --port 5000
   ```

2. In Power BI Desktop, select **Get data > Blank query**, then open **Advanced
   Editor** and paste the query below. Replace the example coordinates with the
   location used by your report.

   ```powerquery
   let
       Response = Json.Document(
           Web.Contents(
               "http://127.0.0.1:5000/api/powerbi/environment",
               [Query = [lat = "28.6139", lon = "77.2090"]]
           )
       ),
       Rows = Response[data],
       EnvironmentalData = Table.FromRecords(Rows)
   in
       EnvironmentalData
   ```

3. Select **Close & Apply**, then build visuals using `observed_at`, `aqi`,
   `temperature_c`, and the current measurement and risk columns. Use
   `record_type` to distinguish hourly rows from the current row, and `source`
   to identify live versus sample data.

The endpoint requires both `lat` and `lon`. It returns HTTP 400 for missing or
invalid coordinates. If the live provider is unavailable, it identifies the
returned fallback readings as `sample`.

## Show the report in the web dashboard

The dashboard's **Environmental Analytics** tab loads the report's
`reportEmbed` URL when selected, provides a reload control, and includes a link
to open the report directly. The report must be shared with and accessible to
the signed-in Microsoft account. If Power BI blocks the frame or asks the user
to sign in, use the direct link. For a production organizational embed, use the
Power BI secure embed flow and its generated URL; do not publish a public
"Publish to web" link for private data.

The embed displays the report but does not change its semantic model. To
include this project's readings in the report, add the Web query above to the
report in Power BI Desktop and publish the updated report to the workspace.

## Refresh and sharing

Power BI Desktop can refresh while the API is running on the same computer.
Power BI Service cannot reach `127.0.0.1` on your computer. To refresh a
published report, host the API at a network-accessible HTTPS address or
configure an on-premises data gateway that can reach the API, then use that
address as the Web data source. Do not expose the Flask development server
directly to the public internet.
