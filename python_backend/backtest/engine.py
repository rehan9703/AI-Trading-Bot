"""
Walk-Forward Backtesting Engine
Simulates the trading strategy over historical data in a step-by-step manner.
"""

import os
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import config
from data.engine import DataEngine
from models.features import add_all_features
from strategy.engine import quant_score
from risk.manager import RiskManager

def run_backtest(symbol="BTC/USDT", timeframe="1h", years=3, use_mock=True):
    print(f"🔄 Starting backtest for {symbol} over {years} years...")
    data_engine = DataEngine()
    
    if use_mock:
        raw_df = data_engine.generate_mock_data(n=max(2000, 365 * 24 * years))
    else:
        raw_df = data_engine.get_historical_data(symbol, timeframe, years)
        
    df, ml_features = add_all_features(raw_df)
    
    print(f"📊 Processed {len(df)} candles for {symbol}.")
    print("🚀 Running Walk-Forward Simulation...")
    
    balance = config.PAPER_BALANCE_USDT
    position = None
    entry_price, stop_loss, take_profit, side, qty = None, None, None, None, 0.0
    equity_curve = [balance]
    risk_manager = RiskManager()
    
    # Start loop after enough history for all indicators (LSTM needs 60, MACD needs 26, Hurst needs 100)
    start_idx = 100
    
    for i in range(start_idx, len(df)):
        slice_df = df.iloc[:i+1]
        current_candle = slice_df.iloc[-1]
        current_price = current_candle['close']
        atr = current_candle['atr']
        
        # 1. Manage existing position
        if position == 'OPEN':
            exit_reason = risk_manager.check_exit(current_price, entry_price, side, stop_loss, take_profit)
            
            # Check for trailing stop or manual signal override
            # E.g., if trend reverses hard => exit early
            # Simplified backtest exit: hard stops or targets
            if exit_reason:
                risk_manager.record_trade(entry_price, current_price, side, qty, exit_reason)
                if side == "BUY":
                    balance += (current_price - entry_price) * qty
                else:
                    balance += (entry_price - current_price) * qty
                position = None
                
        # 2. Look for new entries if flat
        if position is None:
            # For backtesting speed without full ML overhead, we rely on the robust quant_score
            # In real execution, we incorporate LSTM/RF predictions as well.
            signal, score, breakdown = quant_score(slice_df)
            
            if signal in ["BUY", "SELL"]:
                side = signal
                entry_price = current_price
                stop_loss, take_profit, rr_ratio = risk_manager.get_levels(entry_price, side, atr)
                
                win_rate_calc = risk_manager.get_full_report()['win_rate'] / 100.0
                qty, _ = risk_manager.kelly_position_size(balance, entry_price, win_rate_calc, rr_ratio)
                
                if qty > 0:
                    position = 'OPEN'
                    
        equity_curve.append(balance)
        
    # Force close at end
    if position == 'OPEN':
        risk_manager.record_trade(entry_price, df['close'].iloc[-1], side, qty, "END_OF_BACKTEST")
        if side == "BUY":
            balance += (df['close'].iloc[-1] - entry_price) * qty
        else:
            balance += (entry_price - df['close'].iloc[-1]) * qty
            
    # Compile Analytics
    report = risk_manager.get_full_report()
    report['final_balance_usdt'] = round(balance, 2)
    report['total_return_pct'] = round((balance - config.PAPER_BALANCE_USDT) / config.PAPER_BALANCE_USDT * 100.0, 2)
    
    try:
        cagr = (balance / config.PAPER_BALANCE_USDT) ** (1 / max(1, years)) - 1
    except:
        cagr = 0
    report['cagr'] = round(cagr * 100.0, 2)

    # Calculate Max Drawdown from equity curve
    equity_arr = np.array(equity_curve)
    peaks = np.maximum.accumulate(equity_arr)
    drawdowns = (peaks - equity_arr) / peaks
    report['max_drawdown_pct'] = round(np.max(drawdowns) * 100.0, 2)
    
    # Save Results
    os.makedirs('backtest/results', exist_ok=True)
    pd.DataFrame(risk_manager.trade_history).to_csv('backtest/results/trade_log.csv', index=False)
    pd.DataFrame(equity_curve, columns=['equity']).to_csv('backtest/results/equity_curve.csv', index=False)
    
    print("\n" + "="*50)
    print(f"📈 BACKTEST RESULTS: {symbol}")
    print("="*50)
    print(f"Total Trades:      {report['total_trades']}")
    print(f"Win Rate:          {report['win_rate']}%")
    print(f"Total Return:      {report['total_return_pct']}%")
    print(f"Final Balance:     ${report['final_balance_usdt']}")
    print(f"Sharpe Ratio:      {report['sharpe_ratio']}")
    print(f"Sortino Ratio:     {report['sortino_ratio']}")
    print(f"Max Drawdown:      {report['max_drawdown_pct']}%")
    print(f"Profit Factor:     {report['profit_factor']}")
    print(f"Expectancy:        ${report['expectancy_usdt']} per trade")
    print(f"CAGR:              {report['cagr']}%")
    print("="*50)
    
    return report

def plot_equity_curve():
    """Generates an equity curve chart."""
    if os.path.exists('backtest/results/equity_curve.csv'):
        df = pd.read_csv('backtest/results/equity_curve.csv')
        plt.figure(figsize=(10, 5))
        plt.plot(df['equity'], label='Equity', color='blue')
        plt.title('Backtest Equity Curve')
        plt.xlabel('Trades / Periods')
        plt.ylabel('Balance (USDT)')
        plt.grid(True)
        plt.legend()
        plt.savefig('backtest/results/equity_curve.png')
        print("📊 Equity curve plot saved to backtest/results/equity_curve.png")
