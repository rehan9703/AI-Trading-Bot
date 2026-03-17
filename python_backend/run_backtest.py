"""
Standalone backtest runner.
Executes the backtesting engine on simulated or historical data.
"""

from backtest.engine import run_backtest, plot_equity_curve

if __name__ == "__main__":
    print("Launching AI Trading Bot Backtester...")
    # Use mock data by default so it runs immediately without Binance API limits
    report = run_backtest(symbol="BTC/USDT", timeframe="1h", years=3, use_mock=True)
    plot_equity_curve()
    print("Done! Trade log saved to 'backtest/results/'")
