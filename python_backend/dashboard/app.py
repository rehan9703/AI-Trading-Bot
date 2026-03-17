"""
Flask Web Dashboard
Live status monitor for the AI Trading Bot.
"""

from flask import Flask, jsonify, render_template_string
import threading
import config

app = Flask(__name__)

BOT_STATE = {
    "version": "1.0",
    "mode": "PAPER" if config.PAPER_TRADING else "LIVE",
    "uptime_seconds": 0,
    "last_update": "",
    "prices": {},
    "signals": {},
    "balance": config.PAPER_BALANCE_USDT,
    "stats": {},
    "open_positions": []
}

# Control commands from Web UI to Main Loop
BOT_CONTROL = {
    "is_paused": False,
    "funds_to_add": 0.0,
    "funds_to_remove": 0.0
}

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QuantEdge AI Bot Dashboard</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background-color: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .card { background-color: #161b22; border: 1px solid #30363d; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .card-header { background-color: #21262d; border-bottom: 1px solid #30363d; font-weight: bold; }
        .metric-value { font-size: 1.5rem; font-weight: bold; }
        .metric-label { font-size: 0.85rem; color: #8b949e; text-transform: uppercase; }
        .text-success { color: #3fb950 !important; }
        .text-danger { color: #f85149 !important; }
        .text-warning { color: #d29922 !important; }
        table { color: #c9d1d9 !important; }
        thead { background-color: #21262d; border-color: #30363d; }
        td, th { border-color: #30363d !important; }
        .badge-buy { background-color: #238636; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;}
        .badge-sell { background-color: #da3633; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;}
        .badge-hold { background-color: #8b949e; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;}
    </style>
    <!-- Auto refresh every 15 seconds -->
    <meta http-equiv="refresh" content="15">
</head>
<body>
    <div class="container-fluid mt-4">
        <h2 class="mb-4">🤖 QuantEdge AI Bot | <small class="text-muted">v{{ state.version }} ({{ state.mode }})</small></h2>
        
        <!-- ROW 1: Prices -->
        <div class="row">
            {% for symbol in state.prices %}
            <div class="col-md-3">
                <div class="card p-3 text-center">
                    <div class="metric-label">{{ symbol }}</div>
                    <div class="metric-value">${{ "%.2f"|format(state.prices[symbol]) }}</div>
                </div>
            </div>
            {% endfor %}
        </div>

        <!-- ROW 2: System Metrics -->
        <div class="row">
            <div class="col-md-3">
                <div class="card p-3 text-center">
                    <div class="metric-label">Balance (USDT)</div>
                    <div class="metric-value text-primary">${{ "%.2f"|format(state.balance) }}</div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card p-3 text-center">
                    <div class="metric-label">Total P&L</div>
                    {% set pnl = state.stats.total_pnl if state.stats.total_pnl is defined else 0 %}
                    <div class="metric-value {% if pnl >= 0 %}text-success{% else %}text-danger{% endif %}">
                        ${{ "%.2f"|format(pnl) }}
                    </div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card p-3 text-center">
                    <div class="metric-label">Win Rate</div>
                    <div class="metric-value">{{ state.stats.win_rate if state.stats.win_rate is defined else 0 }}%</div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card p-3 text-center">
                    <div class="metric-label">Sharpe Ratio</div>
                    <div class="metric-value text-warning">{{ state.stats.sharpe_ratio if state.stats.sharpe_ratio is defined else 0 }}</div>
                </div>
            </div>
            </div>
        </div>
        
        <!-- ROW: Bot Controls -->
        <div class="card mt-2">
            <div class="card-header d-flex justify-content-between align-items-center">
                <span>Bot Controls</span>
                <span id="bot-status" class="badge {% if control.is_paused %}bg-warning{% else %}bg-success{% endif %}">
                    {% if control.is_paused %}PAUSED{% else %}ACTIVE{% endif %}
                </span>
            </div>
            <div class="card-body">
                <div class="row align-items-center">
                    <div class="col-md-4 text-center">
                        <button class="btn {% if control.is_paused %}btn-success{% else %}btn-warning{% endif %} w-75" onclick="togglePause()">
                            {% if control.is_paused %}▶️ Resume Trading{% else %}⏸️ Pause Trading{% endif %}
                        </button>
                    </div>
                    {% if state.mode == 'PAPER' %}
                    <div class="col-md-8">
                        <div class="input-group">
                            <span class="input-group-text">USDT</span>
                            <input type="number" id="fundAmount" class="form-control" placeholder="Amount (e.g. 1000)" min="1">
                            <button class="btn btn-outline-success" onclick="modifyFunds('add')">➕ Add Funds</button>
                            <button class="btn btn-outline-danger" onclick="modifyFunds('remove')">➖ Remove Funds</button>
                        </div>
                    </div>
                    {% endif %}
                </div>
            </div>
        </div>

        <!-- ROW 3: Signals Table -->
        <div class="card mt-2">
            <div class="card-header">Live Market Signals</div>
            <div class="card-body p-0">
                <table class="table table-hover mb-0">
                    <thead>
                        <tr>
                            <th>Symbol</th>
                            <th>Regime</th>
                            <th>Quant Score</th>
                            <th>LSTM Conf</th>
                            <th>RF Conf</th>
                            <th>Hurst/Z-Score/RSI</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {% for sym, res in state.signals.items() %}
                        <tr>
                            <td><strong>{{ sym }}</strong></td>
                            <td>{{ res.regime }}</td>
                            <td>{{ res.score }}</td>
                            <td>{{ "%.1f"|format(res.lstm_confidence) }}%</td>
                            <td>{{ "%.1f"|format(res.rf_confidence) }}%</td>
                            <td>{{ res.hurst }} / {{ res.zscore }} / {{ res.rsi }}</td>
                            <td>
                                {% if res.signal == 'BUY' %}
                                    <span class="badge-buy">BUY</span>
                                {% elif res.signal == 'SELL' %}
                                    <span class="badge-sell">SELL</span>
                                {% else %}
                                    <span class="badge-hold">HOLD</span>
                                {% endif %}
                            </td>
                        </tr>
                        {% endfor %}
                        {% if not state.signals %}
                        <tr><td colspan="7" class="text-center text-muted py-4">Waiting for next data cycle...</td></tr>
                        {% endif %}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- ROW 4: Open Positions -->
        <div class="card mt-2">
            <div class="card-header">Open Positions</div>
            <div class="card-body p-0">
                <table class="table table-hover mb-0">
                    <thead>
                        <tr>
                            <th>Symbol</th>
                            <th>Side</th>
                            <th>Entry Price</th>
                            <th>Qty</th>
                            <th>Stop Loss</th>
                            <th>Take Profit</th>
                        </tr>
                    </thead>
                    <tbody>
                        {% for pos in state.open_positions %}
                        <tr>
                            <td>{{ pos.symbol }}</td>
                            <td>
                                {% if pos.side == 'BUY' %}
                                    <span class="text-success font-weight-bold">LONG</span>
                                {% else %}
                                    <span class="text-danger font-weight-bold">SHORT</span>
                                {% endif %}
                            </td>
                            <td>${{ "%.2f"|format(pos.entry_price) }}</td>
                            <td>{{ "%.4f"|format(pos.qty) }}</td>
                            <td>${{ "%.2f"|format(pos.stop_loss) }}</td>
                            <td>${{ "%.2f"|format(pos.take_profit) }}</td>
                        </tr>
                        {% endfor %}
                        {% if not state.open_positions %}
                        <tr><td colspan="6" class="text-center text-muted py-4">No open positions</td></tr>
                        {% endif %}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="text-center text-muted small mt-4 mb-4">
            Last Updated: {{ state.last_update }} UTC | Auto-refreshing every 15s
        </div>
    </div>
    <script>
        function togglePause() {
            fetch('/api/toggle_pause', {method: 'POST'})
            .then(response => response.json())
            .then(data => location.reload());
        }
        function modifyFunds(action) {
            const amount = document.getElementById('fundAmount').value;
            if(!amount || amount <= 0) return alert("Enter a valid amount");
            
            fetch(`/api/${action}_funds`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({amount: parseFloat(amount)})
            })
            .then(response => response.json())
            .then(data => location.reload());
        }
    </script>
</body>
</html>
"""

@app.route('/')
def dashboard():
    return render_template_string(HTML_TEMPLATE, state=BOT_STATE, control=BOT_CONTROL)

@app.route('/api/state')
def get_state():
    return jsonify(BOT_STATE)

from flask import request

@app.route('/api/toggle_pause', methods=['POST'])
def toggle_pause():
    BOT_CONTROL["is_paused"] = not BOT_CONTROL["is_paused"]
    return jsonify({"status": "success", "is_paused": BOT_CONTROL["is_paused"]})

@app.route('/api/add_funds', methods=['POST'])
def add_funds():
    amount = request.json.get('amount', 0)
    BOT_CONTROL["funds_to_add"] += float(amount)
    return jsonify({"status": "success"})

@app.route('/api/remove_funds', methods=['POST'])
def remove_funds():
    amount = request.json.get('amount', 0)
    BOT_CONTROL["funds_to_remove"] += float(amount)
    return jsonify({"status": "success"})

def start_dashboard():
    """Runs the Flask server. Designed to be run in a daemon thread."""
    app.run(host="0.0.0.0", port=config.DASHBOARD_PORT, debug=False, use_reloader=False)

if __name__ == "__main__":
    start_dashboard()
