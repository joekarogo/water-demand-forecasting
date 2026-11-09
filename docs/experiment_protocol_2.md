# Experiment Protocol 2

**Fixed 8 November 2026, before any Protocol 2 experiment has been run.**
The evidence for this is the git commit time of this file: it is committed
before `ml/features.py`'s functions are ever applied inside a model-fitting
or evaluation script, and strictly before any of the experiments below are
run.

This is the second round of experiments, building on Experiment Protocol 1
(the "Evaluation protocol — fixed 26 October 2026 (01:58 EAT)" comment in
`ml/eval_common.py`, which this document does not change). Protocol 1 fixed
how models are trained, tested and compared; Protocol 2 adds new candidate
models and inputs on top of that same, unchanged evaluation machinery.

## Unchanged from Protocol 1

These are carried over exactly as they already exist in the code
(`ml/eval_common.py`, `ml/rolling_evaluation.py`) — nothing below is new or
re-derived for Protocol 2:

- **102 training months**, January 2014 - June 2022.
- **26 test months**, July 2022 - August 2024, held out and never used to
  choose any setting, weight or feature for any model.
- The **outlier rule**: a centered 13-month rolling median, with a month
  flagged as an outlier if it falls above 1.4x or below 0.6x that median;
  the rule itself is fitted on the training period only, so no test-period
  month was ever used to decide what counts as an outlier.
- **15 rolling origins**, from June 2022 to August 2023, each refitting
  every model on all data up to and including that origin and forecasting
  12 months ahead.
- **Horizons 1 through 12** months ahead.
- A fixed **random seed of 42**, set immediately before every Prophet
  `.predict()` call, so a given model/data/origin combination always
  produces the same forecast.
- The **test period is never used** to choose a model, a hyperparameter, a
  feature, or an ensemble weight. Every experiment below is designed and
  evaluated using only the training months and the 15 rolling origins
  (all of which fall before the test period ends, and whose own 12-month
  targets never reach past the end of the data); the 26-month test set is
  only ever used once a model/feature is otherwise finalised.

## Disclosure

The five experiments below were chosen after seeing Protocol 1's results.
In particular:

- SARIMA outperformed Prophet (defaults) at short rolling-origin horizons
  (e.g. 1, 3 and 4 months ahead), while Prophet (defaults) was the better
  model at a 12-month horizon.
- Prophet (defaults)'s two-sided 80% interval covered only 66.7% of actual
  outcomes at a 1-month horizon, well short of the nominal 80%.

Because Protocol 2's experiment list was informed by these findings, it is
not a blind, pre-registered set of ideas in the way Protocol 1's model
comparison was. The selection rule below (both a test-set win and a rolling
h12 win required, with every Diebold-Mariano result reported regardless of
outcome) is the safeguard against this: seeing Protocol 1's results first
cannot, by itself, make a Protocol 2 candidate look better on data it still
has never been fitted or tuned against.

## Experiments

### E1 — Conformal calibration (core)

Prophet's own 80% interval is poorly calibrated (66.7% two-sided coverage
at h1, see above). E1 calibrates that interval using forecast errors from
rolling origins that fall entirely inside the training period — each
calibration origin's own 12 target months must end by June 2022, so no
origin or target month used for calibration overlaps the 15 origins used
for E1's own evaluation, or the test period.

**Success criterion:** on the same 15 rolling-origin test set used
throughout, two-sided coverage must be closer to the nominal 80% than the
baseline's 66.7%, AND at-or-below-upper coverage at horizon 1 must still be
at least 90% (i.e. calibration must not fix two-sided coverage by widening
the interval so much that the upper bound — which the safe production plan
relies on — stops doing its job).

### E2 — Weather (core)

Three monthly features, built in `ml/features.py` from
`ml/data/weather_izmir_era5.csv`: the monthly mean of daily mean
temperature, the monthly mean of daily maximum temperature, and total
monthly precipitation (all from the ERA5 reanalysis model — see
[`ml/data/README.md`](../ml/data/README.md)).

The main evaluation feeds every "future" month (any month after the
origin/training cutoff) the **training-period normal** for that calendar
month — the average of that variable in that calendar month, using only
months up to the cutoff (`weather_normals` in `ml/features.py`) — because
real future weather is not actually known at forecast time, and a model
meant to be used operationally cannot be given it. A second set of results,
using the real observed weather for those same future months instead, is
reported separately and clearly labelled **"best case, not achievable in
practice"** — it shows the ceiling on what weather could buy the model if
weather were somehow known in advance, not a result any deployed version of
this model could actually achieve.

### E3 — Bayram days (secondary)

One feature: the number of official **Ramazan Bayramı** and **Kurban
Bayramı** days falling in each month (`bayram_days_monthly` in
`ml/features.py`, via the `holidays` library's Turkish public-holiday
calendar).

Government-extended holidays (*idari izin* — days the government adds onto
an official holiday to create a longer break) are excluded: they are
announced only a few weeks ahead each year, cover public-sector employees
only, and would not be knowable far enough in advance for a forecasting
model to use them the way it can use the Bayram dates themselves, which are
determined by the lunar calendar and knowable years ahead.

### E4 — Ensemble (optional)

An equal 50/50 average of Prophet (defaults) and whichever SARIMA
configuration Protocol 1 already selected (`ml/sarima_select.py`'s
output). No weight is tuned — the 50/50 split is fixed in advance, so this
experiment cannot overfit an ensemble weight to the test set or to the
rolling origins.

### E5 — History length (optional)

At each rolling origin, training on only the last 3, 5, 7 and 8.5 years of
history immediately before that origin (rather than always using all
available history), to see whether a shorter, more-recent training window
helps or hurts.

## Selection rule

A candidate from any experiment above replaces the currently published
model (Prophet, defaults) only if it beats Prophet (defaults) on **both**:

1. The 26-month held-out test-set MAPE, and
2. The rolling-origin mean MAPE at a 12-month horizon.

Diebold-Mariano significance tests are computed and reported for every
comparison made in this protocol, but a change in the published model does
**not** require p < 0.05. With only 15 overlapping rolling origins, the DM
test has low statistical power here, so requiring significance would make
it very hard to ever justify a change — the dual-metric rule above is the
actual bar for changing the published model, and the DM results are
reported alongside it for transparency, not as a gate.

## Reporting

Every experiment above is reported in full, including any that do not
improve on Prophet (defaults) — a negative result is still a result.

## Known limitations

- There is no İZSU consumption data after August 2024. September 2024 had
  only 3,107 of the usual ~11,000 rows and is excluded as incomplete, so
  there is no fresh, more-recent test set available for this round of
  experiments either — Protocol 2 reuses the same test period as Protocol
  1.
- Only 18 of the 102 training months contain a Bayram day at all, so E3's
  feature is zero for the large majority of training months.
- The ERA5 weather data is a single reanalysis grid-cell value (roughly a
  25 km grid) for the whole city, not a station reading — it does not
  capture any intra-city variation in temperature or rainfall.
