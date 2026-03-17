"""
Trader Execution Engine
Handles placing paper orders and live Binance orders cleanly.
"""

import time
from datetime import datetime
import ccxt
import config

class Trader:
    """Order Execution Engine."""

    def __init__(self, data_engine):
        self.mode = "PAPER" if config.PAPER_TRADING else "LIVE"
        self.exchange = data_engine.exchange
        
        # Simulated balances for paper trading
        self.paper_balances = {
            "USDT": config.PAPER_BALANCE_USDT
        }
        for symbol in config.SYMBOLS:
            asset = symbol.split('/')[0]
            self.paper_balances[asset] = 0.0
            
        print(f"✅ Trader initialized in {self.mode} mode.")

    def place_order(self, signal, symbol, price, qty):
        """Entry point for executing an order."""
        if self.mode == "PAPER":
            return self.paper_order(signal, symbol, price, qty)
        else:
            return self.live_order(signal, symbol, qty)

    def paper_order(self, signal, symbol, price, qty):
        """Simulates placing an order and tracks virtual balance."""
        asset, quote = symbol.split('/')
        cost = price * qty
        
        status = "FILLED"
        
        if signal == "BUY":
            if self.paper_balances[quote] >= cost:
                self.paper_balances[quote] -= cost
                self.paper_balances[asset] += qty
            else:
                print(f"❌ PAPER: Insufficient {quote} balance for BUY.")
                status = "FAILED"
        elif signal == "SELL":
            # For backtesting/paper trading we allow shorting internally by letting balance go negative
            # Or if it's spot, we assume we just sell what we have. 
            # We will assume Futures/Margin capabilities in paper mode.
            self.paper_balances[quote] += cost
            self.paper_balances[asset] -= qty
            
        order_dict = {
            "status": status,
            "side": signal,
            "symbol": symbol,
            "price": price,
            "qty": qty,
            "cost": cost if signal == "BUY" else -cost,
            "timestamp": datetime.utcnow().isoformat(),
            "balance": self.paper_balances[quote]
        }
        return order_dict

    def live_order(self, signal, symbol, qty):
        """Places a real market order on Binance via ccxt."""
        try:
            if signal == "BUY":
                order = self.exchange.create_market_buy_order(symbol, qty)
            elif signal == "SELL":
                order = self.exchange.create_market_sell_order(symbol, qty)
            else:
                return {"status": "FAILED", "error": "Invalid Signal"}
                
            return {
                "status": "FILLED",
                "side": signal,
                "symbol": symbol,
                "price": order.get('average', order.get('price')),
                "qty": order['filled'],
                "cost": order['cost'],
                "timestamp": order['datetime'],
                "balance": self.get_balance()['USDT']
            }
            
        except ccxt.InsufficientFunds as e:
            print(f"❌ LIVE: Insufficient Funds: {e}")
            return {"status": "FAILED", "error": "Insufficient Funds"}
        except ccxt.NetworkError as e:
            print(f"⚠️ LIVE: Network Error, retrying: {e}")
            time.sleep(2)
            # Basic 1-retry fallback
            return self.live_order(signal, symbol, qty)
        except ccxt.ExchangeError as e:
            print(f"❌ LIVE: Exchange Error: {e}")
            return {"status": "FAILED", "error": str(e)}
        except Exception as e:
            print(f"❌ LIVE: Unexpected Error: {e}")
            return {"status": "FAILED", "error": str(e)}

    def get_balance(self):
        """Returns unified balance dict."""
        if self.mode == "PAPER":
            bal = self.paper_balances.copy()
            bal['total_usdt'] = bal['USDT']
            bal['mode'] = "PAPER"
            return bal
        else:
            try:
                raw_bal = self.exchange.fetch_balance()
                bal = {
                    "USDT": raw_bal['USDT']['free'] if 'USDT' in raw_bal else 0.0,
                    "total_usdt": raw_bal['USDT']['total'] if 'USDT' in raw_bal else 0.0,
                    "mode": "LIVE"
                }
                for symbol in config.SYMBOLS:
                    asset = symbol.split('/')[0]
                    bal[asset] = raw_bal[asset]['free'] if asset in raw_bal else 0.0
                return bal
            except Exception as e:
                print(f"❌ Error fetching live balance: {e}")
                return {"mode": "LIVE_ERROR", "USDT": 0.0}

    def get_open_orders(self, symbol):
        if self.mode == "LIVE":
            try:
                return self.exchange.fetch_open_orders(symbol)
            except:
                return []
        return []
