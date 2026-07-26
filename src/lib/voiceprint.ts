/**
 * 声纹特征提取模块
 * 通过 Web Audio API 提取音频特征，用于说话人聚类
 */

export interface VoiceprintFeature {
  rms: number;
  peak: number;
  dynamicRange: number;
  f0Mean: number;
  f0Median: number;
  f0Range: number;
  f0Std: number;
  spectralCentroid: number;
  spectralBandwidth: number;
  spectralRolloff: number;
  spectralFlatness: number;
  spectralFlux: number;
}

export interface SpeakerCluster {
  id: number;
  features: VoiceprintFeature[];
  centroid: VoiceprintFeature;
}

/**
 * 从 Float32Array 音频数据提取声纹特征
 */
export function extractFeatures(audioData: Float32Array, sampleRate: number = 16000): VoiceprintFeature {
  const n = audioData.length;

  // 1. 音量特征
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const val = Math.abs(audioData[i]);
    sumSquares += audioData[i] * audioData[i];
    if (val > peak) peak = val;
  }
  const rms = Math.sqrt(sumSquares / n);
  const dynamicRange = peak > 0 ? 20 * Math.log10(peak / (rms + 1e-10)) : 0;

  // 2. 基频 F0（自相关法）
  const f0Values = computeF0(audioData, sampleRate);
  const f0Mean = mean(f0Values);
  const f0Median = median(f0Values);
  const f0Range = f0Values.length > 0 ? Math.max(...f0Values) - Math.min(...f0Values) : 0;
  const f0Std = std(f0Values);

  // 3. 频谱特征
  const fft = computeFFT(audioData);
  const magnitudes = fft.map((v) => Math.sqrt(v.re * v.re + v.im * v.im));
  const freqs = fft.map((_, i) => (i * sampleRate) / (2 * fft.length));

  const spectralCentroid = computeSpectralCentroid(magnitudes, freqs);
  const spectralBandwidth = computeSpectralBandwidth(magnitudes, freqs, spectralCentroid);
  const spectralRolloff = computeSpectralRolloff(magnitudes, freqs);
  const spectralFlatness = computeSpectralFlatness(magnitudes);
  const spectralFlux = computeSpectralFlux(magnitudes);

  return {
    rms,
    peak,
    dynamicRange,
    f0Mean,
    f0Median,
    f0Range,
    f0Std,
    spectralCentroid,
    spectralBandwidth,
    spectralRolloff,
    spectralFlatness,
    spectralFlux,
  };
}

/**
 * 计算基频 F0（自相关法）
 */
function computeF0(audioData: Float32Array, sampleRate: number): number[] {
  const frameSize = Math.floor(sampleRate * 0.03); // 30ms帧
  const hopSize = Math.floor(frameSize / 2);
  const f0Values: number[] = [];

  const minLag = Math.floor(sampleRate / 500); // 最高500Hz
  const maxLag = Math.floor(sampleRate / 80);  // 最低80Hz

  for (let start = 0; start + frameSize <= audioData.length; start += hopSize) {
    const frame = audioData.slice(start, start + frameSize);
    let bestLag = 0;
    let bestCorr = 0;

    for (let lag = minLag; lag <= maxLag && lag < frameSize; lag++) {
      let corr = 0;
      let energy1 = 0;
      let energy2 = 0;
      for (let i = 0; i < frameSize - lag; i++) {
        corr += frame[i] * frame[i + lag];
        energy1 += frame[i] * frame[i];
        energy2 += frame[i + lag] * frame[i + lag];
      }
      const norm = Math.sqrt(energy1 * energy2);
      if (norm > 0) corr /= norm;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    if (bestCorr > 0.3 && bestLag > 0) {
      f0Values.push(sampleRate / bestLag);
    }
  }

  return f0Values;
}

/**
 * 计算 FFT（简化版，使用 Cooley-Tukey）
 */
function computeFFT(signal: Float32Array): Complex[] {
  const n = signal.length;
  if (n <= 1) {
    const result: Complex[] = new Array(n);
    for (let i = 0; i < n; i++) {
      result[i] = { re: signal[i], im: 0 };
    }
    return result;
  }

  if (n & (n - 1)) {
    const nextPow2 = Math.pow(2, Math.ceil(Math.log2(n)));
    const padded = new Float32Array(nextPow2);
    padded.set(signal);
    return computeFFT(padded);
  }

  const even = new Float32Array(n / 2);
  const odd = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    even[i] = signal[2 * i];
    odd[i] = signal[2 * i + 1];
  }

  const evenFFT = computeFFT(even);
  const oddFFT = computeFFT(odd);

  const result: Complex[] = new Array(n);
  for (let k = 0; k < n / 2; k++) {
    const angle = (-2 * Math.PI * k) / n;
    const t = {
      re: oddFFT[k].re * Math.cos(angle) - oddFFT[k].im * Math.sin(angle),
      im: oddFFT[k].re * Math.sin(angle) + oddFFT[k].im * Math.cos(angle),
    };
    result[k] = {
      re: evenFFT[k].re + t.re,
      im: evenFFT[k].im + t.im,
    };
    result[k + n / 2] = {
      re: evenFFT[k].re - t.re,
      im: evenFFT[k].im - t.im,
    };
  }

  return result;
}

interface Complex {
  re: number;
  im: number;
}

/**
 * 频谱质心
 */
function computeSpectralCentroid(magnitudes: number[], freqs: number[]): number {
  let weightedSum = 0;
  let totalMag = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    weightedSum += magnitudes[i] * freqs[i];
    totalMag += magnitudes[i];
  }
  return totalMag > 0 ? weightedSum / totalMag : 0;
}

/**
 * 频谱带宽
 */
function computeSpectralBandwidth(magnitudes: number[], freqs: number[], centroid: number): number {
  let weightedSum = 0;
  let totalMag = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    weightedSum += magnitudes[i] * Math.pow(freqs[i] - centroid, 2);
    totalMag += magnitudes[i];
  }
  return totalMag > 0 ? Math.sqrt(weightedSum / totalMag) : 0;
}

/**
 * 频谱滚降点（85%能量处）
 */
function computeSpectralRolloff(magnitudes: number[], freqs: number[]): number {
  const totalEnergy = magnitudes.reduce((sum, m) => sum + m * m, 0);
  const threshold = totalEnergy * 0.85;
  let cumulative = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    cumulative += magnitudes[i] * magnitudes[i];
    if (cumulative >= threshold) return freqs[i];
  }
  return freqs[freqs.length - 1] || 0;
}

/**
 * 频谱平坦度（几何均值/算术均值）
 */
function computeSpectralFlatness(magnitudes: number[]): number {
  if (magnitudes.length === 0) return 0;
  let logSum = 0;
  let linearSum = 0;
  for (const m of magnitudes) {
    if (m > 0) logSum += Math.log(m);
    linearSum += m;
  }
  const geoMean = Math.exp(logSum / magnitudes.length);
  const linMean = linearSum / magnitudes.length;
  return linMean > 0 ? geoMean / linMean : 0;
}

/**
 * 频谱通量（相邻帧差异）
 */
function computeSpectralFlux(magnitudes: number[]): number {
  if (magnitudes.length < 2) return 0;
  let flux = 0;
  for (let i = 1; i < magnitudes.length; i++) {
    const diff = magnitudes[i] - magnitudes[i - 1];
    flux += diff * diff;
  }
  return Math.sqrt(flux / (magnitudes.length - 1));
}

// 数学工具函数
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function std(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
}

/**
 * 计算两个特征向量的余弦相似度
 */
export function compareFeatures(a: VoiceprintFeature, b: VoiceprintFeature): number {
  const aVec = featureToVector(a);
  const bVec = featureToVector(b);

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < aVec.length; i++) {
    dotProduct += aVec[i] * bVec[i];
    normA += aVec[i] * aVec[i];
    normB += bVec[i] * bVec[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dotProduct / denominator : 0;
}

/**
 * 将特征转为归一化的向量
 */
function featureToVector(f: VoiceprintFeature): number[] {
  return [
    f.rms * 10,
    f.peak * 5,
    f.dynamicRange / 10,
    f.f0Mean / 200,
    f.f0Median / 200,
    f.f0Range / 200,
    f.f0Std / 100,
    f.spectralCentroid / 2000,
    f.spectralBandwidth / 1000,
    f.spectralRolloff / 4000,
    f.spectralFlatness,
    f.spectralFlux * 10,
  ];
}

/**
 * 说话人聚类
 * @param sentenceFeatures 每句话的特征
 * @param threshold 相似度阈值（越高越严格，说话人越多）
 * @returns 每句话的说话人ID
 */
export function clusterSpeakers(
  sentenceFeatures: VoiceprintFeature[],
  threshold: number = 0.6
): number[] {
  const clusters: SpeakerCluster[] = [];
  const speakerIds: number[] = [];

  for (const feature of sentenceFeatures) {
    let bestCluster = -1;
    let bestSimilarity = -1;

    // 找最相似的已有说话人
    for (let i = 0; i < clusters.length; i++) {
      const similarity = compareFeatures(feature, clusters[i].centroid);
      if (similarity > bestSimilarity && similarity > threshold) {
        bestSimilarity = similarity;
        bestCluster = i;
      }
    }

    if (bestCluster >= 0) {
      // 归入已有说话人
      clusters[bestCluster].features.push(feature);
      clusters[bestCluster].centroid = computeCentroid(clusters[bestCluster].features);
      speakerIds.push(clusters[bestCluster].id);
    } else {
      // 创建新说话人
      const newId = clusters.length;
      clusters.push({
        id: newId,
        features: [feature],
        centroid: feature,
      });
      speakerIds.push(newId);
    }
  }

  return speakerIds;
}

/**
 * 计算多个特征的质心
 */
function computeCentroid(features: VoiceprintFeature[]): VoiceprintFeature {
  const n = features.length;
  const sum = features.reduce(
    (acc, f) => ({
      rms: acc.rms + f.rms,
      peak: acc.peak + f.peak,
      dynamicRange: acc.dynamicRange + f.dynamicRange,
      f0Mean: acc.f0Mean + f.f0Mean,
      f0Median: acc.f0Median + f.f0Median,
      f0Range: acc.f0Range + f.f0Range,
      f0Std: acc.f0Std + f.f0Std,
      spectralCentroid: acc.spectralCentroid + f.spectralCentroid,
      spectralBandwidth: acc.spectralBandwidth + f.spectralBandwidth,
      spectralRolloff: acc.spectralRolloff + f.spectralRolloff,
      spectralFlatness: acc.spectralFlatness + f.spectralFlatness,
      spectralFlux: acc.spectralFlux + f.spectralFlux,
    }),
    {
      rms: 0, peak: 0, dynamicRange: 0,
      f0Mean: 0, f0Median: 0, f0Range: 0, f0Std: 0,
      spectralCentroid: 0, spectralBandwidth: 0, spectralRolloff: 0,
      spectralFlatness: 0, spectralFlux: 0,
    }
  );

  return {
    rms: sum.rms / n,
    peak: sum.peak / n,
    dynamicRange: sum.dynamicRange / n,
    f0Mean: sum.f0Mean / n,
    f0Median: sum.f0Median / n,
    f0Range: sum.f0Range / n,
    f0Std: sum.f0Std / n,
    spectralCentroid: sum.spectralCentroid / n,
    spectralBandwidth: sum.spectralBandwidth / n,
    spectralRolloff: sum.spectralRolloff / n,
    spectralFlatness: sum.spectralFlatness / n,
    spectralFlux: sum.spectralFlux / n,
  };
}
