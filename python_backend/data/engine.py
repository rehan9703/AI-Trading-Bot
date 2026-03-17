"""
Data Engine
Handles fetching historical and live OHLCV data from Binance.
Also provides mock data generation for testing.
"""

import ccxt
import pandas as pd
import numpy as np
import time
from datetime import datetime
import config

class DataEngine:
    """Manages connection to exchange and data retrieval."""
    
    def __init__(self):
        """Initialize the CCXT exchange connection."""
        self.exchange = self.get_exchange()
        
    def get_exchange(self):
        """Configure and return the CCXT Binance instance."""
        exchange_class = getattr(ccxt, 'binance')
        exchange = exchange_class({
            'apiKey': config.BINANCE_API_KEY,
            'secret': config.BINANCE_SECRET_KEY,
            'enableRateLimit': True,
            'options': {'defaultType': 'spot'}
        })
        
        if config.BINANCE_TESTNET:
            exchange.set_sandbox_mode(True)
            
        return exchange

    def get_ohlcv(self, symbol, timeframe, limit):
        """Fetch OHLCV data for a single symbol."""
        try:
            ohlcv = self.exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
            df = pd.DataFrame(ohlcv, columns=['time', 'open', 'high', 'low', 'close', 'volume'])
            df['time'] = pd.to_datetime(df['time'], unit='ms')
            df.set_index('time', inplace=True)
            
            # Ensure all columns are float64
            for col in ['open', 'high', 'low', 'close', 'volume']:
                df[col] = df[col].astype(np.float64)
                
            return df
        except Exception as e:
            print(f"❌ Error fetching {symbol} from Binance: {e}")
            print(f"🔄 Falling back to generate_mock_data() for {symbol}")
            return self.generate_mock_data(limit)

    def get_multi_pair_data(self, symbols, timeframe, limit):
        """Fetch OHLCV for multiple pairs."""
        data_dict = {}
        for symbol in symbols:
            df = self.get_ohlcv(symbol, timeframe, limit)
            data_dict[symbol] = df
            time.sleep(0.1) # Respect rate limits
        return data_dict

    def get_historical_data(self, symbol, timeframe, years):
        """Fetch complete historical dataset for a given number of years."""
        try:
            now = self.exchange.milliseconds()
            since = now - (years * 365 * 24 * 3600 * 1000)
            
            all_ohlcv = []
            while since < now:
                ohlcv_chunk = self.exchange.fetch_ohlcv(symbol, timeframe, since=since, limit=1000)
                if not ohlcv_chunk:
                    break
                since = ohlcv_chunk[-1][0] + 1
                all_ohlcv.extend(ohlcv_chunk)
                time.sleep(0.5) # Rate limit padding
                print(f"🔄 Fetched chunk for {symbol}, ending at {pd.to_datetime(since, unit='ms')}")
            
            df = pd.DataFrame(all_ohlcv, columns=['time', 'open', 'high', 'low', 'close', 'volume'])
            df['time'] = pd.to_datetime(df['time'], unit='ms')
            df.drop_duplicates(subset=['time'], keep='last', inplace=True)
            df.set_index('time', inplace=True)
            
            for col in ['open', 'high', 'low', 'close', 'volume']:
                df[col] = df[col].astype(np.float64)
                
            return df.sort_index()
            
        except Exception as e:
            print(f"❌ Error fetching historical data for {symbol}: {e}")
            return self.generate_mock_data(n=max(500, years * 365 * 24))

    def generate_mock_data(self, n=500):
        """Generate realistic synthetic OHLCV data using Geometric Brownian Motion."""
        np.random.seed(42)  # For reproducibility per run
        start_price = 45000.0
        volatility = 0.015
        
        # Start time typically back n hours from now depending on timeframe
        # Assuming 1h timeframe for mock
        dates = pd.date_range(end=datetime.now(), periods=n, freq='1h')
        
        returns = np.random.normal(0, volatility, n)
        prices = start_price * np.exp(np.cumsum(returns))
        
        # Add random noise for open, high, low
        open_p = prices * (1 + np.random.normal(0, 0.002, n))
        close_p = prices
        high_p = np.maximum(open_p, close_p) * (1 + np.abs(np.random.normal(0, 0.005, n)))
        low_p = np.minimum(open_p, close_p) * (1 - np.abs(np.random.normal(0, 0.005, n)))
        volume = np.random.lognormal(mean=5, sigma=1, size=n) * 1000
        
        df = pd.DataFrame({
            'open': open_p,
            'high': high_p,
            'low': low_p,
            'close': close_p,
            'volume': volume
        }, index=dates)
        
        for col in ['open', 'high', 'low', 'close', 'volume']:
            df[col] = df[col].astype(np.float64)
            
        return df

    def get_current_price(self, symbol):
        """Fetch real-time current price."""
        try:
            ticker = self.exchange.fetch_ticker(symbol)
            return float(ticker['last'])
        except Exception as e:
            print(f"❌ Error fetching current price for {symbol}: {e}")
            return None
