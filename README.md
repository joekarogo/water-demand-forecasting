# water-demand-forecasting

## Overview
This project develops an integrated water demand forecasting system using the Prophet Time Series algorithm. It addresses the problem of reactive management in water production companies ; where decisions are made based on immediate need rather than data-driven projections. By forecasting future water demand, the system enables water production companies to plan production proactively.

## Tech Stack
- **Frontend:** React.js 19.3.0
- **Backend:** Node.js 22.16.0
- **Database:** PostgreSQL 17
- **ML Component:** Python 3.13.5 + Prophet 1.4.0
- **Version Control:** GitHub
- **Model Storage:** Google Drive
- **AI Tool:** Claude Code

## Results So Far

- MAE: 401,104 m3
- RMSE: 457,897 m3
- Cross Validation Mean MAE: 190,087 m3 (11 folds)
- Cross Validation Mean RMSE: 227,574 m3 (11 folds)
- Error rate: less than 1% of average monthly consumption
