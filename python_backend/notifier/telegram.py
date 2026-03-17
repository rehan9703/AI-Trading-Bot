"""
Telegram Notification Engine
Sends richly formatted HTML alerts directly to a Telegram chat.
"""

import requests
import traceback
import config

class TelegramNotifier:
    """Handles Telegram API communication."""
    
    def __init__(self):
        self.token = config.TELEGRAM_TOKEN
        self.chat_id = config.TELEGRAM_CHAT_ID
        self.is_configured = bool(self.token and self.chat_id)
        if not self.is_configured:
            print("⚠️ Telegram NOT configured. Alerts will print to console only.")

    def send(self, text, parse_mode="HTML"):
        """Base send method."""
        if not self.is_configured:
            print(f"\n[TELEGRAM SIM] \n{text}\n")
            return
            
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True
        }
        try:
            requests.post(url, json=payload, timeout=5)
        except Exception as e:
            print(f"❌ Failed to send Telegram message: {e}")

    def bot_started(self, mode, pairs, version="1.0"):
        msg = (
            f"🚀 <b>AI Trading Bot Started</b> 🚀\n\n"
            f"<b>Version:</b> {version}\n"
            f"<b>Mode:</b> {mode}\n"
            f"<b>Pairs:</b> {', '.join(pairs)}\n"
            f"<b>Timeframe:</b> {config.TIMEFRAME}\n"
            f"<b>Dashboard:</b> http://localhost:{config.DASHBOARD_PORT}\n"
        )
        self.send(msg)

    def trade_signal(self, symbol, result, stop_loss, take_profit, rr, qty):
        signal = result.get('signal', 'UNKNOWN')
        icon = "🟢" if signal == "BUY" else "🔴"
        
        breakdown_str = "\n".join([f"  • {k}: {v}" for k,v in list(result.get('breakdown', {}).items())[:5]])
        
        msg = (
            f"{icon} <b>NEW SIGNAL: {symbol}</b> {icon}\n\n"
            f"<b>Action:</b> {signal}\n"
            f"<b>Price:</b> ${result.get('current_price', 0):.2f}\n"
            f"<b>Quantity:</b> {qty:.4f}\n"
            f"<b>Market Regime:</b> {result.get('regime', 'N/A')}\n\n"
            f"<b>Scores:</b>\n"
            f"• Quant Score: {result.get('score', 0)}\n"
            f"• LSTM Conf: {result.get('lstm_confidence', 0):.1f}%\n"
            f"• RF Conf: {result.get('rf_confidence', 0):.1f}%\n\n"
            f"<b>Risk Profile:</b>\n"
            f"• Stop Loss: ${stop_loss:.2f}\n"
            f"• Take Profit: ${take_profit:.2f}\n"
            f"• R/R Ratio: {rr:.2f}:1\n\n"
            f"<b>Top Indicators:</b>\n{breakdown_str}"
        )
        self.send(msg)

    def trade_closed(self, trade, stats):
        reason = trade.get('reason', 'UNKNOWN')
        icon = "🏁"
        if reason == "TAKE_PROFIT": icon = "🎯"
        elif reason == "STOP_LOSS": icon = "🛑"
        
        pnl = trade.get('pnl_usdt', 0)
        pnl_icon = "🟩" if pnl > 0 else "🟥"
        
        msg = (
            f"{icon} <b>TRADE CLOSED: {trade.get('symbol', 'UNKNOWN')}</b>\n\n"
            f"<b>Reason:</b> {reason}\n"
            f"<b>Side:</b> {trade.get('side', 'N/A')}\n"
            f"<b>Entry:</b> ${trade.get('entry_price', 0):.2f}\n"
            f"<b>Exit:</b> ${trade.get('exit_price', 0):.2f}\n\n"
            f"{pnl_icon} <b>PnL:</b> ${pnl:.2f} ({trade.get('pnl_pct', 0)*100:.2f}%)\n\n"
            f"<b>Bot Stats:</b>\n"
            f"• Win Rate: {stats.get('win_rate', 0)}%\n"
            f"• Total PnL: ${stats.get('total_pnl', 0):.2f}\n"
            f"• Sharpe: {stats.get('sharpe_ratio', 0)}\n"
        )
        self.send(msg)

    def hourly_update(self, prices_dict, active_count, balance, stats):
        prices_str = "\n".join([f"• {sym}: ${p:.2f}" for sym, p in prices_dict.items()])
        
        msg = (
            f"⏱ <b>HOURLY HEARTBEAT</b> ⏱\n\n"
            f"<b>Balance:</b> ${balance:.2f}\n"
            f"<b>Active Trades:</b> {active_count}\n"
            f"<b>Total trades:</b> {stats.get('total_trades', 0)}\n"
            f"<b>Global PnL:</b> ${stats.get('total_pnl', 0):.2f}\n\n"
            f"<b>Current Prices:</b>\n{prices_str}\n"
        )
        self.send(msg)

    def drawdown_alert(self, current_dd, limit, balance):
        msg = (
            f"🚨 <b>WARNING: HIGH DRAWDOWN</b> 🚨\n\n"
            f"Current Drawdown: <b>{current_dd:.2f}%</b>\n"
            f"Max Allowed Limit: <b>{limit:.2f}%</b>\n"
            f"Current Balance: <b>${balance:.2f}</b>\n\n"
            f"<i>Bot will pause opening new trades until reviewed.</i>"
        )
        self.send(msg)

    def ai_retrained(self, symbol, new_acc):
        msg = (
            f"🧠 <b>AI MODELS RETRAINED</b> 🧠\n\n"
            f"<b>Symbol:</b> {symbol}\n"
            f"<b>New Test Accuracy:</b> {new_acc*100:.2f}%\n"
            f"Models updated with latest market data."
        )
        self.send(msg)

    def error_alert(self, e):
        tb_str = "".join(traceback.format_tb(e.__traceback__)[-5:])
        msg = (
            f"❌ <b>CRITICAL SYSTEM ERROR</b> ❌\n\n"
            f"<b>Error:</b> {type(e).__name__}: {str(e)}\n\n"
            f"<b>Traceback (last 5 lines):</b>\n<pre>{tb_str}</pre>"
        )
        self.send(msg)
