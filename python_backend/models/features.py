"""
Feature Engineering Module
Calculates all 20 advanced quantitative mathematical parameters.
"""
import numpy as np
import pandas as pd
from scipy.stats import linregress
from ta.momentum import ROCIndicator, TSIIndicator, WilliamsRIndicator, RSIIndicator, StochasticOscillator
from ta.trend import ADXIndicator, CCIIndicator, MACD, IchimokuIndicator
from ta.volatility import BollingerBands, AverageTrueRange, KeltnerChannel, DonchianChannel
from ta.volume import OnBalanceVolumeIndicator, ChaikinMoneyFlowIndicator

def add_all_features(df):
    """
    Given a pandas DataFrame with OHLCV data, computes and adds 20 quant parameters.
    Returns the DataFrame and a list of ML_FEATURES.
    """
    df = df.copy()
    
    # PARAMETER 1 — LOG RETURNS
    # r_t = ln(P_t / P_{t-1})
    df['log_return'] = np.log(df['close'] / df['close'].shift(1))
    
    # PARAMETER 2 — EXPONENTIAL MOVING AVERAGE (EMA)
    # EMA_t = α * P_t + (1-α) * EMA_{t-1}
    df['ema_fast'] = df['close'].ewm(span=20, adjust=False).mean()
    df['ema_slow'] = df['close'].ewm(span=50, adjust=False).mean()
    df['ema_major'] = df['close'].ewm(span=200, adjust=False).mean()
    
    # PARAMETER 3 — VOLATILITY (ROLLING STANDARD DEVIATION)
    # σ = sqrt(1/n * Σ(r_i - μ)²)
    df['volatility'] = df['log_return'].rolling(window=20).std()
    
    # PARAMETER 4 — Z-SCORE (MEAN REVERSION SIGNAL)
    # Z = (P - μ) / σ
    rolling_mean = df['close'].rolling(window=20).mean()
    rolling_std = df['close'].rolling(window=20).std()
    df['zscore'] = (df['close'] - rolling_mean) / rolling_std
    
    # PARAMETER 5 — BOLLINGER BANDS
    # Upper = MA + 2σ, Lower = MA - 2σ
    bb = BollingerBands(close=df['close'], window=20, window_dev=2)
    df['bb_upper'] = bb.bollinger_hband()
    df['bb_lower'] = bb.bollinger_lband()
    df['bb_mid'] = bb.bollinger_mavg()
    df['bb_width'] = (df['bb_upper'] - df['bb_lower']) / df['bb_mid']
    # Avoid division by zero
    diff = df['bb_upper'] - df['bb_lower']
    diff = diff.replace(0, np.nan)
    df['bb_pct'] = (df['close'] - df['bb_lower']) / diff
    
    # PARAMETER 6 — RSI (RELATIVE STRENGTH INDEX)
    rsi = RSIIndicator(close=df['close'], window=14)
    df['rsi'] = rsi.rsi()
    
    # PARAMETER 7 — MACD
    macd = MACD(close=df['close'], window_slow=26, window_fast=12, window_sign=9)
    df['macd'] = macd.macd()
    df['macd_signal'] = macd.macd_signal()
    df['macd_hist'] = macd.macd_diff()
    
    # PARAMETER 8 — ATR (AVERAGE TRUE RANGE)
    atr = AverageTrueRange(high=df['high'], low=df['low'], close=df['close'], window=14)
    df['atr'] = atr.average_true_range()
    
    # PARAMETER 9 — STOCHASTIC OSCILLATOR
    stoch = StochasticOscillator(high=df['high'], low=df['low'], close=df['close'], window=14, smooth_window=3)
    df['stoch_k'] = stoch.stoch()
    df['stoch_d'] = stoch.stoch_signal()
    
    # PARAMETER 10 — ADX (AVERAGE DIRECTIONAL INDEX)
    adx = ADXIndicator(high=df['high'], low=df['low'], close=df['close'], window=14)
    df['adx'] = adx.adx()
    df['di_plus'] = adx.adx_pos()
    df['di_minus'] = adx.adx_neg()
    
    # PARAMETER 11 — CCI (COMMODITY CHANNEL INDEX)
    cci = CCIIndicator(high=df['high'], low=df['low'], close=df['close'], window=20)
    df['cci'] = cci.cci()
    
    # PARAMETER 12 — OBV (ON BALANCE VOLUME)
    obv = OnBalanceVolumeIndicator(close=df['close'], volume=df['volume'])
    df['obv'] = obv.on_balance_volume()
    
    # PARAMETER 13 — VWAP (VOLUME WEIGHTED AVERAGE PRICE)
    # VWAP = Σ(Typical Price * Volume) / Σ(Volume)
    # Computed dynamically for the recent session or rolling window. Here using a daily anchored approach or rolling 24h
    typical_price = (df['high'] + df['low'] + df['close']) / 3
    # Approximation of VWAP via rolling window for generic continuous timeframe
    df['vwap'] = (typical_price * df['volume']).rolling(window=24).sum() / df['volume'].rolling(window=24).sum()
    
    # PARAMETER 14 — HURST EXPONENT (Regime detection)
    def calculate_hurst(ts):
        if len(ts) < 20 or np.std(ts) == 0:
            return 0.5
        lags = range(2, min(20, len(ts)//2))
        tau = [np.sqrt(np.std(np.subtract(ts[lag:], ts[:-lag]))) for lag in lags]
        if np.any(np.isnan(tau)) or np.any(tau == 0):
            return 0.5
        try:
            poly = np.polyfit(np.log(lags), np.log(tau), 1)
            return poly[0] * 2.0
        except:
            return 0.5

    # Apply hurst over a rolling window (e.g. 100 periods)
    df['hurst'] = df['close'].rolling(window=100).apply(calculate_hurst, raw=True)
    df['hurst'] = df['hurst'].fillna(0.5)
    
    # PARAMETER 15 — AUTOCORRELATION
    df['autocorr'] = df['log_return'].rolling(window=30).apply(lambda x: x.autocorr(lag=1) if len(x)>1 else 0)
    
    # PARAMETER 16 — VOLUME RATIO
    df['volume_ma'] = df['volume'].rolling(window=20).mean()
    df['volume_ratio'] = df['volume'] / df['volume_ma'].replace(0, np.nan)
    
    # PARAMETER 17 — ICHIMOKU CLOUD
    ichimoku = IchimokuIndicator(high=df['high'], low=df['low'], window1=9, window2=26, window3=52)
    df['ichimoku_tenkan'] = ichimoku.ichimoku_conversion_line()
    df['ichimoku_kijun'] = ichimoku.ichimoku_base_line()
    df['ichimoku_span_a'] = ichimoku.ichimoku_span_a()
    df['ichimoku_span_b'] = ichimoku.ichimoku_span_b()
    
    # PARAMETER 18 — CHAIKIN MONEY FLOW (CMF)
    cmf = ChaikinMoneyFlowIndicator(high=df['high'], low=df['low'], close=df['close'], volume=df['volume'], window=20)
    df['cmf'] = cmf.chaikin_money_flow()

    # Fill NaNs generated by rolling functions
    df.fillna(method='bfill', inplace=True)
    df.fillna(0, inplace=True)
    
    # PARAMETER 19 & 20 are performance metrics (Kelly & Sharpe), evaluated by the RiskManager and BacktestEngine.
    
    # Define ML_FEATURES list containing input columns to be used for ML models
    ML_FEATURES = [
        'log_return', 'ema_fast', 'ema_slow', 'ema_major', 'volatility', 'zscore',
        'bb_width', 'bb_pct', 'rsi', 'macd', 'macd_hist', 'atr', 'stoch_k', 'stoch_d',
        'adx', 'cci', 'volume_ratio', 'hurst', 'autocorr', 'cmf',
        'ichimoku_tenkan', 'ichimoku_kijun'
    ]
    
    return df, ML_FEATURES
