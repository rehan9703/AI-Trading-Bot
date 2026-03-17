import { RSI, MACD } from './indicators';
import { Signal } from './types';

export class SignalEngine {
  evaluate(data: any[]): Signal {
    const rsi = RSI.calculate(data);
    const macd = MACD.calculate(data);

    if (rsi !== null && rsi < 30 && macd !== null && macd > 0) {
      return { symbol: 'BTCUSDT', signal: 'BUY', confidence: 0.8, indicator: 'RSI+MACD' };
    } else if (rsi !== null && rsi > 70 && macd !== null && macd < 0) {
      return { symbol: 'BTCUSDT', signal: 'SELL', confidence: 0.8, indicator: 'RSI+MACD' };
    }

    return { symbol: 'BTCUSDT', signal: 'HOLD', confidence: 0, indicator: 'NONE' };
  }
}
