"""
OpenCV-based road hazard detector ("DETECT" stage of the pipeline —
ROAD CAMERA + IMU + GPS -> AI HAZARD DETECTION).

This ships a dependency-free classical-CV pipeline (grayscale ->
contrast normalisation -> edge/contour analysis -> shape scoring) so the
project runs out of the box on any laptop/Raspberry Pi with just
OpenCV, with NO trained-model download required for the demo.

A `HazardDetector` can optionally be handed a `model_path` to a
pre-trained OpenCV DNN model (ONNX / Caffe / TensorFlow) exported from a
YOLO/segmentation pothole dataset — swap in `_infer_dnn` and it becomes
a drop-in replacement without touching any other module. That is the
intended upgrade path from "hackathon prototype" to "production model".
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional

import cv2
import numpy as np

from software.config import VisionConfig, settings


class HazardType(str, Enum):
    POTHOLE = "pothole"
    CRACK = "crack"
    DEBRIS = "debris"
    UNKNOWN_HAZARD = "unknown_hazard"


@dataclass
class HazardDetection:
    """A single hazard candidate found in one video frame."""

    hazard_type: HazardType
    confidence: float
    # Bounding box in the source frame, pixels: (x, y, w, h)
    bbox: tuple[int, int, int, int]
    area_px: float
    circularity: float
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "hazard_type": self.hazard_type.value,
            "confidence": round(self.confidence, 3),
            "bbox": self.bbox,
            "area_px": round(self.area_px, 1),
            "circularity": round(self.circularity, 3),
            "timestamp": self.timestamp,
        }


class HazardDetector:
    """Vision-based hazard detector.

    Usage:
        detector = HazardDetector()
        detections = detector.process_frame(frame)   # frame: BGR np.ndarray
    """

    def __init__(self, config: Optional[VisionConfig] = None, model_path: Optional[str] = None):
        self.cfg = config or settings.vision
        self.model_path = model_path
        self._net = None
        if model_path:
            # Swap-in point for a trained DNN model (ONNX/Caffe/TF). Kept
            # optional so the classical pipeline is always the fallback.
            try:
                self._net = cv2.dnn.readNet(model_path)
            except Exception:
                self._net = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def process_frame(self, frame: np.ndarray) -> List[HazardDetection]:
        """Run hazard detection on a single BGR frame."""
        if self._net is not None:
            return self._infer_dnn(frame)
        return self._infer_classical(frame)

    # ------------------------------------------------------------------
    # Classical CV pipeline (no model download required)
    # ------------------------------------------------------------------
    def _infer_classical(self, frame: np.ndarray) -> List[HazardDetection]:
        cfg = self.cfg
        frame = cv2.resize(frame, (cfg.frame_width, cfg.frame_height))
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        blur = cv2.GaussianBlur(gray, (5, 5), 0)

        edges = cv2.Canny(blur, cfg.canny_low, cfg.canny_high)
        edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        detections: List[HazardDetection] = []
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < cfg.min_contour_area:
                continue

            perimeter = cv2.arcLength(contour, True)
            if perimeter == 0:
                continue

            circularity = 4 * np.pi * (area / (perimeter ** 2))
            x, y, w, h = cv2.boundingRect(contour)

            # Local darkness relative to the road surface is a strong
            # pothole cue (shadowed depression) — used as a texture score.
            roi = gray[y : y + h, x : x + w]
            darkness_score = 1.0 - (float(np.mean(roi)) / 255.0) if roi.size else 0.0

            hazard_type, shape_score = self._classify_shape(circularity, w, h)
            confidence = self._score_confidence(circularity, darkness_score, shape_score, area)

            if hazard_type is None or confidence < cfg.min_confidence:
                continue

            detections.append(
                HazardDetection(
                    hazard_type=hazard_type,
                    confidence=confidence,
                    bbox=(int(x), int(y), int(w), int(h)),
                    area_px=float(area),
                    circularity=float(circularity),
                )
            )

        # Highest-confidence detections first.
        detections.sort(key=lambda d: d.confidence, reverse=True)
        return detections

    @staticmethod
    def _classify_shape(circularity: float, w: int, h: int) -> tuple[Optional[HazardType], float]:
        cfg = settings.vision
        aspect_ratio = w / h if h else 0

        if circularity >= cfg.min_circularity and 0.4 <= aspect_ratio <= 2.5:
            # Roughly round/blobby depression -> pothole.
            return HazardType.POTHOLE, min(circularity, 1.0)

        if aspect_ratio > 3.0 or aspect_ratio < 0.33:
            # Long, thin contour -> surface crack.
            return HazardType.CRACK, 0.5

        if circularity < cfg.min_circularity:
            # Irregular blob, not elongated -> loose debris on the road.
            return HazardType.DEBRIS, 0.4

        return HazardType.UNKNOWN_HAZARD, 0.3

    @staticmethod
    def _score_confidence(circularity: float, darkness_score: float, shape_score: float, area: float) -> float:
        area_score = min(area / 15000.0, 1.0)
        confidence = 0.4 * shape_score + 0.35 * darkness_score + 0.25 * area_score
        return float(max(0.0, min(confidence, 1.0)))

    # ------------------------------------------------------------------
    # DNN pipeline (trained model hook — not required for the demo)
    # ------------------------------------------------------------------
    def _infer_dnn(self, frame: np.ndarray) -> List[HazardDetection]:  # pragma: no cover
        """Placeholder inference path for a trained ONNX/Caffe model.

        Kept intentionally simple: resize -> blob -> forward pass. Wire
        this up to your exported pothole-detection model's actual output
        layout (YOLO-style [cx, cy, w, h, obj, classes...] is common).
        """
        cfg = self.cfg
        blob = cv2.dnn.blobFromImage(
            frame, scalefactor=1 / 255.0, size=(cfg.frame_width, cfg.frame_height), swapRB=True, crop=False
        )
        self._net.setInput(blob)
        _ = self._net.forward()
        # Model-specific decode goes here. Falls back to classical CV so
        # the pipeline degrades gracefully if the model output isn't decoded.
        return self._infer_classical(frame)


def annotate_frame(frame: np.ndarray, detections: List[HazardDetection]) -> np.ndarray:
    """Draw bounding boxes + labels for the dashboard / demo video feed."""
    colors = {
        HazardType.POTHOLE: (0, 0, 255),
        HazardType.CRACK: (0, 165, 255),
        HazardType.DEBRIS: (0, 255, 255),
        HazardType.UNKNOWN_HAZARD: (200, 200, 200),
    }
    out = frame.copy()
    for det in detections:
        x, y, w, h = det.bbox
        color = colors.get(det.hazard_type, (255, 255, 255))
        cv2.rectangle(out, (x, y), (x + w, y + h), color, 2)
        label = f"{det.hazard_type.value} {det.confidence:.2f}"
        cv2.putText(out, label, (x, max(0, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
    return out
