"""
Experiment run logger.

Saves a timestamped, traceable record of a model run — the code version
(git commit) it was produced by, the exact dataset it used, the parameters
and metrics, and (optionally) the predictions and a plot — so every reported
number in this project can be traced back to the run that produced it.

Usage:
    from run_logger import save_run

    params = {
        'changepoint_prior_scale': 0.05,
        'seasonality_prior_scale': 10,
        'seasonality_mode': 'additive',
        'train_size': 102,   # pulled out of params and filed under "dataset"
        'test_size': 26,     # pulled out of params and filed under "dataset"
    }
    metrics = {'mae': 1027290.96, 'rmse': 1308929.48, 'mape': 4.86}
    save_run('forecast_test_eval', params, metrics, predictions_df=df, fig=fig)
"""

import json
import os
import subprocess
import sys
from datetime import datetime

import numpy as np
import pandas as pd
import prophet
import psycopg2
from dotenv import load_dotenv

# Load environment variables from .env in the project root
_DOTENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(_DOTENV_PATH)

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
_DEFAULT_RUNS_DIR = r"G:\My Drive\water-demand-forecasting\runs"


def _get_runs_dir():
    """RUNS_DIR is optional in .env; falls back to the Google Drive default."""
    return os.getenv('RUNS_DIR', _DEFAULT_RUNS_DIR)


def _get_git_info():
    """Current commit hash and whether the working tree has uncommitted
    changes. Read-only (`git rev-parse` / `git status --porcelain`) — never
    writes to the repo. Returns None values if git isn't available."""
    try:
        commit = subprocess.run(
            ['git', 'rev-parse', 'HEAD'],
            cwd=_PROJECT_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
        status = subprocess.run(
            ['git', 'status', '--porcelain'],
            cwd=_PROJECT_ROOT, capture_output=True, text=True, check=True
        ).stdout
        return {'commit': commit, 'working_tree_dirty': bool(status.strip())}
    except Exception as err:
        return {'commit': None, 'working_tree_dirty': None, 'error': str(err)}


def _get_dataset_info():
    """Read-only lookup of izsu_consumption's current shape. Never modifies
    the database."""
    try:
        conn = psycopg2.connect(
            host=os.getenv("DB_HOST"),
            database=os.getenv("DB_NAME"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            port=os.getenv("DB_PORT")
        )
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM izsu_consumption")
        row_count, min_date, max_date = cur.fetchone()
        cur.close()
        conn.close()
        return {
            'table': 'izsu_consumption',
            'column': 'consumption_cleaned_m3',
            'row_count': row_count,
            'date_range': {'start': str(min_date), 'end': str(max_date)},
        }
    except Exception as err:
        return {
            'table': 'izsu_consumption',
            'column': 'consumption_cleaned_m3',
            'error': str(err),
        }


def _get_versions():
    return {
        'python': sys.version.split()[0],
        'prophet': prophet.__version__,
        'pandas': pd.__version__,
        'numpy': np.__version__,
    }


def save_run(run_name, params, metrics, predictions_df=None, fig=None):
    """Save a traceable record of one experiment run.

    run_name: short label, e.g. 'forecast_test_eval'.
    params: hyperparameters / config used for this run. May include
        'train_size' and 'test_size' — these are pulled out and filed under
        the 'dataset' section instead of staying in 'params'.
    metrics: dict of result metrics (e.g. mae/rmse/mape), or a dict of dicts
        when several models are being compared in one run.
    predictions_df: optional DataFrame with columns
        date, actual, predicted, lower, upper — saved as predictions.csv.
    fig: optional matplotlib Figure — saved as forecast_plot.png.

    Returns the path to the created run folder.
    """
    timestamp = datetime.now()
    folder_name = f"{timestamp.strftime('%Y%m%d-%H%M%S')}_{run_name}"
    run_dir = os.path.join(_get_runs_dir(), folder_name)
    os.makedirs(run_dir, exist_ok=True)

    params = dict(params)  # copy — don't mutate the caller's dict
    train_size = params.pop('train_size', None)
    test_size = params.pop('test_size', None)

    dataset_info = _get_dataset_info()
    dataset_info['train_size'] = train_size
    dataset_info['test_size'] = test_size

    run_info = {
        'timestamp': timestamp.isoformat(),
        'run_name': run_name,
        'git': _get_git_info(),
        'dataset': dataset_info,
        'params': params,
        'metrics': metrics,
        'versions': _get_versions(),
    }

    with open(os.path.join(run_dir, 'run_info.json'), 'w') as f:
        json.dump(run_info, f, indent=2, default=str)

    if predictions_df is not None:
        predictions_df.to_csv(os.path.join(run_dir, 'predictions.csv'), index=False)

    if fig is not None:
        fig.savefig(os.path.join(run_dir, 'forecast_plot.png'), bbox_inches='tight')

    print(f"Run saved to {run_dir}")
    return run_dir
