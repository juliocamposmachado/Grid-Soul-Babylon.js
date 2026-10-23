import base64
import io
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend.vision.image_analyzer import (  # noqa: E402
    analyze_color_palette,
    analyze_request,
    detect_contours,
    detect_edges,
    generate_swarm_coordinates,
    load_image,
)


def data_url(image: Image.Image, fmt: str = "PNG") -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    mime = "image/jpeg" if fmt == "JPEG" else f"image/{fmt.lower()}"
    return f"data:{mime};base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class ImageAnalyzerTests(unittest.TestCase):
    def test_load_png_composites_alpha_and_keeps_dimensions(self):
        image = Image.new("RGBA", (20, 10), (255, 0, 0, 0))
        image.putpixel((0, 0), (0, 255, 0, 255))
        rgb, info = load_image(data_url(image))
        self.assertEqual(rgb.shape, (10, 20, 3))
        self.assertEqual(info["format"], "PNG")
        self.assertEqual(info["alphaComposited"], "#020711")
        self.assertGreater(rgb[4, 4, 2], 0)

    def test_rejects_unsupported_or_invalid_input(self):
        with self.assertRaisesRegex(ValueError, "base64|imagem"):
            load_image("data:image/svg+xml;base64,PHN2Zy8+")
        with self.assertRaisesRegex(ValueError, "Formato|decodificar"):
            load_image("data:image/png;base64,PHN2Zy8+")

    def test_palette_is_multicolor_and_deterministic(self):
        pixels = np.zeros((32, 48, 3), dtype=np.uint8)
        pixels[:, :16] = (240, 20, 10)
        pixels[:, 16:32] = (15, 210, 40)
        pixels[:, 32:] = (20, 30, 235)
        palette_a, _ = analyze_color_palette(pixels, 8, 123)
        palette_b, _ = analyze_color_palette(pixels, 8, 123)
        self.assertEqual(palette_a, palette_b)
        self.assertGreaterEqual(len(palette_a), 3)
        self.assertAlmostEqual(sum(item["fraction"] for item in palette_a), 1.0, places=5)

    def test_canny_detects_geometric_boundaries_and_contours(self):
        image = np.full((100, 120, 3), 245, dtype=np.uint8)
        image[25:75, 30:90] = (20, 40, 220)
        edges = detect_edges(image)
        self.assertGreater(int(np.count_nonzero(edges)), 100)
        contours = detect_contours(edges)
        self.assertTrue(contours)
        self.assertTrue(any(item["width"] >= 45 and item["height"] >= 45 for item in contours))

    def test_sampling_preserves_aspect_colors_and_physical_area(self):
        image = np.zeros((40, 80, 3), dtype=np.uint8)
        image[:, :40] = (250, 30, 30)
        image[:, 40:] = (20, 200, 240)
        edges = detect_edges(image)
        result = generate_swarm_coordinates(image, edges, 400, 200, 16, 99)
        self.assertLessEqual(result["count"], 400)
        self.assertGreater(result["count"], 350)
        self.assertEqual(result["physicalWidthMm"], 200)
        self.assertAlmostEqual(result["physicalHeightMm"], 100, places=3)
        self.assertAlmostEqual(result["aspectRatio"], 2.0, places=6)
        self.assertGreaterEqual(len({tuple(sample[2:5]) for sample in result["samples"]}), 2)
        self.assertTrue(all(-0.5 <= sample[0] <= 0.5 and -0.5 <= sample[1] <= 0.5 for sample in result["samples"]))

    def test_sampling_repeatability_and_exclusion_mask(self):
        image = np.full((24, 24, 3), (40, 120, 210), dtype=np.uint8)
        edges = detect_edges(image)
        a = generate_swarm_coordinates(image, edges, 144, 144, 8, 5)
        b = generate_swarm_coordinates(image, edges, 144, 144, 8, 5)
        self.assertEqual(a["samples"], b["samples"])
        mask = Image.new("RGBA", (24, 24), (0, 0, 0, 0))
        from PIL import ImageDraw
        ImageDraw.Draw(mask).rectangle((0, 0, 11, 23), fill=(0, 0, 0, 255))
        excluded = generate_swarm_coordinates(image, edges, 144, 144, 8, 5, annotation_value=data_url(mask))
        self.assertLess(excluded["count"], a["count"])
        self.assertGreater(excluded["count"], 0)

    def test_full_analysis_produces_layers_and_samples_for_grayscale(self):
        gradient = np.tile(np.arange(64, dtype=np.uint8), (32, 1))
        image = Image.fromarray(gradient, mode="L")
        result = analyze_request({"image": data_url(image), "population": 256, "colors": 8, "physicalWidthMm": 80})
        self.assertTrue(result["ok"])
        self.assertEqual(result["image"]["width"], 64)
        self.assertTrue(result["edgesPng"].startswith("data:image/png;base64,"))
        self.assertTrue(result["segmentationPng"].startswith("data:image/png;base64,"))
        self.assertEqual(result["swarm"]["physicalWidthMm"], 80)
        self.assertGreaterEqual(result["features"]["contrastStdDev"], 0)
        self.assertIn("contours", result)

    def test_bad_physical_width_is_rejected(self):
        pixels = np.ones((20, 20, 3), dtype=np.uint8) * 127
        with self.assertRaisesRegex(ValueError, "largura física"):
            generate_swarm_coordinates(pixels, detect_edges(pixels), 100, 1, 8)

    def test_rotation_keeps_reference_layers_aligned_and_rotates_raster_projection(self):
        pixels = np.zeros((20, 32, 3), dtype=np.uint8)
        pixels[:10, :16] = (250, 10, 20)
        pixels[10:, 16:] = (20, 220, 240)
        result = analyze_request({"image": data_url(Image.fromarray(pixels)), "population": 100, "colors": 8, "physicalWidthMm": 80, "rotation": 90})
        self.assertEqual((result["image"]["width"], result["image"]["height"]), (32, 20))
        self.assertEqual((result["image"]["analysisWidth"], result["image"]["analysisHeight"]), (20, 32))
        raster_bytes = base64.b64decode(result["rasterPng"].split(",", 1)[1])
        with Image.open(io.BytesIO(raster_bytes)) as raster:
            self.assertEqual(raster.size, (20, 32))
        edge_bytes = base64.b64decode(result["edgesPng"].split(",", 1)[1])
        with Image.open(io.BytesIO(edge_bytes)) as edges:
            self.assertEqual(edges.size, (32, 20))


if __name__ == "__main__":
    unittest.main()
