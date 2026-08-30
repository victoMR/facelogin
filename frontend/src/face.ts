import * as faceapi from "@vladmandic/face-api";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";

let modelsReady = false;

export async function loadModels(): Promise<void> {
  if (modelsReady) return;
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsReady = true;
}

export type FaceSample = {
  descriptor: number[];
  box: { x: number; y: number; width: number; height: number };
  score: number;
  landmarks: faceapi.FaceLandmarks68;
};

export async function detectFace(input: HTMLVideoElement): Promise<FaceSample | null> {
  const result = await faceapi
    .detectSingleFace(
      input,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.55 }),
    )
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!result) return null;

  const { box, score } = result.detection;
  if (score < 0.7 || box.width < 120 || box.height < 120) return null;

  const frameW = input.videoWidth;
  const frameH = input.videoHeight;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const centered =
    Math.abs(cx - frameW / 2) < frameW * 0.22 && Math.abs(cy - frameH / 2) < frameH * 0.22;
  if (!centered) return null;

  return {
    descriptor: Array.from(result.descriptor),
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    score,
    landmarks: result.landmarks,
  };
}
