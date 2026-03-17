"""
Risk Management Engine
Handles position sizing, stop losses, and drawdown limitations.
"""

import numpy as np
import config

class RiskManager:
    """Institutional-grade risk management."""
    
    def __init__(self):
        self.peak_balance = config.PAPER_BALANCE_USDT
        self.trade_history = []
        
    def get_levels(self, price, side, atr):
        """
        Calculates Stop Loss and Take Profit purely based on volatility (ATR).
        Returns: (stop_loss, take_profit, risk_reward_ratio)
        """
        stop_dist = atr * config.STOP_LOSS_ATR_MULT
        profit_dist = atr * config.TAKE_PROFIT_ATR_MULT
        
        if side == "BUY":
            stop_loss = price - stop_dist
            take_profit = price + profit_dist
        elif side == "SELL":
            stop_loss = price + stop_dist
            take_profit = price - profit_dist
        else:
            return None, None, 0.0
            
        rr_ratio = profit_dist / stop_dist
        return stop_loss, take_profit, rr_ratio

    def kelly_position_size(self, balance, price, win_rate, rr_ratio):
        """
        Kelly Criterion for optimal position sizing.
        Formula: f* = (b*p - q) / b
        """
        # Default safety values if no history
        if win_rate == 0 or len(self.trade_history) < 10:
            p = 0.50
            b = 1.5
        else:
            p = win_rate
            b = rr_ratio
            
        q = 1.0 - p
        
        if b <= 0:
            f_star = 0
        else:
            f_star = (b * p - q) / b
            
        # If mathematically negative, risk nothing (no edge)
        if f_star <= 0:
            return 0.0, 0.0
            
        # Apply fractional Kelly (e.g., quarter Kelly)
        f = f_star * config.KELLY_FRACTION
        
        # Hard limits
        f = min(f, 0.10) # Max 10% of balance per trade
        f = max(f, 0.01) # Min 1% if system says trade
        
        risk_amount_usdt = balance * f
        quantity_in_asset = risk_amount_usdt / price
        
        return quantity_in_asset, f * 100.0

    def check_exit(self, current_price, entry_price, side, stop_loss, take_profit):
        """Monitors active trades for stops/targets."""
        if side == "BUY":
            if current_price <= stop_loss:
                return "STOP_LOSS"
            if current_price >= take_profit:
                return "TAKE_PROFIT"
        elif side == "SELL":
            if current_price >= stop_loss:
                return "STOP_LOSS"
            if current_price <= take_profit:
                return "TAKE_PROFIT"
                
        return None

    def is_drawdown_limit_hit(self, current_balance):
        """Circuit breaker for major bad streaks."""
        if current_balance > self.peak_balance:
            self.peak_balance = current_balance
            
        drawdown = (self.peak_balance - current_balance) / self.peak_balance
        
        if drawdown >= config.MAX_DRAWDOWN_PCT:
            return True, drawdown * 100.0
        return False, drawdown * 100.0

    def record_trade(self, entry_price, exit_price, side, qty, reason):
        """Log trade results for performance tracking."""
        if side == "BUY":
            pnl = (exit_price - entry_price) * qty
            pnl_pct = (exit_price - entry_price) / entry_price
        else:
            pnl = (entry_price - exit_price) * qty
            pnl_pct = (entry_price - exit_price) / entry_price
            
        trade = {
            "entry_price": entry_price,
            "exit_price": exit_price,
            "side": side,
            "qty": qty,
            "pnl_usdt": pnl,
            "pnl_pct": pnl_pct,
            "reason": reason
        }
        
        self.trade_history.append(trade)
        return trade

    def calculate_sharpe_ratio(self):
        if len(self.trade_history) < 5:
            return 0.0
        returns = np.array([t['pnl_pct'] for t in self.trade_history])
        std = np.std(returns)
        if std == 0:
            return 0.0
        sharpe = (np.mean(returns) / std) * np.sqrt(252) # Assuming daily or scaling applies
        return round(sharpe, 4)

    def calculate_sortino_ratio(self):
        if len(self.trade_history) < 5:
            return 0.0
        returns = np.array([t['pnl_pct'] for t in self.trade_history])
        neg_returns = returns[returns < 0]
        std_downside = np.std(neg_returns) if len(neg_returns) > 0 else 0
        if std_downside == 0:
            return self.calculate_sharpe_ratio()
        sortino = (np.mean(returns) / std_downside) * np.sqrt(252)
        return round(sortino, 4)

    def calculate_expectancy(self):
        if len(self.trade_history) == 0:
            return 0.0
            
        wins = [t['pnl_usdt'] for t in self.trade_history if t['pnl_usdt'] > 0]
        losses = [abs(t['pnl_usdt']) for t in self.trade_history if t['pnl_usdt'] <= 0]
        
        win_rate = len(wins) / len(self.trade_history)
        loss_rate = 1.0 - win_rate
        
        avg_win = np.mean(wins) if wins else 0
        avg_loss = np.mean(losses) if losses else 0
        
        expectancy = (win_rate * avg_win) - (loss_rate * avg_loss)
        return round(expectancy, 2)

    def get_full_report(self):
        """Generates dictionary with all system performance metrics."""
        wins = [t for t in self.trade_history if t['pnl_usdt'] > 0]
        losses = [t for t in self.trade_history if t['pnl_usdt'] <= 0]
        
        total_pnl = sum(t['pnl_usdt'] for t in self.trade_history)
        win_rate = len(wins) / len(self.trade_history) if self.trade_history else 0
        
        avg_win = np.mean([t['pnl_usdt'] for t in wins]) if wins else 0
        avg_loss = abs(np.mean([t['pnl_usdt'] for t in losses])) if losses else 0
        
        profit_factor = sum([t['pnl_usdt'] for t in wins]) / sum([abs(t['pnl_usdt']) for t in losses]) if losses and sum([abs(t['pnl_usdt']) for t in losses]) > 0 else float('inf')
        
        return {
            "total_trades": len(self.trade_history),
            "win_rate": round(win_rate * 100, 2),
            "total_pnl": round(total_pnl, 2),
            "avg_win_usdt": round(avg_win, 2),
            "avg_loss_usdt": round(avg_loss, 2),
            "largest_win": round(max([t['pnl_usdt'] for t in wins] + [0]), 2),
            "largest_loss": round(min([t['pnl_usdt'] for t in losses] + [0]), 2),
            "sharpe_ratio": self.calculate_sharpe_ratio(),
            "sortino_ratio": self.calculate_sortino_ratio(),
            "expectancy_usdt": self.calculate_expectancy(),
            "profit_factor": round(profit_factor, 2)
        }
