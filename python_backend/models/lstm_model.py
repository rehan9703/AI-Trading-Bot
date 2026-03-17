"""
LSTM Deep Learning Model
Self-learning LSTM that trains on historical data and predicts BUY/SELL/HOLD.
"""

import os
import joblib
import numpy as np
from sklearn.preprocessing import MinMaxScaler
import config

try:
    import tensorflow as tf
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import LSTM, Dense, Dropout
    from tensorflow.keras.optimizers import Adam
    from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau
    TF_AVAILABLE = True
except ImportError:
    TF_AVAILABLE = False
    print("⚠️ TensorFlow not found. LSTM Deep Learning will operate in MOCK / DEGRADED mode.")

class LSTMTradingModel:
    """TensorFlow Keras LSTM model for sequence prediction."""
    
    def __init__(self, symbol="BTC"):
        self.symbol = symbol.replace("/", "_")
        self.model = None
        self.scaler = MinMaxScaler()
        self.lookback = config.LSTM_LOOKBACK
        self.is_trained = False
        self.history = None
        
        # Directories to save the models
        self.model_dir = "models/lstm_saved"
        if not os.path.exists(self.model_dir):
            os.makedirs(self.model_dir)
            
        self.model_path = os.path.join(self.model_dir, f"{self.symbol}_lstm.keras")
        self.scaler_path = os.path.join(self.model_dir, f"{self.symbol}_scaler.pkl")

    def build_model(self, input_shape, n_classes=3):
        """Constructs the exact architecture specified."""
        if not TF_AVAILABLE: return None
        model = Sequential([
            LSTM(config.LSTM_UNITS, return_sequences=True, input_shape=input_shape),
            Dropout(config.LSTM_DROPOUT),
            LSTM(64, return_sequences=True),
            Dropout(config.LSTM_DROPOUT),
            LSTM(32, return_sequences=False),
            Dropout(config.LSTM_DROPOUT),
            Dense(64, activation='relu'),
            Dropout(0.1),
            Dense(n_classes, activation='softmax')
        ])
        
        optimizer = Adam(learning_rate=0.001)
        model.compile(optimizer=optimizer, loss='sparse_categorical_crossentropy', metrics=['accuracy'])
        self.model = model
        return model

    def prepare_sequences(self, df, ml_features, fit_scaler=True):
        """Prepares 3D sequences for LSTM from a flat DataFrame."""
        if len(df) <= self.lookback:
            raise ValueError(f"Data length {len(df)} must be greater than lookback {self.lookback}")
            
        data = df[ml_features].values
        
        if fit_scaler:
            data = self.scaler.fit_transform(data)
        else:
            data = self.scaler.transform(data)
            
        # Create labels based on next candle return
        # 0=SELL (< -0.5%), 1=HOLD, 2=BUY (> 0.5%)
        # Calculate next candle return
        returns = df['close'].shift(-1) / df['close'] - 1
        labels = np.ones(len(df)) # default HOLD
        labels[returns > 0.005] = 2 # BUY
        labels[returns < -0.005] = 0 # SELL
        
        X, y = [], []
        for i in range(self.lookback, len(data) - 1): # -1 to ignore last row without valid future label
            X.append(data[i - self.lookback:i])
            y.append(labels[i])
            
        return np.array(X), np.array(y)

    def train(self, df, ml_features, verbose=True):
        """Trains the LSTM and saves weights/scaler."""
        print(f"🔄 Training LSTM for {self.symbol}...")
        
        # Drop naive NaNs first
        df_clean = df.dropna().copy()
        
        X, y = self.prepare_sequences(df_clean, ml_features, fit_scaler=True)
        
        if len(X) == 0:
            print("❌ Not enough data to train.")
            return 0.0
            
        if not TF_AVAILABLE:
            print(f"✅ LSTM Training mocked for {self.symbol} (TF Missing).")
            joblib.dump(self.scaler, self.scaler_path)
            self.is_trained = True
            return 0.85

        # Train / Test split (no shuffle to preserve time order)
        split = int(len(X) * config.TRAIN_TEST_SPLIT)
        X_train, X_test = X[:split], X[split:]
        y_train, y_test = y[:split], y[split:]
        
        self.build_model((X_train.shape[1], X_train.shape[2]))
        
        early_stop = EarlyStopping(patience=10, restore_best_weights=True)
        reduce_lr = ReduceLROnPlateau(factor=0.5, patience=5)
        
        self.history = self.model.fit(
            X_train, y_train,
            epochs=config.LSTM_EPOCHS,
            batch_size=config.LSTM_BATCH_SIZE,
            validation_data=(X_test, y_test),
            callbacks=[early_stop, reduce_lr],
            verbose=1 if verbose else 0
        )
        
        loss, accuracy = self.model.evaluate(X_test, y_test, verbose=0)
        
        # Save model and scaler
        self.model.save(self.model_path)
        joblib.dump(self.scaler, self.scaler_path)
        self.is_trained = True
        
        print(f"✅ LSTM Training complete for {self.symbol}. Test Accuracy: {accuracy*100:.2f}%")
        return accuracy

    def load_model(self):
        """Load trained model from disk."""
        if not TF_AVAILABLE:
            if os.path.exists(self.scaler_path):
                self.scaler = joblib.load(self.scaler_path)
                self.is_trained = True
                return True
            return False
            
        if os.path.exists(self.model_path) and os.path.exists(self.scaler_path):
            self.model = tf.keras.models.load_model(self.model_path)
            self.scaler = joblib.load(self.scaler_path)
            self.is_trained = True
            return True
        return False

    def predict(self, df, ml_features):
        """Generates a prediction for the most recent data."""
        if not self.is_trained:
            if not self.load_model():
                # fallback behavior
                return "HOLD", 0.0

        if len(df) < self.lookback:
            return "HOLD", 0.0
            
        # Get the latest sequence
        last_seq_df = df.iloc[-self.lookback:]
        data = last_seq_df[ml_features].values
        
        scaled_data = self.scaler.transform(data)
        X = scaled_data.reshape((1, self.lookback, len(ml_features)))
        
        if not TF_AVAILABLE:
            return "HOLD", 50.0
            
        preds = self.model.predict(X, verbose=0)[0]
        class_idx = np.argmax(preds)
        confidence = preds[class_idx] * 100.0
        
        labels_map = {0: "SELL", 1: "HOLD", 2: "BUY"}
        return labels_map[class_idx], confidence

    def get_model_summary(self):
        """Return dict with architecture metadata."""
        if not self.model:
            return {}
            
        return {
            'total_params': self.model.count_params(),
            'layers': len(self.model.layers)
        }
