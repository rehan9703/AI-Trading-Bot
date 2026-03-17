"""
Multi-Pair Strategy Engine
Orchestrates strategy computations across all symbols and identifies correlations.
"""

from strategy.engine import combined_signal
import config

class MultiPairEngine:
    """Manages signal generation across all symbols."""
    
    def run_all(self, data_dict, lstm_models, rf_models, ml_features):
        """
        Calculates signals for all pairs.
        Returns a dictionary mapping {symbol: result_dict}
        """
        results_dict = {}
        for symbol in config.SYMBOLS:
            if symbol not in data_dict or data_dict[symbol].empty:
                continue
                
            df = data_dict[symbol]
            lstm = lstm_models[symbol]
            rf = rf_models[symbol]
            
            lstm_signal, lstm_conf = lstm.predict(df, ml_features)
            rf_signal, rf_conf = rf.predict(df, ml_features)
            
            result = combined_signal(df, lstm_signal, lstm_conf, rf_signal, rf_conf)
            result['current_price'] = df['close'].iloc[-1]
            results_dict[symbol] = result
            
        return self.check_correlation(results_dict)

    def get_best_signal(self, results_dict):
        """
        Returns the symbol and result dict for the best opportunity.
        Ranks by absolute score.
        """
        valid_signals = {
            sym: res for sym, res in results_dict.items() 
            if res['signal'] in ['BUY', 'SELL']
        }
        
        if not valid_signals:
            return None, None
            
        # Sort by absolute score descending
        sorted_pairs = sorted(
            valid_signals.items(), 
            key=lambda item: abs(item[1]['score']), 
            reverse=True
        )
        
        best_symbol, best_result = sorted_pairs[0]
        return best_symbol, best_result

    def check_correlation(self, results_dict):
        """
        Adjusts signals based on cross-pair consensus (macro trend).
        """
        buy_count = sum(1 for r in results_dict.values() if r['signal'] == 'BUY')
        sell_count = sum(1 for r in results_dict.values() if r['signal'] == 'SELL')
        total = len(results_dict)
        
        if total == 0:
            return results_dict
            
        consensus = "MIXED"
        if buy_count / total >= 0.75:
            consensus = "MARKET_RALLY"
        elif sell_count / total >= 0.75:
            consensus = "MARKET_DOWNTREND"
            
        for symbol, res in results_dict.items():
            res['macro_consensus'] = consensus
            
            # Dampen signals that fight the macro trend
            if consensus == "MARKET_RALLY" and res['signal'] == "SELL":
                res['score'] *= 0.5
                if res['score'] > -config.MIN_SIGNAL_SCORE:
                    res['signal'] = "HOLD"
                    
            elif consensus == "MARKET_DOWNTREND" and res['signal'] == "BUY":
                res['score'] *= 0.5
                if res['score'] < config.MIN_SIGNAL_SCORE:
                    res['signal'] = "HOLD"
                    
        return results_dict
