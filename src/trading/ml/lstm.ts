import * as tf from '@tensorflow/tfjs';

// Simple LSTM model for time-series prediction
const model = tf.sequential();
model.add(tf.layers.lstm({
  units: 32,
  inputShape: [10, 1], // 10 time steps, 1 feature (price)
  returnSequences: false
}));
model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
model.compile({ optimizer: 'adam', loss: 'binaryCrossentropy' });

export async function predict(data: number[]): Promise<number> {
  if (data.length < 10) return 0.5;
  
  // Prepare data: take last 10 points
  const inputData = data.slice(-10);
  // Shape: [batchSize, timeSteps, features]
  const inputTensor = tf.tensor3d([inputData.map(d => [d])], [1, 10, 1]);
  
  const prediction = model.predict(inputTensor) as tf.Tensor;
  const result = (await prediction.data())[0];
  
  inputTensor.dispose();
  prediction.dispose();
  
  return result;
}
