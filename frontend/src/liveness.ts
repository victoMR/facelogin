import type { FaceLandmarks68 } from "@vladmandic/face-api";

export type ChallengeId = "center" | "blink" | "left" | "right";

export const enrollChallenges: ChallengeId[] = ["center", "blink", "left", "right", "blink"];
export const loginChallenges: ChallengeId[] = ["center", "blink"];

export function challengeLabel(id: ChallengeId): string {
  switch (id) {
    case "center":
      return "Mira de frente y quédate quieto";
    case "blink":
      return "Parpadea con naturalidad";
    case "left":
      return "Gira un poco el rostro a tu izquierda";
    case "right":
      return "Gira un poco el rostro a tu derecha";
  }
}

function eyeAspect(landmarks: FaceLandmarks68, eye: "left" | "right"): number {
  const points = eye === "left" ? landmarks.getLeftEye() : landmarks.getRightEye();
  const vertical =
    (distance(points[1], points[5]) + distance(points[2], points[4])) / 2;
  const horizontal = distance(points[0], points[3]);
  return vertical / horizontal;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function yaw(landmarks: FaceLandmarks68): number {
  const nose = landmarks.getNose()[3];
  const left = landmarks.getLeftEye()[0];
  const right = landmarks.getRightEye()[3];
  const mid = (left.x + right.x) / 2;
  const span = Math.max(right.x - left.x, 1);
  return (nose.x - mid) / span;
}

export function isBlinking(landmarks: FaceLandmarks68): boolean {
  return (eyeAspect(landmarks, "left") + eyeAspect(landmarks, "right")) / 2 < 0.21;
}

export function challengeMet(id: ChallengeId, landmarks: FaceLandmarks68): boolean {
  const angle = yaw(landmarks);
  switch (id) {
    case "center":
      return Math.abs(angle) < 0.12;
    case "blink":
      return isBlinking(landmarks);
    case "left":
      return angle < -0.16;
    case "right":
      return angle > 0.16;
  }
}
