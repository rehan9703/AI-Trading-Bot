"""
Strategy Engine
Computes single-pair signals combining 20 quant parameters and AI models.
"""

import pandas as pd
import config

def get_market_regime(df):
    """
    Classifies the current market regime based on Hurst and ADX.
    Hurst: > 0.55 = Trending, < 0.45 = Mean Reverting
    ADX: > 25 = Strong Trend, < 20 = Choppy/Range
    """
    last = df.iloc[-1]
    hurst = last['hurst']
    adx = last['adx']
    
    if hurst > 0.55 and adx > config.ADX_TREND_THRESHOLD:
        regime = "TRENDING"
        confidence = min(100, (hurst - 0.5) * 200)
    elif hurst < 0.45 and adx < 20:
        regime = "MEAN_REVERTING"
        confidence = min(100, (0.5 - hurst) * 200)
    else:
        regime = "MIXED"
        confidence = 50.0
        
    return regime, confidence

def quant_score(df):
    """
    Weighted scoring system across all 20 parameters.
    Returns: (signal, score, breakdown_dict)
    """
    last = df.iloc[-1]
    prev = df.iloc[-2]
    score = 0.0
    breakdown = {}
    
    # 1. EMA Trend (+/- 1.5)
    ema_score = 1.5 if last['ema_fast'] > last['ema_slow'] else -1.5
    score += ema_score
    breakdown['EMA Trend'] = round(ema_score, 2)
    
    # 2. EMA Major (+/- 1.0)
    major_score = 1.0 if last['close'] > last['ema_major'] else -1.0
    score += major_score
    breakdown['EMA Major'] = round(major_score, 2)
    
    # 3. RSI (+/- 2.0)
    rsi_score = 0.0
    if last['rsi'] < config.RSI_OVERSOLD:
        rsi_score = 2.0
    elif last['rsi'] > config.RSI_OVERBOUGHT:
        rsi_score = -2.0
    elif 45 <= last['rsi'] <= 55:
        rsi_score = 0.5
    score += rsi_score
    breakdown['RSI'] = round(rsi_score, 2)
    
    # 4. MACD Crossover (+/- 2.0)
    macd_score = 0.0
    if prev['macd'] < prev['macd_signal'] and last['macd'] > last['macd_signal']:
        macd_score = 2.0
    elif prev['macd'] > prev['macd_signal'] and last['macd'] < last['macd_signal']:
        macd_score = -2.0
    elif last['macd'] > 0:
        macd_score = 0.5
    elif last['macd'] < 0:
        macd_score = -0.5
    score += macd_score
    breakdown['MACD'] = round(macd_score, 2)
    
    # 5. Z-Score (+/- 2.0)
    z_score = 0.0
    if last['zscore'] < config.ZSCORE_BUY_THRESHOLD:
        z_score = 2.0
    elif last['zscore'] > config.ZSCORE_SELL_THRESHOLD:
        z_score = -2.0
    score += z_score
    breakdown['Z-Score'] = round(z_score, 2)
    
    # 6. Bollinger Bands (+/- 1.5)
    bb_score = 0.0
    if last['close'] < last['bb_lower']:
        bb_score = 1.5
    elif last['close'] > last['bb_upper']:
        bb_score = -1.5
    score += bb_score
    breakdown['Bollinger'] = round(bb_score, 2)
    
    # 7. Stochastic (+/- 1.5)
    stoch_score = 0.0
    if last['stoch_k'] < 20 and last['stoch_k'] > last['stoch_d']:
        stoch_score = 1.5
    elif last['stoch_k'] > 80 and last['stoch_k'] < last['stoch_d']:
        stoch_score = -1.5
    score += stoch_score
    breakdown['Stochastic'] = round(stoch_score, 2)
    
    # 8. CCI (+/- 1.0)
    cci_score = 1.0 if last['cci'] < -100 else (-1.0 if last['cci'] > 100 else 0)
    score += cci_score
    breakdown['CCI'] = round(cci_score, 2)
    
    # 9. CMF (+/- 1.0)
    cmf_score = 1.0 if last['cmf'] > 0.05 else (-1.0 if last['cmf'] < -0.05 else 0)
    score += cmf_score
    breakdown['CMF'] = round(cmf_score, 2)
    
    # 10. Ichimoku (+/- 1.0)
    ichi_score = 0.0
    if last['close'] > last['ichimoku_span_a'] and last['close'] > last['ichimoku_span_b']:
        ichi_score = 1.0
    elif last['close'] < last['ichimoku_span_a'] and last['close'] < last['ichimoku_span_b']:
        ichi_score = -1.0
    score += ichi_score
    breakdown['Ichimoku'] = round(ichi_score, 2)
    
    # MULTIPLIERS
    # ADX Multiplier
    if last['adx'] > 30:
        score *= 1.2
    elif last['adx'] < 15:
        score *= 0.5
        
    # Hurst Multiplier
    if last['hurst'] > 0.6:
        # Boost trend indicators
        score += (ema_score + major_score) * 0.2
    elif last['hurst'] < 0.4:
        # Boost mean reversion
        score += (rsi_score + z_score) * 0.2
        
    # Volume Multiplier
    if last['volume_ratio'] > 1.5:
        score *= 1.2
    elif last['volume_ratio'] < 0.5:
        score *= 0.8
        
    score = round(score, 2)
    
    if score >= config.MIN_SIGNAL_SCORE:
        signal = "BUY"
    elif score <= -config.MIN_SIGNAL_SCORE:
        signal = "SELL"
    else:
        signal = "HOLD"
        
    return signal, score, breakdown

def combined_signal(df, lstm_signal, lstm_conf, rf_signal, rf_conf):
    """
    Combines quantitative score with AI model predictions.
    Returns dictionary with all metrics.
    """
    q_signal, q_score, breakdown = quant_score(df)
    regime, r_conf = get_market_regime(df)
    
    # Determine consensus
    final_score = q_score
    
    # Adjust score based on AI agreement
    if (q_signal == "BUY" and lstm_signal == "BUY") or (q_signal == "SELL" and lstm_signal == "SELL"):
        final_score *= 1.3  # Boost by 30%
    elif lstm_signal != q_signal and lstm_signal != "HOLD":
        final_score *= 0.7  # Reduce by 30% if disagreement
        
    if (q_signal == "BUY" and rf_signal == "BUY") or (q_signal == "SELL" and rf_signal == "SELL"):
        final_score *= 1.1  # Boost by 10%
    elif rf_signal != q_signal and rf_signal != "HOLD":
        final_score *= 0.8  # Reduce by 20%
        
    final_score = round(final_score, 2)
    
    # Recalculate signal based on adjusted score
    if final_score >= config.MIN_SIGNAL_SCORE:
        final_signal = "BUY"
    elif final_score <= -config.MIN_SIGNAL_SCORE:
        final_signal = "SELL"
    else:
        final_signal = "HOLD"
        
    return {
        "signal": final_signal,
        "score": final_score,
        "quant_base_signal": q_signal,
        "quant_base_score": q_score,
        "lstm_signal": lstm_signal,
        "lstm_confidence": lstm_conf,
        "rf_signal": rf_signal,
        "rf_confidence": rf_conf,
        "regime": regime,
        "regime_confidence": round(r_conf, 2),
        "breakdown": breakdown,
        "rsi": round(df['rsi'].iloc[-1], 2),
        "zscore": round(df['zscore'].iloc[-1], 2),
        "hurst": round(df['hurst'].iloc[-1], 2)
    }
