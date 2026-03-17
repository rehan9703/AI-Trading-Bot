"""
Master Orchestrator
The main entry point for the AI Trading Bot. Ties all modules together.
"""

import time
import threading
from datetime import datetime
import traceback

import config
from data.engine import DataEngine
from models.features import add_all_features
from models.lstm_model import LSTMTradingModel
from models.ai_model import AITradingModel
from strategy.multi_engine import MultiPairEngine
from risk.manager import RiskManager
from execution.trader import Trader
from notifier.telegram import TelegramNotifier
from dashboard.app import start_dashboard, BOT_STATE, BOT_CONTROL

class TradingBot:
    """Master controller for the entire system."""
    
    def __init__(self):
        print("🤖 Initializing QuantEdge AI Trading Bot...")
        self.data_engine = DataEngine()
        self.risk_manager = RiskManager()
        self.trader = Trader(self.data_engine)
        self.telegram = TelegramNotifier()
        self.multi_engine = MultiPairEngine()
        
        self.lstm_models = {}
        self.rf_models = {}
        self.open_positions = {}  # symbol -> position dict
        
        for symbol in config.SYMBOLS:
            self.lstm_models[symbol] = LSTMTradingModel(symbol)
            self.rf_models[symbol] = AITradingModel(symbol)
            
        self.last_retrain = None
        self.start_time = datetime.utcnow()
        self.last_hourly_update = datetime.utcnow()
        
        # Determine features used for ML models
        # Initialize an empty list, it gets populated during initial training
        self.ml_features = []
        
        # Batch Trade Control
        self.is_batch_full = False
        
    def initial_training(self):
        """Train models on historical data before starting live trading."""
        print("\n" + "="*50)
        print("🧠 PHASE 1: INITIAL MODEL TRAINING")
        print("="*50)
        
        for symbol in config.SYMBOLS:
            print(f"\nFetching training data for {symbol}...")
            # For speed in simulation/startup, use mock or 1 year of real data
            if config.BINANCE_TESTNET and config.PAPER_TRADING:
                df = self.data_engine.generate_mock_data(n=2000)
            else:
                df = self.data_engine.get_historical_data(symbol, config.TIMEFRAME, years=1)
                
            df, self.ml_features = add_all_features(df)
            
            self.lstm_models[symbol].train(df, self.ml_features, verbose=True)
            self.rf_models[symbol].train(df, self.ml_features)
            
        self.last_retrain = datetime.utcnow()
        self.telegram.send("✅ <b>AI Models trained and ready.</b> Bot entering active trading phase.")
        print("\n✅ All models trained.")

    def maybe_retrain(self):
        """Check if it's time to retrain models with fresh data."""
        if not self.last_retrain:
            return
            
        hours_passed = (datetime.utcnow() - self.last_retrain).total_seconds() / 3600.0
        if hours_passed >= config.RETRAIN_INTERVAL_HOURS:
            print("🔄 Scheduled model retraining initiated...")
            self.initial_training()
            for symbol in config.SYMBOLS:
                # Notify accuracy
                acc = 0.85 # placeholder for actual accuracy retrieval if needed
                self.telegram.ai_retrained(symbol, acc)

    def run_once(self):
        """Single iteration of the main trading loop."""
        try:
            self.maybe_retrain()
            
            print(f"\n[{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}] Fetching fresh market data...")
            data_dict = self.data_engine.get_multi_pair_data(config.SYMBOLS, config.TIMEFRAME, limit=100)
            
            # Prepare processed data
            processed_data = {}
            current_prices = {}
            for symbol, df in data_dict.items():
                df_feat, _ = add_all_features(df)
                processed_data[symbol] = df_feat
                current_prices[symbol] = df_feat['close'].iloc[-1]
                
            # Get unified balance
            balance_info = self.trader.get_balance()
            current_balance = balance_info['total_usdt']
            
            # Check Drawdown limit
            dd_hit, dd_pct = self.risk_manager.is_drawdown_limit_hit(current_balance)
            if dd_hit:
                self.telegram.drawdown_alert(dd_pct, config.MAX_DRAWDOWN_PCT * 100, current_balance)
                print(f"🚨 CRITICAL DRAWDOWN ({dd_pct:.2f}%). Trading Paused.")
                time.sleep(300) # Sleep 5 mins
                return
                
            # Handle UI Controls
            if BOT_CONTROL["funds_to_add"] > 0:
                print(f"💵 UI: Adding {BOT_CONTROL['funds_to_add']} USDT to paper balance.")
                self.trader.paper_balances["USDT"] += BOT_CONTROL["funds_to_add"]
                BOT_CONTROL["funds_to_add"] = 0.0
            
            if BOT_CONTROL["funds_to_remove"] > 0:
                print(f"💵 UI: Removing {BOT_CONTROL['funds_to_remove']} USDT from paper balance.")
                self.trader.paper_balances["USDT"] -= BOT_CONTROL["funds_to_remove"]
                # Prevent negative balance
                self.trader.paper_balances["USDT"] = max(0, self.trader.paper_balances["USDT"])
                BOT_CONTROL["funds_to_remove"] = 0.0
                
            # Apply updated balance for calculations
            balance_info = self.trader.get_balance()
            current_balance = balance_info['total_usdt']
                
            # Step 1: Manage existing open positions
            closed_this_round = []
            for symbol, pos in list(self.open_positions.items()):
                price = current_prices[symbol]
                reason = self.risk_manager.check_exit(
                    price, pos['entry_price'], pos['side'], 
                    pos['stop_loss'], pos['take_profit']
                )
                
                if reason:
                    # Execute Close
                    close_qty = pos['qty']
                    close_side = "SELL" if pos['side'] == "BUY" else "BUY"
                    order = self.trader.place_order(close_side, symbol, price, close_qty)
                    
                    if order['status'] == "FILLED":
                        trade = self.risk_manager.record_trade(
                            pos['entry_price'], price, pos['side'], close_qty, reason
                        )
                        trade['symbol'] = symbol
                        self.telegram.trade_closed(trade, self.risk_manager.get_full_report())
                        del self.open_positions[symbol]
                        closed_this_round.append(symbol)
                        print(f"💰 Closed {symbol} ({reason}) at ${price:.2f}")

            # Step 2: Generate new signals
            signals_dict = self.multi_engine.run_all(
                processed_data, self.lstm_models, self.rf_models, self.ml_features
            )
            
            # Update Web Dashboard State (Before executing trades)
            self._update_dashboard_state(current_prices, signals_dict, current_balance)
            
            # Batch Status Logic
            if len(self.open_positions) == 0:
                self.is_batch_full = False
            elif len(self.open_positions) >= config.MAX_OPEN_TRADES:
                self.is_batch_full = True
            
            # Only consider opening new positions if we have capacity AND we are not paused AND batch is not full
            if not BOT_CONTROL["is_paused"] and not self.is_batch_full and len(self.open_positions) < config.MAX_OPEN_TRADES:
                best_symbol, best_signal = self.multi_engine.get_best_signal(signals_dict)
                
                # Check if we should execute
                if best_symbol and best_symbol not in self.open_positions and best_symbol not in closed_this_round:
                    price = current_prices[best_symbol]
                    atr = processed_data[best_symbol]['atr'].iloc[-1]
                    side = best_signal['signal']
                    
                    if side in ["BUY", "SELL"]: # Sanity check
                        sl, tp, rr = self.risk_manager.get_levels(price, side, atr)
                        
                        # Full account utilization (divide total balance evenly across max trades allowed)
                        risk_capital = (current_balance / config.MAX_OPEN_TRADES) * 0.98 # 2% buffer for fees/slippage
                        qty = risk_capital / price
                        
                        if qty > 0:
                            print(f"⚡ Executing {side} on {best_symbol} | QTY: {qty:.4f}")
                            order = self.trader.place_order(side, best_symbol, price, qty)
                            
                            if order['status'] == "FILLED":
                                self.open_positions[best_symbol] = {
                                    "symbol": best_symbol,
                                    "side": side,
                                    "entry_price": order['price'],
                                    "qty": order['qty'],
                                    "stop_loss": sl,
                                    "take_profit": tp,
                                    "time": datetime.utcnow().isoformat()
                                }
                                self.telegram.trade_signal(
                                    best_symbol, best_signal, sl, tp, rr, order['qty']
                                )
                                self._update_dashboard_state(current_prices, signals_dict, current_balance) # Re-update With Position

            # 3. Hourly Update
            hours_since_update = (datetime.utcnow() - self.last_hourly_update).total_seconds() / 3600.0
            if hours_since_update >= 1.0:
                self.telegram.hourly_update(
                    current_prices, len(self.open_positions), 
                    current_balance, self.risk_manager.get_full_report()
                )
                self.last_hourly_update = datetime.utcnow()
                
        except Exception as e:
            print(f"❌ CRITICAL ERROR in run_once: {e}")
            traceback.print_exc()
            self.telegram.error_alert(e)
            
    def _update_dashboard_state(self, prices, signals, balance):
        """Pushes current variables into the global dict for the Flask frontend."""
        BOT_STATE['prices'] = prices
        BOT_STATE['signals'] = signals
        BOT_STATE['balance'] = balance
        BOT_STATE['stats'] = self.risk_manager.get_full_report()
        BOT_STATE['last_update'] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        BOT_STATE['uptime_seconds'] = int((datetime.utcnow() - self.start_time).total_seconds())
        
        # Format open positions for table
        pos_list = []
        for sym, pos in self.open_positions.items():
            pos_list.append(pos)
        BOT_STATE['open_positions'] = pos_list

    def run(self):
        """The main execution thread."""
        print("="*50)
        print("🌐 STARTING MASTER ORCHESTRATOR")
        print("="*50)
        
        # 1. Notify Telegram
        self.telegram.bot_started(
            mode="PAPER" if config.PAPER_TRADING else "LIVE",
            pairs=config.SYMBOLS
        )
        
        # 2. Train Models
        try:
            self.initial_training()
        except Exception as e:
            print(f"❌ Initial training failed: {e}")
            print("Going to sleep for 60s and try again. Press Ctrl+C to abort.")
            time.sleep(60)
            return self.run()
            
        # 3. Start Flask Dashboard in background thread
        print(f"🖥️ Starting Web Dashboard on port {config.DASHBOARD_PORT}...")
        flask_thread = threading.Thread(target=start_dashboard, daemon=True)
        flask_thread.start()
        print(f"✅ Dashboard accessible at http://localhost:{config.DASHBOARD_PORT}")
        
        # 4. Main Event Loop
        print("\n🚀 Entering main trading loop...")
        while True:
            self.run_once()
            time.sleep(config.CHECK_INTERVAL_SECONDS)

if __name__ == "__main__":
    bot = TradingBot()
    bot.run()
