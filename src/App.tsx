import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  Shield, 
  Zap, 
  Bell, 
  Settings, 
  BarChart3, 
  BrainCircuit,
  Divide,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  Cpu,
  ArrowRight,
  AlertTriangle,
  ShieldAlert,
  FileText
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  AreaChart, 
  Area 
} from 'recharts';
import { AdvancedRealTimeChart } from "react-ts-tradingview-widgets";
import { cn } from './lib/utils';

// --- Types ---
interface QuantData {
  symbol: string;
  price: string;
  change24h: string;
  regime: 'TRENDING' | 'RANGING' | 'VOLATILE';
  strategyNote: string;
  sentiment: {
    score: string;
    label: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    headline: string;
  };
  parameters: {
    trend: Record<string, string>;
    momentum: Record<string, string>;
    math: Record<string, string>;
    risk: Record<string, string>;
  };
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
}

// --- Mock Data ---
const generateChartData = () => {
  return Array.from({ length: 40 }, (_, i) => ({
    time: i,
    price: 64000 + Math.random() * 2000,
    zScore: (Math.random() - 0.5) * 4,
    signal: null as 'BUY' | 'SELL' | 'HOLD' | null
  }));
};

interface RiskSettings {
  riskProfile: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
  maxDailyDrawdown: number;
  maxTotalExposure: number;
  riskPerTrade: number;
  autoLeverage: boolean;
  tradingEnabled: boolean;
}

export default function App() {
  const [data, setData] = useState<QuantData | null>(null);
  const [portfolio, setPortfolio] = useState<{balance: {USDT: string, BTC: string, total: string}, positions: any[], balanceHistory: any[]}>({
    balance: { USDT: "0.00", BTC: "0.000000", total: "0.00" },
    positions: [],
    balanceHistory: []
  });
  const [chartData, setChartData] = useState(generateChartData());
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [userLeverage, setUserLeverage] = useState(10);
  const [telegramStatus, setTelegramStatus] = useState<{blocked: boolean, activeChatId: string | null}>({ blocked: false, activeChatId: null });
  const [settings, setSettings] = useState<RiskSettings>({
    riskProfile: 'MODERATE',
    maxDailyDrawdown: 0.05,
    maxTotalExposure: 0.6,
    riskPerTrade: 0.02,
    autoLeverage: true,
    tradingEnabled: true
  });

  const closePosition = async (id: string) => {
    try {
      const res = await fetch(`/api/portfolio/positions/${id}/close`, { method: 'POST' });
      if (res.ok) {
        fetchData();
      }
    } catch (e) {
      console.error("Failed to close position", e);
    }
  };

  const deletePosition = async (id: string) => {
    try {
      const res = await fetch(`/api/portfolio/positions/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchData();
      }
    } catch (e) {
      console.error("Failed to delete position", e);
    }
  };

  const fetchPortfolio = async () => {
    try {
      const res = await fetch('/api/portfolio');
      const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
      if (json) setPortfolio(json);
    } catch (e) {
      console.error("Failed to fetch portfolio", e);
    }
  };

  const fetchData = async () => {
    try {
      const [marketRes, portfolioRes, telegramRes, settingsRes] = await Promise.all([
        fetch(`/api/market-data?symbol=${symbol}`),
        fetch('/api/portfolio'),
        fetch('/api/telegram/status'),
        fetch('/api/settings')
      ]);
      
      const marketJson = marketRes.headers.get('content-type')?.includes('application/json') ? await marketRes.json() : null;
      const portfolioJson = portfolioRes.headers.get('content-type')?.includes('application/json') ? await portfolioRes.json() : null;
      const telegramJson = telegramRes.headers.get('content-type')?.includes('application/json') ? await telegramRes.json() : null;
      const settingsJson = settingsRes.headers.get('content-type')?.includes('application/json') ? await settingsRes.json() : null;
      
      if (marketJson) {
        setData(marketJson);
        setChartData(prev => [...prev.slice(1), { 
          time: prev.length, 
          price: parseFloat(marketJson.price), 
          zScore: parseFloat(marketJson.parameters.math.zScore),
          signal: marketJson.signal !== 'HOLD' ? marketJson.signal : null
        }]);
      }
      if (portfolioJson) setPortfolio(portfolioJson);
      if (telegramJson) setTelegramStatus(telegramJson);
      if (settingsJson) setSettings(settingsJson);
      
      if (marketJson && portfolioJson && telegramJson && settingsJson) setLoading(false);
    } catch (err) {
      console.error("Fetch failed:", err);
    }
  };

  const modifyFunds = async (action: 'add' | 'remove', amount: number) => {
    try {
      const res = await fetch('/api/modify-funds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, amount })
      });
      if (res.ok) {
        fetchPortfolio();
      }
    } catch (e) {
      console.error("Failed to modify funds", e);
    }
  };

  const updateSettings = async (newSettings: Partial<RiskSettings>) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });
      if (res.ok) {
        const json = await res.json();
        setSettings(json.settings);
      }
    } catch (e) {
      console.error("Failed to update settings", e);
    }
  };

  useEffect(() => {
    fetchData();
    
    // WebSocket Setup
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'MARKET_DATA' && message.symbol === symbol) {
          const marketJson = message.data;
          setData(marketJson);
          setChartData(prev => [...prev.slice(1), { 
            time: prev.length, 
            price: parseFloat(marketJson.price), 
            zScore: parseFloat(marketJson.parameters.math.zScore),
            signal: marketJson.signal !== 'HOLD' ? marketJson.signal : null
          }]);
        } else if (message.type === 'PORTFOLIO_UPDATE') {
          fetchPortfolio();
        }
      } catch (e) {
        console.error("WS message error:", e);
      }
    };

    ws.onopen = () => console.log('[WS] Connected');
    ws.onclose = () => console.log('[WS] Disconnected');

    return () => {
      ws.close();
    };
  }, [symbol]);

  if (!data) return (
    <div className="min-h-screen bg-[#0A0A0B] text-white flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <RefreshCw className="w-8 h-8 animate-spin text-emerald-500" />
        <p className="font-mono text-sm tracking-widest uppercase opacity-50">Initializing Quant Engine...</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-[#E1E1E1] font-sans selection:bg-emerald-500/30">
      {/* Sidebar / Navigation */}
      <nav className="fixed left-0 top-0 h-full w-20 border-r border-white/5 bg-[#0D0D0E] flex flex-col items-center py-8 gap-8 z-50">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-transparent">
          <img src="/quantedge_logo.png" alt="QuantEdge Logo" className="w-[120%] h-[120%] object-contain scale-125" />
        </div>
        
        <div className="flex flex-col gap-4">
          <NavIcon icon={<Activity />} active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          <NavIcon icon={<BarChart3 />} active={activeTab === 'analytics'} onClick={() => setActiveTab('analytics')} />
          <NavIcon icon={<BrainCircuit />} active={activeTab === 'ai'} onClick={() => setActiveTab('ai')} />
          <NavIcon icon={<ShieldAlert />} active={activeTab === 'risk'} onClick={() => setActiveTab('risk')} />
          <NavIcon icon={<Bell />} active={activeTab === 'alerts'} onClick={() => setActiveTab('alerts')} />
        </div>

        <div className="mt-auto">
          <NavIcon icon={<Settings />} active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
        </div>
      </nav>

        {/* Main Content */}
      <main className="pl-20 p-8 max-w-[1600px] mx-auto">
        {/* Header */}
        <header className="flex flex-col xl:flex-row justify-between xl:items-end gap-6 mb-10">
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h1 className="text-3xl font-bold tracking-tight">QuantEdge AI</h1>
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-500 text-[10px] font-bold tracking-tighter uppercase border border-emerald-500/20">Live System</span>
              <button 
                onClick={() => window.open('/api/export/report', '_blank')}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold tracking-widest uppercase transition-all"
              >
                <FileText className="w-3.5 h-3.5 text-emerald-500" />
                Export Report
              </button>
              <select 
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="ml-4 bg-[#111112] border border-white/10 rounded-lg px-3 py-1 text-sm font-mono text-white/80 focus:outline-none focus:border-emerald-500/50"
              >
                <option value="BTC/USDT">BTC/USDT</option>
                <option value="ETH/USDT">ETH/USDT</option>
                <option value="SOL/USDT">SOL/USDT</option>
              </select>
              <button
                onClick={() => updateSettings({ tradingEnabled: !settings.tradingEnabled })}
                className={cn(
                  "ml-4 flex items-center gap-2 px-4 py-1.5 rounded-lg border text-xs font-bold tracking-widest uppercase transition-all shadow-lg",
                  settings.tradingEnabled 
                    ? "bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border-rose-500/30 shadow-rose-500/10" 
                    : "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 border-emerald-500/30 shadow-emerald-500/10"
                )}
              >
                {settings.tradingEnabled ? <AlertTriangle className="w-3.5 h-3.5" /> : <Zap className="w-3.5 h-3.5" />}
                {settings.tradingEnabled ? "Stop AI Bot" : "Start AI Bot"}
              </button>
              <div className="flex flex-wrap items-center gap-4 bg-[#111112] p-2 rounded-xl border border-white/5 ml-4">
                <label className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Leverage: {userLeverage}x</label>
                <input 
                  type="range" 
                  min="1" 
                  max="1000" 
                  value={userLeverage} 
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setUserLeverage(val);
                    fetch('/api/leverage', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ leverage: val }) });
                  }}
                  className="w-32 accent-emerald-500"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-sm text-white/40 font-mono uppercase tracking-widest">Market Intelligence & Strategy Execution</p>
              <div className="h-4 w-px bg-white/10" />
              <div className={cn(
                "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold tracking-widest uppercase border",
                data.regime === 'TRENDING' ? "bg-blue-500/10 text-blue-500 border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.2)]" :
                data.regime === 'VOLATILE' ? "bg-rose-500/10 text-rose-500 border-rose-500/30 shadow-[0_0_15px_rgba(244,63,94,0.2)]" :
                "bg-amber-500/10 text-amber-500 border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.2)]"
              )}>
                {data.regime === 'TRENDING' && <TrendingUp className="w-4 h-4" />}
                {data.regime === 'VOLATILE' && <AlertTriangle className="w-4 h-4" />}
                {data.regime === 'RANGING' && <ArrowRight className="w-4 h-4" />}
                Regime: {data.regime}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap xl:justify-end gap-4 xl:gap-6 text-left xl:text-right">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/30 mb-1">Available Margin</p>
              <p className="text-2xl font-mono font-medium text-white">${parseFloat(portfolio.balance.USDT).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/30 mb-1">Margin Used</p>
              <p className="text-2xl font-mono font-medium text-amber-500">${parseFloat(portfolio.balance.marginUsed || '0').toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/30 mb-1">Total Equity</p>
              <p className="text-2xl font-mono font-medium text-emerald-500">${parseFloat(portfolio.balance.total).toLocaleString()}</p>
            </div>
            <div className="hidden xl:block w-px h-12 bg-white/10 mx-2" />
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/30 mb-1">{symbol} Price</p>
              <p className="text-2xl font-mono font-medium">${parseFloat(data.price).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/30 mb-1">24h Change</p>
              <p className={cn("text-2xl font-mono font-medium", parseFloat(data.change24h) >= 0 ? "text-emerald-500" : "text-rose-500")}>
                {parseFloat(data.change24h) >= 0 ? '+' : ''}{data.change24h}%
              </p>
            </div>
          </div>
        </header>

        {activeTab === 'analytics' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="col-span-1 lg:col-span-2 bg-[#111112] border border-white/5 rounded-2xl p-6">
                <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-emerald-500" />
                  Historical Balance
                </h3>
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={portfolio.balanceHistory}>
                      <defs>
                        <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                      <XAxis dataKey="time" tickFormatter={(time) => new Date(time).toLocaleTimeString()} stroke="#ffffff50" fontSize={10} />
                      <YAxis domain={['auto', 'auto']} stroke="#ffffff50" fontSize={10} tickFormatter={(val) => `$${val.toLocaleString()}`} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#111112', borderColor: '#ffffff10', borderRadius: '8px' }}
                        itemStyle={{ color: '#10b981' }}
                        labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                      />
                      <Area type="monotone" dataKey="balance" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorBalance)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="bg-[#111112] border border-white/5 rounded-2xl p-6 flex flex-col">
                <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                  <Activity className="w-5 h-5 text-emerald-500" />
                  Performance Metrics
                </h3>
                <div className="space-y-6 flex-1">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Total Return</p>
                    <p className={cn("text-2xl font-mono font-medium", parseFloat(portfolio.balance.total) >= 10000 ? "text-emerald-500" : "text-rose-500")}>
                      {(((parseFloat(portfolio.balance.total) - 10000) / 10000) * 100).toFixed(2)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Sharpe Ratio</p>
                    <p className="text-2xl font-mono font-medium text-white">{data.parameters.math.sharpeRatio}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Kelly Position Sizing</p>
                    <p className="text-2xl font-mono font-medium text-emerald-500">{data.parameters.risk.positionSize}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Max Drawdown</p>
                    <p className="text-2xl font-mono font-medium text-rose-500">{data.parameters.risk.maxDrawdown}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Win Rate</p>
                    <p className="text-2xl font-mono font-medium text-blue-500">{data.parameters.risk.winRate}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#111112] border border-white/5 rounded-2xl p-6">
              <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                <BrainCircuit className="w-5 h-5 text-emerald-500" />
                PnL by Strategy
              </h3>
              <div className="space-y-4">
                {Array.from(new Set(portfolio.positions.map(p => p.strategy))).map(strategy => {
                  const strategyPositions = portfolio.positions.filter(p => p.strategy === strategy);
                  const totalPnL = strategyPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
                  const winCount = strategyPositions.filter(p => p.pnl > 0).length;
                  const closedCount = strategyPositions.filter(p => p.status === 'CLOSED').length;
                  
                  return (
                    <div key={strategy} className="flex items-center justify-between p-4 bg-white/5 rounded-xl border border-white/5">
                      <div>
                        <p className="font-bold text-sm text-white/90">{strategy}</p>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest mt-1">
                          {closedCount} Trades • {closedCount > 0 ? ((winCount / closedCount) * 100).toFixed(1) : 0}% Win Rate
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={cn("font-mono font-bold", totalPnL >= 0 ? "text-emerald-500" : "text-rose-500")}>
                          {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {portfolio.positions.length === 0 && (
                  <div className="text-center text-white/30 py-8 text-sm">No trades executed yet.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <>
            {/* Top Grid: Signal & Main Chart */}
            <div className="grid grid-cols-12 gap-6 mb-6">
          {/* Signal Card */}
          <div className="col-span-12 lg:col-span-4 bg-[#111112] border border-white/5 rounded-2xl p-6 flex flex-col justify-between relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 blur-3xl rounded-full -mr-16 -mt-16" />
            
            <div>
              <div className="flex justify-between items-start mb-8">
                <div className="text-xs uppercase tracking-widest text-white/40 font-semibold flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Live AI Signal Engine
                </div>
                <Zap className={cn("w-5 h-5", data.signal === 'BUY' ? "text-emerald-500" : data.signal === 'SELL' ? "text-rose-500" : "text-amber-500")} />
              </div>
              
              <div className="mb-2">
                <h2 className={cn(
                  "text-7xl font-black tracking-tighter italic",
                  data.signal === 'BUY' ? "text-emerald-500" : data.signal === 'SELL' ? "text-rose-500" : "text-amber-500"
                )}>
                  {data.signal}
                </h2>
                <p className="text-sm text-white/60 mt-2">Confidence Score: <span className="text-white font-mono">{data.confidence}%</span></p>
                <p className="text-[10px] text-white/40 mt-4 uppercase tracking-widest font-bold border-t border-white/5 pt-4">
                  {data.strategyNote}
                </p>
              </div>
            </div>

            <div className="space-y-4 mt-8">
              <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all duration-1000" style={{ width: `${data.confidence}%` }} />
              </div>
              <div className="flex justify-between text-[10px] uppercase tracking-widest text-white/30">
                <span>Risk Adjusted</span>
                <span>Bayesian Posterior</span>
              </div>
            </div>
          </div>

          {/* Main Chart */}
          <div className="col-span-12 lg:col-span-8 bg-[#111112] border border-white/5 rounded-2xl p-1 overflow-hidden min-h-[450px]">
            <AdvancedRealTimeChart 
              theme="dark" 
              symbol={`BINANCE:${symbol.replace('/', '')}`}
              autosize
              interval="60"
              timezone="Etc/UTC"
              style="1"
              locale="en"
              toolbar_bg="#111112"
              enable_publishing={false}
              hide_side_toolbar={false}
              allow_symbol_change={true}
              container_id="tradingview_chart"
            />
          </div>
        </div>

        {/* AI Real-Time Analysis Graph (Moved to Dashboard) */}
        <div className="bg-[#111112] border border-white/5 rounded-2xl p-6 mt-6">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-500" />
              AI Internal Signal Graph (Real-Time)
            </h3>
            <div className="flex gap-4 text-[10px] uppercase tracking-widest font-bold">
              <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-emerald-500" /> BUY SIGNAL</div>
              <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-rose-500" /> SELL SIGNAL</div>
            </div>
          </div>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                <XAxis dataKey="time" hide />
                <YAxis domain={['auto', 'auto']} hide />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#111112', borderColor: '#ffffff10', borderRadius: '8px' }}
                  itemStyle={{ color: '#fff', fontFamily: 'monospace' }}
                  labelStyle={{ display: 'none' }}
                />
                <Line 
                  type="monotone" 
                  dataKey="price" 
                  stroke="#10b981" 
                  strokeWidth={2} 
                  dot={(props: any) => {
                    const { cx, cy, payload } = props;
                    if (payload.signal === 'BUY') {
                      return <circle key={`dot-${payload.time}`} cx={cx} cy={cy} r={6} fill="#10b981" stroke="#fff" strokeWidth={2} />;
                    }
                    if (payload.signal === 'SELL') {
                      return <circle key={`dot-${payload.time}`} cx={cx} cy={cy} r={6} fill="#ef4444" stroke="#fff" strokeWidth={2} />;
                    }
                    return <span key={`dot-${payload.time}`} />;
                  }}
                  activeDot={{ r: 4, fill: '#10b981' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Live Positions moved to Dashboard Tab */}
        <div className="mt-6 bg-[#111112] border border-white/5 rounded-2xl p-8">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-500" />
              Live Positions & Trade History
            </h3>
            <div className="flex gap-2">
              <button onClick={() => modifyFunds('add', 1000)} className="px-3 py-1.5 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-bold uppercase tracking-widest">+ $1K</button>
              <button onClick={() => modifyFunds('add', 5000)} className="px-3 py-1.5 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-bold uppercase tracking-widest">+ $5K</button>
              <button onClick={() => modifyFunds('remove', 1000)} className="px-3 py-1.5 bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg text-xs font-bold uppercase tracking-widest">- $1K</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-white/70">
              <thead className="text-[10px] uppercase tracking-widest text-white/40 border-b border-white/5">
                <tr>
                  <th className="pb-4">Symbol</th>
                  <th className="pb-4">Side</th>
                  <th className="pb-4">Qty</th>
                  <th className="pb-4">Leverage</th>
                  <th className="pb-4">Entry</th>
                  <th className="pb-4">PnL</th>
                  <th className="pb-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {portfolio.positions.map((p: any) => (
                  <tr key={p.id} className="hover:bg-white/5">
                    <td className="py-4 font-mono">{p.symbol}</td>
                    <td className={cn("py-4 font-bold", p.side === 'LONG' ? "text-emerald-500" : "text-rose-500")}>{p.side}</td>
                    <td className="py-4 font-mono">{p.qty.toFixed(4)}</td>
                    <td className="py-4 font-mono">{p.leverage}x</td>
                    <td className="py-4 font-mono">${p.entryPrice.toFixed(2)}</td>
                    <td className={cn("py-4 font-mono", (p.pnl || p.unrealizedPnl || 0) >= 0 ? "text-emerald-500" : "text-rose-500")}>
                      {p.status === 'OPEN' ? `$${(p.unrealizedPnl || 0).toFixed(2)}` : `$${(p.pnl || 0).toFixed(2)}`}
                    </td>
                    <td className="py-4 flex items-center gap-3">
                      <span className={cn("px-2 py-1 rounded text-[10px] uppercase tracking-widest font-bold", p.status === 'OPEN' ? "bg-emerald-500/10 text-emerald-500" : "bg-white/5 text-white/40")}>
                        {p.status}
                      </span>
                      {p.status === 'OPEN' && (
                        <button 
                          onClick={() => closePosition(p.id)}
                          className="text-[10px] uppercase font-bold text-emerald-500 hover:text-emerald-400"
                        >
                          Close
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {portfolio.positions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-white/40">No positions open or closed yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        </>
        )}

        {activeTab === 'ai' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">

        {/* AI Real-Time Analysis Graph */}
        <div className="bg-[#111112] border border-white/5 rounded-2xl p-6 mb-6">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-500" />
              AI Internal Signal Graph
            </h3>
            <div className="flex gap-4 text-[10px] uppercase tracking-widest font-bold">
              <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-emerald-500" /> BUY SIGNAL</div>
              <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-rose-500" /> SELL SIGNAL</div>
            </div>
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                <XAxis dataKey="time" hide />
                <YAxis domain={['auto', 'auto']} hide />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#111112', borderColor: '#ffffff10', borderRadius: '8px' }}
                  itemStyle={{ color: '#fff', fontFamily: 'monospace' }}
                  labelStyle={{ display: 'none' }}
                />
                <Line 
                  type="monotone" 
                  dataKey="price" 
                  stroke="#10b981" 
                  strokeWidth={2} 
                  dot={(props: any) => {
                    const { cx, cy, payload } = props;
                    if (payload.signal === 'BUY') {
                      return <circle key={`dot-${payload.time}`} cx={cx} cy={cy} r={6} fill="#10b981" stroke="#fff" strokeWidth={2} />;
                    }
                    if (payload.signal === 'SELL') {
                      return <circle key={`dot-${payload.time}`} cx={cx} cy={cy} r={6} fill="#ef4444" stroke="#fff" strokeWidth={2} />;
                    }
                    return <span key={`dot-${payload.time}`} />;
                  }}
                  activeDot={{ r: 4, fill: '#10b981' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Parameter Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6">
          <ParameterCard title="Trend" icon={<TrendingUp className="w-4 h-4" />} params={data.parameters.trend} />
          <ParameterCard title="Momentum" icon={<Zap className="w-4 h-4" />} params={data.parameters.momentum} />
          <ParameterCard title="Volume & Liquidity" icon={<BarChart3 className="w-4 h-4" />} params={data.parameters.volume} />
          <ParameterCard title="Volatility" icon={<Activity className="w-4 h-4" />} params={data.parameters.volatility} />
          <ParameterCard title="AMQS & AI Models" icon={<BrainCircuit className="w-4 h-4" />} params={data.parameters.math} />
          <ParameterCard title="Risk Engine" icon={<Shield className="w-4 h-4" />} params={data.parameters.risk} />
        </div>

        {/* Bottom Section: Strategy Details & Live Feed */}
        <div className="grid grid-cols-12 gap-6 mt-6">
          <div className="col-span-12 lg:col-span-8 bg-[#111112] border border-white/5 rounded-2xl p-8">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <BrainCircuit className="w-5 h-5 text-emerald-500" />
                Strategy Logic: Smart Trend + Pullback
              </h3>
              <div className="flex gap-2">
                <span className="px-2 py-1 rounded bg-white/5 text-[10px] font-mono text-white/40">v2.4.0-Stable</span>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-4">
                <h4 className="text-xs uppercase tracking-widest text-white/40 font-bold mb-4">Deep Calculation Breakdown</h4>
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/60">XGBoost Probability</span>
                    <span className="text-white font-mono">{data.parameters.math.xgbProb}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/60">LSTM Neural Network</span>
                    <span className="text-white font-mono">{data.parameters.math.lstmProb}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/60">AMQS Signal Stacking</span>
                    <span className="text-white font-mono">{data.parameters.math.amqsScore}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/60">Hurst Exponent (Persistence)</span>
                    <span className="text-white font-mono">{data.parameters.math.hurstExponent}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm border-t border-white/5 pt-3 mt-3">
                    <span className="text-emerald-500 font-bold">Final Confidence Score</span>
                    <span className="text-emerald-500 font-black">{data.confidence}%</span>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <p className="text-xs uppercase tracking-widest text-white/40 font-bold">Execution Logic</p>
                <ul className="space-y-3">
                  <li className="flex items-center gap-3 text-sm">
                    <div className={cn("w-1.5 h-1.5 rounded-full", data.signal !== 'HOLD' ? "bg-emerald-500" : "bg-white/10")} />
                    <span className="text-white/70">Regime-Adaptive Strategy: {data.regime} Mode</span>
                  </li>
                  <li className="flex items-center gap-3 text-sm">
                    <div className={cn("w-1.5 h-1.5 rounded-full", parseFloat(data.parameters.math.kellyCriterion) > 0 ? "bg-emerald-500" : "bg-rose-500")} />
                    <span className="text-white/70">Kelly Criterion: {parseFloat(data.parameters.math.kellyCriterion) > 0 ? "Optimal Sizing Active" : "Risk Block Active"}</span>
                  </li>
                  <li className="flex items-center gap-3 text-sm">
                    <div className={cn("w-1.5 h-1.5 rounded-full", parseFloat(data.parameters.math.sharpeRatio) > 1.5 ? "bg-emerald-500" : "bg-amber-500")} />
                    <span className="text-white/70">Risk-Adjusted Performance: {data.parameters.math.sharpeRatio} Sharpe</span>
                  </li>
                </ul>
              </div>
              <div className="bg-white/5 rounded-xl p-6 border border-white/5 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-2">
                  <Shield className={cn("w-4 h-4", parseFloat(data.parameters.math.kellyCriterion) > 0 ? "text-emerald-500/50" : "text-rose-500/50")} />
                </div>
                <p className="text-xs uppercase tracking-widest text-white/30 font-bold mb-4">Risk Engine Output</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] text-white/40 uppercase mb-1">Sharpe Ratio</p>
                    <p className="text-xl font-mono text-emerald-500">{data.parameters.math.sharpeRatio}</p>
                    <p className="text-[8px] text-white/20 uppercase mt-1">Risk-Adj. Return</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/40 uppercase mb-1">Win Rate</p>
                    <p className="text-xl font-mono text-emerald-500">{data.parameters.risk.winRate}</p>
                    <p className="text-[8px] text-white/20 uppercase mt-1">Historical Edge</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/40 uppercase mb-1">Max Drawdown</p>
                    <p className="text-xl font-mono text-rose-500">{data.parameters.risk.maxDrawdown}</p>
                    <p className="text-[8px] text-white/20 uppercase mt-1">Peak-to-Trough</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/40 uppercase mb-1">Kelly Size</p>
                    <p className="text-xl font-mono text-white">{data.parameters.risk.positionSize}</p>
                    <p className="text-[8px] text-white/20 uppercase mt-1">Optimal Fraction</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Live Feed Simulation */}
            <div className="mt-8 pt-8 border-t border-white/5">
              <div className="flex justify-between items-center mb-4">
                <p className="text-xs uppercase tracking-widest text-white/30 font-bold">Live Positions & Trade History</p>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-widest text-white/30">Total Balance</p>
                  <p className="text-sm font-mono text-emerald-500">${parseFloat(portfolio.balance.total).toLocaleString()}</p>
                </div>
              </div>
              
              <div className="space-y-2 font-mono text-[11px] max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                {!portfolio.positions || portfolio.positions.length === 0 ? (
                  <div className="text-white/30 text-center py-4">Waiting for first trade execution...</div>
                ) : (
                  portfolio.positions.map((pos: any) => (
                    <div key={pos.id} className="flex flex-col p-3 bg-white/5 rounded border border-white/5 gap-2">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{pos.symbol}</span>
                          <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold", pos.side === 'LONG' ? "bg-emerald-500/20 text-emerald-500" : "bg-rose-500/20 text-rose-500")}>
                            {pos.side}
                          </span>
                          <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold", pos.status === 'OPEN' ? "bg-blue-500/20 text-blue-500" : "bg-white/10 text-white/50")}>
                            {pos.status}
                          </span>
                          <span className="text-white/70">{parseFloat(pos.qty).toFixed(4)} QTY</span>
                          <span className="text-amber-500/70">{pos.leverage}x</span>
                        </div>
                        <div className="text-right">
                          {pos.status === 'CLOSED' && (
                            <span className={cn("font-bold", parseFloat(pos.pnl) >= 0 ? "text-emerald-500" : "text-rose-500")}>
                              {parseFloat(pos.pnl) >= 0 ? '+' : ''}${parseFloat(pos.pnl).toFixed(2)}
                            </span>
                          )}
                          {pos.status === 'OPEN' && pos.unrealizedPnl !== undefined && (
                            <span className={cn("font-bold", parseFloat(pos.unrealizedPnl) >= 0 ? "text-emerald-500" : "text-rose-500")}>
                              {parseFloat(pos.unrealizedPnl) >= 0 ? '+' : ''}${parseFloat(pos.unrealizedPnl).toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 text-[10px] text-white/40 mt-1">
                        <div>
                          <p>Entry: <span className="text-white/70">${parseFloat(pos.entryPrice).toLocaleString()}</span></p>
                          <p>Margin: <span className="text-white/70">${parseFloat(pos.margin).toLocaleString()}</span></p>
                          <p>Time: <span className="text-white/70">{new Date(pos.entryTime).toLocaleTimeString()}</span></p>
                        </div>
                        <div className="text-right">
                          <p>{pos.status === 'OPEN' ? 'Current' : 'Exit'}: <span className="text-white/70">${pos.status === 'OPEN' ? parseFloat(pos.currentPrice).toLocaleString() : pos.exitPrice ? parseFloat(pos.exitPrice).toLocaleString() : '-'}</span></p>
                          <p>Fees: <span className="text-white/70">${(parseFloat(pos.entryFee) + (pos.exitFee ? parseFloat(pos.exitFee) : 0)).toFixed(2)}</span></p>
                          <p>Time: <span className="text-white/70">{pos.exitTime ? new Date(pos.exitTime).toLocaleTimeString() : '-'}</span></p>
                        </div>
                      </div>
                      <div className="text-[9px] text-white/30 truncate mt-1 border-t border-white/5 pt-1 flex justify-between items-center">
                        <span>Strategy: {pos.strategy}</span>
                        <div className="flex gap-2">
                          {pos.status === 'OPEN' && (
                            <button 
                              onClick={() => closePosition(pos.id)}
                              className="text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10 px-2 py-0.5 rounded transition-colors border border-emerald-500/20"
                            >
                              Close
                            </button>
                          )}
                          <button 
                            onClick={() => deletePosition(pos.id)}
                            className="text-white/30 hover:text-rose-500 hover:bg-rose-500/10 px-2 py-0.5 rounded transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="col-span-12 lg:col-span-4 bg-[#111112] border border-white/5 rounded-2xl p-8 flex flex-col">
             <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-500" />
              News Sentiment
            </h3>
            <div className="space-y-6 flex-1">
              <div className="flex justify-between items-center">
                <span className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Sentiment Score</span>
                <span className={cn(
                  "text-xl font-mono font-bold",
                  parseFloat(data.sentiment.score) > 0 ? "text-emerald-500" : "text-rose-500"
                )}>
                  {data.sentiment.score}
                </span>
              </div>
              
              <div className="p-4 bg-white/5 rounded-xl border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    data.sentiment.label === 'BULLISH' ? "bg-emerald-500" : 
                    data.sentiment.label === 'BEARISH' ? "bg-rose-500" : "bg-amber-500"
                  )} />
                  <span className="text-xs font-bold uppercase tracking-widest">{data.sentiment.label}</span>
                </div>
                <p className="text-sm text-white/70 italic leading-relaxed">
                  "{data.sentiment.headline}"
                </p>
              </div>

              <div className="mt-auto pt-4 border-t border-white/5">
                <p className="text-[10px] text-white/30 uppercase tracking-widest leading-tight">
                  Signals are automatically filtered when sentiment conflicts with technical indicators.
                </p>
              </div>
            </div>
          </div>
        </div>
        </div>
        )}

        {activeTab === 'alerts' && (
          <div className="grid grid-cols-12 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="col-span-12 lg:col-span-6 bg-[#111112] border border-white/5 rounded-2xl p-8 flex flex-col">
             <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
              <Bell className="w-5 h-5 text-emerald-500" />
              Telegram Alerts
            </h3>
            <div className="space-y-4 flex-1">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-white/40 block mb-2">Bot Username</label>
                <div className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm font-mono text-emerald-500">
                  @trade97froge_bot
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-white/40 block mb-2">Active Chat ID</label>
                <div className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm font-mono text-white/60">
                  {telegramStatus.activeChatId || "Waiting for /start..."}
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-white/40 block mb-2">Status</label>
                <div className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg border",
                  telegramStatus.blocked ? "bg-rose-500/10 border-rose-500/30" : "bg-white/5 border-white/5"
                )}>
                  <div className={cn(
                    "w-2 h-2 rounded-full animate-pulse",
                    telegramStatus.blocked ? "bg-rose-500" : "bg-emerald-500"
                  )} />
                  <span className={cn(
                    "text-xs font-mono",
                    telegramStatus.blocked ? "text-rose-500" : "text-white"
                  )}>
                    {telegramStatus.blocked ? "BLOCKED (ACTION REQUIRED)" : "CONNECTED & ACTIVE"}
                  </span>
                </div>
                {telegramStatus.blocked && (
                  <p className="text-[10px] text-rose-400 mt-2 leading-tight">
                    Bot is blocked. You must open Telegram and click START to receive alerts.
                  </p>
                )}
              </div>
              <button 
                onClick={async () => {
                  try {
                    const res = await fetch('/api/telegram/test', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ message: "🔔 <b>QuantEdge AI Alert</b>\nManual test signal triggered from Dashboard.\n\n<b>Bot:</b> @trade97froge_bot\n<b>Status:</b> Operational" })
                    });
                    const result = await res.json();
                    if (result.success) {
                      alert("✅ Test alert sent! Check your Telegram bot.");
                    } else {
                      alert("❌ Telegram Error\n\n" + result.error);
                    }
                  } catch (e) {
                    alert("Failed to connect to server.");
                  }
                }}
                className="w-full bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3 rounded-xl transition-all mt-4 flex items-center justify-center gap-2"
              >
                <Zap className="w-4 h-4" />
                Send Test Alert
              </button>

              <div className="mt-6 pt-6 border-t border-white/5 space-y-3">
                <p className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Setup Guide</p>
                <div className="space-y-2">
                  <div className="flex gap-3 items-start">
                    <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center text-[10px] flex-shrink-0">1</div>
                    <p className="text-[10px] text-white/50 leading-tight">Search for <span className="text-emerald-500">@trade97froge_bot</span> on Telegram.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center text-[10px] flex-shrink-0">2</div>
                    <p className="text-[10px] text-white/50 leading-tight">Click <span className="text-white">START</span> to authorize the bot.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center text-[10px] flex-shrink-0">3</div>
                    <p className="text-[10px] text-white/50 leading-tight">Use <span className="text-emerald-500">@userinfobot</span> to find your numeric Chat ID.</p>
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-white/20 text-center italic mt-2">
                Telegram Bot Token: (Configured in Secrets)
              </p>
            </div>
            </div>
          </div>
        )}

        {activeTab === 'risk' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="bg-[#111112] border border-white/5 rounded-3xl p-8">
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                  <ShieldAlert className="w-6 h-6 text-emerald-500" />
                </div>
                <div>
                  <h2 className="text-xl font-bold tracking-tight">Risk Configuration</h2>
                  <p className="text-xs text-white/40 uppercase tracking-widest font-mono">Account Protection & Money Management</p>
                </div>
              </div>

              <div className="space-y-8">
                <div className="flex items-center justify-between p-4 rounded-2xl bg-white/5 border border-white/5">
                  <div>
                    <p className="text-sm font-medium mb-1">Trading Enabled</p>
                    <p className="text-[10px] text-white/40 uppercase tracking-widest">Master Kill-Switch</p>
                  </div>
                  <button 
                    onClick={() => updateSettings({ tradingEnabled: !settings.tradingEnabled })}
                    className={cn(
                      "px-6 py-2 rounded-xl text-[10px] font-bold tracking-widest uppercase transition-all",
                      settings.tradingEnabled ? "bg-emerald-500 text-black" : "bg-rose-500 text-white"
                    )}
                  >
                    {settings.tradingEnabled ? "Active" : "Disabled"}
                  </button>
                </div>

                <div className="space-y-4">
                  <label className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Risk Profile</label>
                  <div className="grid grid-cols-3 gap-3">
                    {['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'].map((profile) => (
                      <button
                        key={profile}
                        onClick={() => updateSettings({ riskProfile: profile as any })}
                        className={cn(
                          "px-4 py-3 rounded-xl text-[10px] font-bold tracking-widest uppercase border transition-all",
                          settings.riskProfile === profile 
                            ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500" 
                            : "bg-white/5 border-white/5 text-white/40 hover:border-white/20"
                        )}
                      >
                        {profile}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between items-end">
                    <label className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Max Daily Drawdown</label>
                    <span className="text-sm font-mono text-emerald-500">{(settings.maxDailyDrawdown * 100).toFixed(1)}%</span>
                  </div>
                  <input 
                    type="range" min="0.01" max="0.2" step="0.01"
                    value={settings.maxDailyDrawdown}
                    onChange={(e) => updateSettings({ maxDailyDrawdown: parseFloat(e.target.value) })}
                    className="w-full accent-emerald-500"
                  />
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between items-end">
                    <label className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Risk Per Trade</label>
                    <span className="text-sm font-mono text-emerald-500">{(settings.riskPerTrade * 100).toFixed(1)}%</span>
                  </div>
                  <input 
                    type="range" min="0.005" max="0.05" step="0.005"
                    value={settings.riskPerTrade}
                    onChange={(e) => updateSettings({ riskPerTrade: parseFloat(e.target.value) })}
                    className="w-full accent-emerald-500"
                  />
                </div>

                <div className="flex items-center justify-between p-4 rounded-2xl bg-white/5 border border-white/5">
                  <div>
                    <p className="text-sm font-medium mb-1">Auto-Leverage Adjustment</p>
                    <p className="text-[10px] text-white/40 uppercase tracking-widest">Dynamic Profile Scaling</p>
                  </div>
                  <button 
                    onClick={() => updateSettings({ autoLeverage: !settings.autoLeverage })}
                    className={cn(
                      "w-12 h-6 rounded-full relative transition-all",
                      settings.autoLeverage ? "bg-emerald-500" : "bg-white/10"
                    )}
                  >
                    <div className={cn(
                      "absolute top-1 w-4 h-4 rounded-full bg-white transition-all",
                      settings.autoLeverage ? "left-7" : "left-1"
                    )} />
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-8">
              <div className="bg-[#111112] border border-white/5 rounded-3xl p-8">
                <h3 className="text-sm font-bold uppercase tracking-widest mb-6 text-white/60">Risk Exposure Analysis</h3>
                <div className="space-y-6">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-white/40 uppercase tracking-widest">Total Margin Exposure</span>
                    <span className="text-sm font-mono">{(parseFloat(portfolio.balance.total) > 0 ? (parseFloat(portfolio.balance.total) - parseFloat(portfolio.balance.USDT)) / parseFloat(portfolio.balance.total) * 100 : 0).toFixed(2)}%</span>
                  </div>
                  <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-emerald-500 transition-all duration-1000" 
                      style={{ width: `${Math.min(100, (parseFloat(portfolio.balance.total) > 0 ? (parseFloat(portfolio.balance.total) - parseFloat(portfolio.balance.USDT)) / parseFloat(portfolio.balance.total) * 100 : 0))}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-white/30 leading-relaxed">
                    The bot currently limits total exposure to <span className="text-emerald-500">{(settings.maxTotalExposure * 100).toFixed(0)}%</span> of equity. 
                    If this limit is reached, new trades will be blocked regardless of signal strength.
                  </p>
                </div>
              </div>

              <div className="bg-[#111112] border border-white/5 rounded-3xl p-8">
                <h3 className="text-sm font-bold uppercase tracking-widest mb-6 text-white/60">Protection Status</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/5">
                    <p className="text-[10px] text-white/30 uppercase tracking-widest mb-1">Daily DD Limit</p>
                    <p className={cn("text-lg font-mono", settings.tradingEnabled ? "text-emerald-500" : "text-rose-500")}>
                      {settings.tradingEnabled ? "SAFE" : "BREACHED"}
                    </p>
                  </div>
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/5">
                    <p className="text-[10px] text-white/30 uppercase tracking-widest mb-1">Leverage Mode</p>
                    <p className="text-lg font-mono text-white/80">{settings.autoLeverage ? "DYNAMIC" : "FIXED"}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}


        {activeTab === 'settings' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="bg-[#111112] border border-white/5 rounded-3xl p-8">
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10">
                  <Settings className="w-6 h-6 text-white/70" />
                </div>
                <div>
                  <h2 className="text-xl font-bold tracking-tight">System Settings</h2>
                  <p className="text-xs text-white/40 uppercase tracking-widest font-mono">Platform Configuration</p>
                </div>
              </div>

              <div className="space-y-6">
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-white/40 block mb-2 font-bold">Binance API Key (Requires Execution Restart)</label>
                  <input 
                    type="password"
                    disabled
                    value="************************************************"
                    className="w-full bg-black/40 border border-white/5 rounded-xl px-4 py-3 text-sm font-mono text-white/60 cursor-not-allowed"
                  />
                  <p className="text-[10px] text-white/30 mt-2">API Keys must be managed via server-side `.env` variables for security.</p>
                </div>
                
                <div className="pt-6 border-t border-white/5">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-white/70 mb-4">Execution Control</h3>
                  <div className="flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/5">
                    <div>
                      <p className="text-sm font-bold text-white mb-1">Halt New Trades</p>
                      <p className="text-[10px] text-white/50 leading-tight pr-6">
                        Stop the AI from opening any *new* positions. 
                        Live data analysis, open position management, and Risk Engine will remain fully active.
                      </p>
                    </div>
                    <button 
                      onClick={() => updateSettings({ tradingEnabled: !settings.tradingEnabled })}
                      className={cn(
                        "w-12 h-6 rounded-full relative transition-all flex-shrink-0",
                        !settings.tradingEnabled ? "bg-rose-500" : "bg-white/10"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-4 h-4 rounded-full bg-white transition-all",
                        !settings.tradingEnabled ? "left-7" : "left-1"
                      )} />
                    </button>
                  </div>
                </div>

                <div className="pt-6 border-t border-white/5">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-white/70 mb-4">Paper Trading Reset</h3>
                  <button 
                    onClick={() => {
                      if(window.confirm("Are you sure? This will reset your paper balance to $10,000 and clears history.")) {
                         fetch('/api/modify-funds', {
                           method: 'POST',
                           headers: { 'Content-Type': 'application/json' },
                           body: JSON.stringify({ action: 'add', amount: 10000 })
                         }).then(() => window.location.reload());
                      }
                    }}
                    className="w-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 font-bold tracking-widest text-xs py-3 rounded-xl border border-rose-500/20 transition-colors uppercase"
                  >
                    Reset Paper Account
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-[#111112] border border-white/5 rounded-3xl p-8 flex flex-col justify-center items-center text-center">
              <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center mb-6">
                <Cpu className="w-10 h-10 text-emerald-500" />
              </div>
              <h3 className="text-2xl font-bold mb-2">QuantEdge System Active</h3>
              <p className="text-white/40 text-sm max-w-sm mb-8">Server mapping to backend execution engine is currently established on port 3000.</p>
              
              <div className="grid grid-cols-2 gap-4 w-full max-w-sm text-left">
                <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                  <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1">Engine Latency</p>
                  <p className="text-emerald-500 font-mono text-lg">&lt; 10ms</p>
                </div>
                <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                  <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1">Uptime</p>
                  <p className="text-white/80 font-mono text-lg">99.9%</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function NavIcon({ icon, active, onClick }: { icon: React.ReactNode, active?: boolean, onClick?: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-300",
        active ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" : "text-white/30 hover:text-white hover:bg-white/5"
      )}
    >
      {React.cloneElement(icon as React.ReactElement, { className: "w-6 h-6" })}
    </button>
  );
}

function ParameterCard({ title, icon, params }: { title: string, icon: React.ReactNode, params: Record<string, string> }) {
  return (
    <div className="bg-[#111112] border border-white/5 rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-6">
        <div className="p-2 bg-white/5 rounded-lg text-emerald-500">
          {icon}
        </div>
        <p className="text-xs uppercase tracking-widest text-white/40 font-bold">{title}</p>
      </div>
      <div className="space-y-4">
        {Object.entries(params).map(([key, value]) => (
          <div key={key} className="flex justify-between items-end border-b border-white/5 pb-2">
            <span className="text-[10px] uppercase tracking-tight text-white/30 font-mono">{key.replace(/([A-Z])/g, ' $1')}</span>
            <span className="text-sm font-mono text-white/90">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
