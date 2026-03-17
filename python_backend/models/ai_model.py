"""
Random Forest Auxiliary Model
Traditional machine learning model to complement LSTM deep learning.
"""

import os
import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
import config

class AITradingModel:
    """Random Forest classifier for trade signals."""
    
    def __init__(self, symbol="BTC"):
        self.symbol = symbol.replace("/", "_")
        self.model = RandomForestClassifier(
            n_estimators=config.RF_N_ESTIMATORS,
            max_depth=config.RF_MAX_DEPTH,
            random_state=42,
            n_jobs=-1,
            class_weight='balanced'  # Crucial to prevent 'always HOLD'
        )
        self.scaler = StandardScaler()
        self.is_trained = False
        
        self.model_dir = "models/lstm_saved" # Share same dict
        if not os.path.exists(self.model_dir):
            os.makedirs(self.model_dir)
            
        self.model_path = os.path.join(self.model_dir, f"{self.symbol}_rf.pkl")
        self.scaler_path = os.path.join(self.model_dir, f"{self.symbol}_rf_scaler.pkl")

    def prepare_data(self, df, ml_features, fit_scaler=True):
        """Prepares 2D data for Random Forest."""
        data = df[ml_features].values
        
        if fit_scaler:
            data = self.scaler.fit_transform(data)
        else:
            data = self.scaler.transform(data)
            
        # Reduce the threshold from 0.005 (0.5%) to 0.002 (0.2%) for higher sensitivity
        returns = df['close'].shift(-1) / df['close'] - 1
        labels = np.ones(len(df)) # HOLD
        labels[returns > 0.002] = 2 # BUY
        labels[returns < -0.002] = 0 # SELL
        
        # Remove last row since it has no next return
        return data[:-1], labels[:-1]

    def train(self, df, ml_features):
        """Train the RF model."""
        print(f"🔄 Training Random Forest for {self.symbol}...")
        df_clean = df.dropna().copy()
        
        X, y = self.prepare_data(df_clean, ml_features, fit_scaler=True)
        if len(X) == 0:
            return 0.0
            
        split = int(len(X) * config.TRAIN_TEST_SPLIT)
        X_train, X_test = X[:split], X[split:]
        y_train, y_test = y[:split], y[split:]
        
        self.model.fit(X_train, y_train)
        accuracy = self.model.score(X_test, y_test)
        
        joblib.dump(self.model, self.model_path)
        joblib.dump(self.scaler, self.scaler_path)
        self.is_trained = True
        
        print(f"✅ Random Forest Training complete for {self.symbol}. Test Accuracy: {accuracy*100:.2f}%")
        return accuracy

    def load_model(self):
        if os.path.exists(self.model_path) and os.path.exists(self.scaler_path):
            self.model = joblib.load(self.model_path)
            self.scaler = joblib.load(self.scaler_path)
            self.is_trained = True
            return True
        return False

    def predict(self, df, ml_features):
        """Predict current state using RF."""
        if not self.is_trained:
            if not self.load_model():
                return "HOLD", 0.0
                
        last_data = df[ml_features].iloc[-1:].values
        scaled_data = self.scaler.transform(last_data)
        
        preds = self.model.predict_proba(scaled_data)[0]
        class_idx = np.argmax(preds)
        confidence = preds[class_idx] * 100.0
        
        labels_map = {0: "SELL", 1: "HOLD", 2: "BUY"}
        return labels_map[class_idx], confidence
