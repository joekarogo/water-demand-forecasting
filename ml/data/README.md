# ml/data

Inputs for Experiment Protocol 2 (see
[docs/experiment_protocol_2.md](../../docs/experiment_protocol_2.md)). Nothing
in this directory is produced by this repo's own pipeline — these are
external source files, checked in as-is.

## `weather_izmir_era5.csv`

Daily weather for İzmir, copied byte-for-byte from the Open-Meteo Historical
Weather API (ERA5 reanalysis model).

- **Source:** Open-Meteo Historical Weather API, `models=era5`.
- **Request URL:**
  `https://archive-api.open-meteo.com/v1/archive?latitude=38.4127&longitude=27.1384&start_date=2014-01-01&end_date=2026-10-31&daily=temperature_2m_mean,temperature_2m_max,precipitation_sum&models=era5&timezone=auto`
- **Downloaded:** 8 November 2026.
- **Location:** chosen by searching "İzmir" (38.4127, 27.1384); the API
  returned the ERA5 grid cell centred at 38.50N, 27.25E, elevation 114 m —
  this is the nearest ERA5 grid point to the searched coordinates, not a
  station at the exact searched location.
- **Licence:** CC BY 4.0.

### Why ERA5, not Open-Meteo's default "best match"

Open-Meteo's default "best match" blend switches which underlying weather
model it draws from partway through this period. A test download using
"best match" showed identical yearly rainfall to the ERA5-only download for
2014-2016, then diverging from 2017 onward, alongside a roughly 0.5°C step
in temperature at the same point. Because the switch would otherwise fall
inside the training period used by Experiment Protocol 2, ERA5 is used for
the entire 2014-2026 span instead, so the whole series comes from one
consistent model.

### Validation

- 4,687 days, 2014-01-01 to 2026-10-31, no missing values.
- 2014-2024 averages: January 8.6°C, July 28.9°C, August 29.0°C; rainfall
  744 mm/yr.
- For comparison, the MGM İzmir station (1938-2025): January 8.9°C, July
  28.0°C, August 27.7°C; rainfall 707 mm/yr.
- Hottest day in the file: 41.5°C on 2023-07-26.

### Citations (APA)

Zippenfenig, P. (2023). *Open-Meteo.com Weather API* [Computer software].
Zenodo. https://doi.org/10.5281/ZENODO.7970649

Hersbach, H., et al. (2023). *ERA5 hourly data on single levels from 1940 to
present* [Data set]. ECMWF. https://doi.org/10.24381/cds.adbb2d47
