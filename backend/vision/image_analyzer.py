"""Visão computacional local para o laboratório de enxames GRID SOUL.

A entrada é uma imagem fornecida explicitamente pelo navegador local. A saída
contém estatísticas, camadas PNG e amostras regulares de cor/posição; não cria
um CAD certificado nem afirma que a projeção visual é uma peça imprimível.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import math
import sys
import time
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_SOURCE_PIXELS = 40_000_000
MAX_SIDE = 2048
MAX_SAMPLES = 100_000
ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP"}


def _data_url_bytes(value: str, *, maximum: int = MAX_INPUT_BYTES) -> bytes:
    if not isinstance(value, str) or len(value) > maximum * 4 // 3 + 256:
        raise ValueError("A imagem excede o limite de upload de 8 MiB.")
    if value.startswith("data:"):
        header, sep, encoded = value.partition(",")
        if not sep or ";base64" not in header.lower():
            raise ValueError("A imagem deve ser enviada como data URL base64.")
        declared = header[5:].split(";", 1)[0].lower()
        if declared not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("Formato de imagem não permitido; use PNG, JPG ou WEBP.")
    else:
        encoded = value
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("O conteúdo base64 da imagem é inválido.") from exc
    if not data or len(data) > maximum:
        raise ValueError("A imagem está vazia ou excede 8 MiB.")
    return data


def _png_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def load_image(value: str | bytes, *, background: tuple[int, int, int] = (2, 7, 17)) -> tuple[np.ndarray, dict[str, Any]]:
    """Open a supported image, apply EXIF orientation and composite alpha locally."""
    raw = _data_url_bytes(value) if isinstance(value, str) else bytes(value)
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise ValueError("A imagem está vazia ou excede 8 MiB.")
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            fmt = (opened.format or "").upper()
            if fmt not in ALLOWED_FORMATS:
                raise ValueError("Formato não permitido; use PNG, JPG, JPEG ou WEBP.")
            oriented = ImageOps.exif_transpose(opened)
            original_width, original_height = oriented.size
            if original_width < 1 or original_height < 1 or original_width * original_height > MAX_SOURCE_PIXELS:
                raise ValueError("A imagem excede o limite de 40 megapixels.")
            rgba = oriented.convert("RGBA")
            matte = Image.new("RGBA", rgba.size, (*background, 255))
            rgb_image = Image.alpha_composite(matte, rgba).convert("RGB")
            factor = min(1.0, MAX_SIDE / max(rgb_image.size), math.sqrt((MAX_SIDE * MAX_SIDE) / (rgb_image.width * rgb_image.height)))
            if factor < 1:
                size = (max(1, round(rgb_image.width * factor)), max(1, round(rgb_image.height * factor)))
                rgb_image = rgb_image.resize(size, Image.Resampling.LANCZOS)
            rgb = np.asarray(rgb_image, dtype=np.uint8)
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Não foi possível decodificar a imagem enviada.") from exc
    return rgb, {
        "format": fmt,
        "originalWidth": original_width,
        "originalHeight": original_height,
        "width": int(rgb.shape[1]),
        "height": int(rgb.shape[0]),
        "pixelsProcessed": int(rgb.shape[0] * rgb.shape[1]),
        "alphaComposited": "#020711",
        "resizedForProcessing": bool(rgb.shape[1] != original_width or rgb.shape[0] != original_height),
    }


def _decode_annotation(value: str | None, size: tuple[int, int], rotation_degrees: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Return manual-priority and ignore masks resized to the processed image."""
    width, height = size
    empty = np.zeros((height, width), dtype=np.uint8)
    if not value:
        return empty.copy(), empty.copy()
    raw = _data_url_bytes(value, maximum=5 * 1024 * 1024)
    base_width, base_height = (height, width) if rotation_degrees in {90, 270} else (width, height)
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            rgba = np.asarray(opened.convert("RGBA").resize((base_width, base_height), Image.Resampling.NEAREST), dtype=np.uint8)
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("A camada de marcações não pôde ser lida.") from exc
    visible = rgba[:, :, 3] > 24
    ignore = visible & (rgba[:, :, 0] < 32) & (rgba[:, :, 1] < 32) & (rgba[:, :, 2] < 32)
    priority = np.where(visible & ~ignore, rgba[:, :, 3], 0).astype(np.uint8)
    if rotation_degrees == 90:
        priority, ignore = np.rot90(priority, k=3), np.rot90(ignore, k=3)
    elif rotation_degrees == 180:
        priority, ignore = np.rot90(priority, k=2), np.rot90(ignore, k=2)
    elif rotation_degrees == 270:
        priority, ignore = np.rot90(priority, k=1), np.rot90(ignore, k=1)
    return priority, ignore.astype(np.uint8) * 255


def analyze_color_palette(rgb: np.ndarray, colors: int = 32, seed: int = 20261022) -> tuple[list[dict[str, Any]], np.ndarray]:
    """Quantize colors in CIELAB with deterministic OpenCV k-means."""
    colors = int(colors)
    if colors not in {8, 16, 32, 64, 128}:
        raise ValueError("A paleta deve preservar 8, 16, 32, 64 ou 128 cores.")
    small = cv2.resize(rgb, (min(256, rgb.shape[1]), min(256, rgb.shape[0])), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    unique_count = int(np.unique(lab, axis=0).shape[0])
    k = max(1, min(colors, unique_count, lab.shape[0]))
    cv2.setRNGSeed(int(seed) & 0x7FFFFFFF)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.25)
    _compactness, labels, centers = cv2.kmeans(lab, k, None, criteria, 1, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.reshape(-1), minlength=k)
    order = sorted(range(k), key=lambda i: (-int(counts[i]), i))
    palette: list[dict[str, Any]] = []
    centers_rgb = []
    for index in order:
        lab_pixel = np.clip(np.rint(centers[index]), 0, 255).astype(np.uint8).reshape(1, 1, 3)
        color = cv2.cvtColor(lab_pixel, cv2.COLOR_LAB2RGB)[0, 0]
        rgb_color = [int(v) for v in color]
        centers_rgb.append(rgb_color)
        palette.append({"rgb": rgb_color, "hex": "#%02X%02X%02X" % tuple(rgb_color), "fraction": float(counts[index] / labels.size)})
    return palette, np.asarray(centers_rgb, dtype=np.uint8)


def detect_edges(rgb: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0.8)
    return cv2.Canny(blurred, 70, 150, L2gradient=True)


def unrotate_array(array: np.ndarray, rotation_degrees: int) -> np.ndarray:
    """Return an array to the uploaded image's orientation for aligned overlays."""
    if rotation_degrees == 90:
        return cv2.rotate(array, cv2.ROTATE_90_COUNTERCLOCKWISE)
    if rotation_degrees == 180:
        return cv2.rotate(array, cv2.ROTATE_180)
    if rotation_degrees == 270:
        return cv2.rotate(array, cv2.ROTATE_90_CLOCKWISE)
    return array


def detect_contours(edge_map: np.ndarray) -> list[dict[str, float]]:
    contours, _hierarchy = cv2.findContours(edge_map, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    results = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if len(contour) < 3:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        results.append({"x": float(x), "y": float(y), "width": float(width), "height": float(height), "area": area})
    results.sort(key=lambda item: (-item["area"], item["y"], item["x"]))
    return results[:500]


def segment_regions(rgb: np.ndarray, palette_rgb: np.ndarray) -> tuple[np.ndarray, int]:
    """Assign each preview pixel to its nearest palette entry in CIELAB."""
    small = cv2.resize(rgb, (min(320, rgb.shape[1]), min(320, rgb.shape[0])), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB).astype(np.int16)
    palette_lab = cv2.cvtColor(palette_rgb.reshape(1, -1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.int16)
    nearest = np.zeros(lab.shape[:2], dtype=np.uint8)
    best = np.full(lab.shape[:2], np.iinfo(np.int32).max, dtype=np.int32)
    for index, center in enumerate(palette_lab):
        delta = lab - center
        distance = np.sum(delta.astype(np.int32) ** 2, axis=2)
        update = distance < best
        nearest[update] = index
        best[update] = distance[update]
    segmented = palette_rgb[nearest]
    return segmented, int(np.unique(nearest).size)


def extract_features(rgb: np.ndarray, edge_map: np.ndarray) -> dict[str, float]:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.magnitude(gx, gy)
    values = gray.reshape(-1)
    return {
        "brightnessMean": float(np.mean(hsv[:, :, 2]) / 255.0),
        "brightnessMedian": float(np.median(hsv[:, :, 2]) / 255.0),
        "darkPixelFraction": float(np.mean(hsv[:, :, 2] < 64)),
        "highlightFraction": float(np.mean(hsv[:, :, 2] > 224)),
        "saturationMean": float(np.mean(hsv[:, :, 1]) / 255.0),
        "contrastStdDev": float(np.std(values) / 255.0),
        "edgePixelFraction": float(np.mean(edge_map > 0)),
        "gradientMean": float(np.mean(gradient) / 255.0),
    }


def generate_swarm_coordinates(
    rgb: np.ndarray,
    edge_map: np.ndarray,
    count: int = 24_000,
    physical_width_mm: float = 150.0,
    colors: int = 32,
    seed: int = 20261022,
    edge_weight: float = 1.0,
    annotation_value: str | None = None,
    rotation_degrees: int = 0,
) -> dict[str, Any]:
    """Build an even, deterministic aspect-preserving 2D sampling lattice."""
    count = max(1, min(MAX_SAMPLES, int(count)))
    width_mm = float(physical_width_mm)
    if not math.isfinite(width_mm) or not 10 <= width_mm <= 1_000_000:
        raise ValueError("A largura física de referência deve estar entre 10 e 1.000.000 mm.")
    if not math.isfinite(float(edge_weight)) or not 0 <= float(edge_weight) <= 3:
        raise ValueError("O peso dos contornos deve estar entre 0 e 3.")
    palette, palette_rgb = analyze_color_palette(rgb, colors, seed)
    height, width = rgb.shape[:2]
    aspect = width / height
    target_cols = max(1, round(math.sqrt(count * aspect)))
    candidates = []
    for cols in range(max(1, target_cols - 180), min(count, target_cols + 181)):
        rows = max(1, count // cols)
        actual = rows * cols
        candidates.append((abs(math.log((cols / rows) / aspect)), -actual, cols, rows))
    _error, _negative_actual, cols, rows = min(candidates)
    actual_count = cols * rows
    samples_rgb = cv2.resize(rgb, (cols, rows), interpolation=cv2.INTER_AREA)
    samples_edges = cv2.resize(edge_map, (cols, rows), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    manual_priority, ignore_mask = _decode_annotation(annotation_value, (width, height), rotation_degrees)
    manual_grid = cv2.resize(manual_priority, (cols, rows), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    ignored_grid = cv2.resize(ignore_mask, (cols, rows), interpolation=cv2.INTER_AREA)

    sample_lab = cv2.cvtColor(samples_rgb, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.int16)
    palette_lab = cv2.cvtColor(palette_rgb.reshape(1, -1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.int16)
    best = np.full(actual_count, np.iinfo(np.int32).max, dtype=np.int32)
    nearest = np.zeros(actual_count, dtype=np.uint8)
    for index, center in enumerate(palette_lab):
        delta = sample_lab - center
        distance = np.sum(delta.astype(np.int32) ** 2, axis=1)
        update = distance < best
        nearest[update] = index
        best[update] = distance[update]
    selected_rgb = palette_rgb[nearest].reshape(rows, cols, 3)

    scene_height_mm = width_mm * height / width
    edge_values = samples_edges.reshape(-1)
    manual_values = manual_grid.reshape(-1)
    ignored = ignored_grid.reshape(-1) >= 128
    importance = np.clip(edge_values * float(edge_weight) + manual_values * 2.0, 0.0, 3.0) / 3.0
    samples: list[list[int | float]] = []
    kept_edges: list[int] = []
    for index in range(actual_count):
        if ignored[index]:
            continue
        row, col = divmod(index, cols)
        x_norm = ((col + 0.5) / cols) - 0.5
        y_norm = 0.5 - ((row + 0.5) / rows)
        r, g, b = (int(v) for v in selected_rgb[row, col])
        priority = int(round(importance[index] * 255))
        samples.append([round(x_norm, 6), round(y_norm, 6), r, g, b, priority])
        if edge_values[index] > 0.25 or manual_values[index] > 0.05:
            kept_edges.append(len(samples) - 1)
    if not samples:
        raise ValueError("A máscara de exclusão removeu todas as células; limpe ou ajuste as marcações.")
    physical_height_mm = scene_height_mm
    cube_width_mm = width_mm / cols
    cube_height_mm = physical_height_mm / rows
    return {
        "columns": cols,
        "rows": rows,
        "requestedCount": count,
        "count": len(samples),
        "gridCellCount": actual_count,
        "physicalWidthMm": round(width_mm, 4),
        "physicalHeightMm": round(physical_height_mm, 4),
        "cubeWidthMm": round(cube_width_mm, 6),
        "cubeHeightMm": round(cube_height_mm, 6),
        "aspectRatio": round(aspect, 8),
        "samples": samples,
        "prioritySampleIndices": kept_edges[:20_000],
        "palette": palette,
        "seed": int(seed),
        "warnings": (["A dimensão média de cada célula é menor que 0,4 mm; isso é uma representação visual, não garantia de fabricação."] if min(cube_width_mm, cube_height_mm) < 0.4 else []),
    }


def create_overlay(rgb: np.ndarray, edge_map: np.ndarray, priority_mask: np.ndarray | None = None) -> Image.Image:
    edges_rgb = np.zeros_like(rgb)
    edges_rgb[:, :, 1] = edge_map
    edges_rgb[:, :, 2] = edge_map
    overlay = cv2.addWeighted(rgb, 0.68, edges_rgb, 0.8, 0)
    if priority_mask is not None and np.any(priority_mask):
        mark = np.zeros_like(rgb)
        mark[:, :, 0] = 255
        blended = cv2.addWeighted(overlay, 0.68, mark, 0.32, 0)
        mask = priority_mask > 0
        overlay[mask] = blended[mask]
    return Image.fromarray(overlay, mode="RGB")


def rasterize_swarm(swarm: dict[str, Any], size: tuple[int, int]) -> Image.Image:
    """Make an aspect-preserving, nearest-neighbor color projection of the sample grid."""
    columns, rows = int(swarm["columns"]), int(swarm["rows"])
    cells = np.full((rows, columns, 3), (2, 7, 17), dtype=np.uint8)
    for sample in swarm["samples"]:
        column = max(0, min(columns - 1, int((float(sample[0]) + 0.5) * columns)))
        row = max(0, min(rows - 1, int((0.5 - float(sample[1])) * rows)))
        cells[row, column] = sample[2:5]
    width, height = size
    return Image.fromarray(cv2.resize(cells, (width, height), interpolation=cv2.INTER_NEAREST), mode="RGB")


def compare_reconstruction(reference_value: str, result_value: str, rotation_degrees: int = 0) -> dict[str, float]:
    reference, _ = load_image(reference_value)
    result, _ = load_image(result_value)
    if rotation_degrees not in {0, 90, 180, 270}:
        raise ValueError("A rotação para comparação deve ser 0, 90, 180 ou 270 graus.")
    if rotation_degrees == 90:
        reference = cv2.rotate(reference, cv2.ROTATE_90_CLOCKWISE)
    elif rotation_degrees == 180:
        reference = cv2.rotate(reference, cv2.ROTATE_180)
    elif rotation_degrees == 270:
        reference = cv2.rotate(reference, cv2.ROTATE_90_COUNTERCLOCKWISE)
    height, width = reference.shape[:2]
    result = cv2.resize(result, (width, height), interpolation=cv2.INTER_AREA if result.shape[1] > width else cv2.INTER_LINEAR)
    a = reference.astype(np.float32) / 255.0
    b = result.astype(np.float32) / 255.0
    mae = float(np.mean(np.abs(a - b)))
    mse = float(np.mean((a - b) ** 2))
    psnr = float(99.0 if mse <= 1e-12 else min(99.0, 10.0 * math.log10(1.0 / mse)))
    gray_a = cv2.cvtColor((a * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    gray_b = cv2.cvtColor((b * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    mu_a = cv2.GaussianBlur(gray_a, (11, 11), 1.5)
    mu_b = cv2.GaussianBlur(gray_b, (11, 11), 1.5)
    sigma_a = cv2.GaussianBlur(gray_a * gray_a, (11, 11), 1.5) - mu_a * mu_a
    sigma_b = cv2.GaussianBlur(gray_b * gray_b, (11, 11), 1.5) - mu_b * mu_b
    sigma_ab = cv2.GaussianBlur(gray_a * gray_b, (11, 11), 1.5) - mu_a * mu_b
    c1, c2 = 0.01**2, 0.03**2
    ssim_map = ((2 * mu_a * mu_b + c1) * (2 * sigma_ab + c2)) / ((mu_a**2 + mu_b**2 + c1) * (sigma_a + sigma_b + c2) + 1e-12)
    return {"mae": mae, "psnrDb": psnr, "ssim": float(np.mean(ssim_map)), "width": width, "height": height}


def analyze_request(request: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    image_value = request.get("image")
    rgb, image_info = load_image(image_value)
    reference_rgb = rgb
    rotation = int(request.get("rotation", 0))
    if rotation not in {0, 90, 180, 270}:
        raise ValueError("A rotação deve ser 0, 90, 180 ou 270 graus.")
    if rotation == 90:
        rgb = cv2.rotate(rgb, cv2.ROTATE_90_CLOCKWISE)
    elif rotation == 180:
        rgb = cv2.rotate(rgb, cv2.ROTATE_180)
    elif rotation == 270:
        rgb = cv2.rotate(rgb, cv2.ROTATE_90_COUNTERCLOCKWISE)
    image_info["orientationRotationDegrees"] = rotation
    image_info["width"], image_info["height"] = int(reference_rgb.shape[1]), int(reference_rgb.shape[0])
    image_info["analysisWidth"], image_info["analysisHeight"] = int(rgb.shape[1]), int(rgb.shape[0])
    count = int(request.get("population", 24_000))
    color_count = int(request.get("colors", 32))
    seed = int(request.get("seed", 20261022))
    edge_weight = float(request.get("edgeWeight", 1.0))
    edge_map = detect_edges(rgb)
    contours = detect_contours(edge_map)
    palette, centers = analyze_color_palette(rgb, color_count, seed)
    features = extract_features(rgb, edge_map)
    segmented, segment_count = segment_regions(rgb, centers)
    priority_mask, _ignore = _decode_annotation(request.get("annotations"), (rgb.shape[1], rgb.shape[0]), rotation)
    swarm = generate_swarm_coordinates(
        rgb, edge_map, count=count,
        physical_width_mm=float(request.get("physicalWidthMm", 150.0)),
        colors=color_count, seed=seed, edge_weight=edge_weight,
        annotation_value=request.get("annotations"),
        rotation_degrees=rotation,
    )
    segmented_image = Image.fromarray(unrotate_array(segmented, rotation), mode="RGB")
    edges_for_preview = unrotate_array(edge_map, rotation)
    priority_for_preview = unrotate_array(priority_mask, rotation)
    overlay = create_overlay(reference_rgb, edges_for_preview, priority_for_preview)
    raster_preview = rasterize_swarm(swarm, (rgb.shape[1], rgb.shape[0]))
    return {
        "ok": True,
        "image": image_info,
        "palette": palette,
        "features": features,
        "contours": contours,
        "regionCount": segment_count,
        "edgesPng": _png_data_url(Image.fromarray(edges_for_preview, mode="L")),
        "segmentationPng": _png_data_url(segmented_image),
        "overlayPng": _png_data_url(overlay),
        "rasterPng": _png_data_url(raster_preview),
        "swarm": swarm,
        "processingMs": round((time.perf_counter() - started) * 1000, 2),
        "notes": ["Cores e contornos são análise de imagem local; não identificam automaticamente objetos com certeza.", "SSIM/PSNR, quando usados, comparam projeções 2D e não verificam fidelidade tridimensional ou física."],
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("O pedido de visão computacional deve ser um objeto JSON.")
        action = request.get("action", "analyze")
        if action == "compare":
            result = {"ok": True, **compare_reconstruction(request.get("image", ""), request.get("reconstruction", ""), int(request.get("rotation", 0)))}
        elif action == "analyze":
            result = analyze_request(request)
        else:
            raise ValueError("Ação de visão computacional desconhecida.")
        json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        return 0
    except Exception as exc:  # CLI boundary: send only a bounded, user-facing message.
        json.dump({"ok": False, "error": str(exc)[:300]}, sys.stdout, ensure_ascii=False)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
