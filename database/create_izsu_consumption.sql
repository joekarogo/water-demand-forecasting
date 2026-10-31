-- izsu_consumption: official İZSU (İzmir Water and Sewerage Administration)
-- monthly billed water-consumption totals, Jan 2014 - Aug 2024, aggregated
-- from the İzmir Metropolitan Municipality Open Data Portal's billed-record
-- dataset (water rows only, wastewater excluded).
--
-- consumption_m3: raw monthly total as billed.
-- consumption_cleaned_m3: same, with 5 outlier months interpolated
--   (2019-09 billing spike; 2020-04/05/06 COVID meter-reading suspension and
--   catch-up; 2020-08), using a centered 13-month rolling median with a
--   1.4x / 0.6x threshold.
-- is_outlier: "yes"/"no" flag for which months were interpolated.
-- subscribers: number of İZSU subscribers that month.

CREATE TABLE IF NOT EXISTS izsu_consumption (
    date DATE PRIMARY KEY,
    consumption_m3 BIGINT,
    consumption_cleaned_m3 BIGINT,
    is_outlier VARCHAR(3),
    subscribers INTEGER
);
