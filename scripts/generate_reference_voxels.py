from pathlib import Path

code = r'''#!/usr/bin/env python3
"""
GRID SOUL — Intelligent Reference Voxel Atlas Generator

Converts a reference image into the existing GSF1 binary atlas:
    header:  <4sHHI  -> magic, grid_width, grid_height, sample_count
    records: <HHBBB  -> x, y, r, g, b

The source image is used only offline. The runtime continues to consume the
binary atlas and construct one BoxGeometry instance per record.

Sampling strategy:
- configurable background segmentation;
- edge/detail-aware candidate scoring;
- spatially stratified quotas to reduce clustering and empty areas;
- deterministic weighted selection within each spatial cell;
- validation and atomic output replacement.

Requires Pillow. No NumPy or other third-party dependency is required.
"""

from __future__ import annotations

import argparse
import heapq
import math
import random
import struct
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageOps, UnidentifiedImageError


# ---------------------------------------------------------------------------
# Backward-compatible defaults
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "referencia-rosto-humanoide.png"
DEFAULT_OUTPUT = ROOT / "public" / "assets" / "humanoid_face_88000.bin"

DEFAULT_GRID = 384
DEFAULT_COUNT = 88_000
DEFAULT_BACKGROUND = (2, 6, 23)
DEFAULT_THRESHOLD = 30
DEFAULT_SEED = 20261020

MAGIC = b"GSF1"
HEADER_FORMAT = "<4sHHI"
RECORD_FORMAT = "<HHBBB"
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)
RECORD_SIZE = struct.calcsize(RECORD_FORMAT)


@dataclass(frozen=True, slots=True)
class Candidate:
    x: int
    y: int
    r: int
    g: int
    b: int
    score: float

    @property
    def rgb(self) -> tuple[int, int, int]:
        return self.r, self.g, self.b


def parse_rgb(value: str) -> tuple[int, int, int]:
    """Parse R,G,B or #RRGGBB."""
    value = value.strip()
    if value.startswith("#"):
        value = value[1:]
        if len(value) != 6:
            raise argparse.ArgumentTypeError("Use #RRGGBB para a cor de fundo.")
        try:
            return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
        except ValueError as exc:
            raise argparse.ArgumentTypeError("Cor hexadecimal inválida.") from exc

    try:
        parts = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Use RGB como R,G,B, por exemplo 2,6,23.") from exc

    if len(parts) != 3 or any(component < 0 or component > 255 for component in parts):
        raise argparse.ArgumentTypeError("RGB deve conter três inteiros entre 0 e 255.")
    return parts  # type: ignore[return-value]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Gera um atlas GSF1 com amostragem inteligente para o GRID SOUL."
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                        help=f"Imagem de referência (padrão: {DEFAULT_SOURCE}).")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help=f"Arquivo binário de saída (padrão: {DEFAULT_OUTPUT}).")
    parser.add_argument("--grid", type=int, default=DEFAULT_GRID,
                        help="Largura e altura da grade quadrada (padrão: 384).")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT,
                        help="Quantidade de microcubos/amostras (padrão: 88000).")
    parser.add_argument("--background", type=parse_rgb, default=DEFAULT_BACKGROUND,
                        help="Cor de fundo RGB, por exemplo 2,6,23 ou #020617.")
    parser.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD,
                        help="Limiar máximo por canal para considerar o pixel semelhante ao fundo.")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="Semente para resultado reproduzível.")
    parser.add_argument("--tiles", type=int, default=24,
                        help="Divisões espaciais por eixo para equilibrar a distribuição.")
    parser.add_argument("--edge-weight", type=float, default=2.2,
                        help="Peso da variação local/contornos na seleção.")
    parser.add_argument("--color-weight", type=float, default=0.8,
                        help="Peso da diversidade cromática local.")
    parser.add_argument("--background-weight", type=float, default=0.35,
                        help="Peso da distância em relação à cor de fundo.")
    parser.add_argument("--no-edge-priority", action="store_true",
                        help="Desativa a priorização de contornos e detalhes.")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not 1 <= args.grid <= 65535:
        raise ValueError("--grid deve estar entre 1 e 65535 para caber no cabeçalho GSF1.")
    if not 1 <= args.count <= 0xFFFFFFFF:
        raise ValueError("--count deve estar entre 1 e 4294967295.")
    if not 0 <= args.threshold <= 255:
        raise ValueError("--threshold deve estar entre 0 e 255.")
    if not 1 <= args.tiles <= args.grid:
        raise ValueError("--tiles deve estar entre 1 e --grid.")
    for name in ("edge_weight", "color_weight", "background_weight"):
        value = getattr(args, name)
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"--{name.replace('_', '-')} deve ser um número finito não negativo.")


def load_reference(path: Path, grid: int, background: tuple[int, int, int]) -> Image.Image:
    """Load safely, apply EXIF orientation, composite alpha over background, and resize."""
    if not path.is_file():
        raise FileNotFoundError(f"Imagem de referência não encontrada: {path}")

    try:
        with Image.open(path) as original:
            oriented = ImageOps.exif_transpose(original)
            rgba = oriented.convert("RGBA")
            base = Image.new("RGBA", rgba.size, (*background, 255))
            rgb = Image.alpha_composite(base, rgba).convert("RGB")
            return rgb.resize((grid, grid), Image.Resampling.LANCZOS)
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"Não foi possível ler a imagem '{path}': {exc}") from exc


def max_channel_distance(rgb: tuple[int, int, int],
                         background: tuple[int, int, int]) -> int:
    return max(abs(rgb[i] - background[i]) for i in range(3))


def pixel_detail_score(
    pixels,
    x: int,
    y: int,
    grid: int,
    rgb: tuple[int, int, int],
    background: tuple[int, int, int],
    edge_weight: float,
    color_weight: float,
    background_weight: float,
    edge_priority: bool,
) -> float:
    """
    Estimate local importance from neighboring luminance/color changes.

    This is a visual sampling heuristic, not a physical edge detector or
    dimensional measurement. Scores remain positive for weighted selection.
    """
    r, g, b = rgb
    luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b

    neighbors = []
    for nx, ny in ((max(0, x - 1), y), (min(grid - 1, x + 1), y),
                   (x, max(0, y - 1)), (x, min(grid - 1, y + 1))):
        nr, ng, nb = pixels[nx, ny]
        nl = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb
        neighbors.append(((nr, ng, nb), nl))

    luminance_gradient = sum(abs(luminance - item[1]) for item in neighbors) / 4.0
    color_gradient = sum(
        (abs(r - item[0][0]) + abs(g - item[0][1]) + abs(b - item[0][2])) / 3.0
        for item in neighbors
    ) / 4.0

    background_distance = max_channel_distance(rgb, background) / 255.0
    edge_term = min(1.0, luminance_gradient / 64.0) if edge_priority else 0.0
    color_term = min(1.0, color_gradient / 96.0)
    # Base weight ensures that flat areas are still represented.
    return (
        1.0
        + edge_weight * edge_term
        + color_weight * color_term
        + background_weight * background_distance
    )


def collect_candidates(
    image: Image.Image,
    background: tuple[int, int, int],
    threshold: int,
    edge_weight: float,
    color_weight: float,
    background_weight: float,
    edge_priority: bool,
) -> list[Candidate]:
    grid_w, grid_h = image.size
    if grid_w != grid_h:
        raise ValueError("A grade GSF1 atual é quadrada; largura e altura devem coincidir.")

    pixels = image.load()
    candidates: list[Candidate] = []

    for y in range(grid_h):
        for x in range(grid_w):
            r, g, b = pixels[x, y]
            rgb = (r, g, b)
            if max_channel_distance(rgb, background) <= threshold:
                continue

            score = pixel_detail_score(
                pixels, x, y, grid_w, rgb, background,
                edge_weight, color_weight, background_weight, edge_priority
            )
            candidates.append(Candidate(x, y, r, g, b, score))

    return candidates


def tile_index(candidate: Candidate, grid: int, tiles: int) -> tuple[int, int]:
    tx = min(tiles - 1, candidate.x * tiles // grid)
    ty = min(tiles - 1, candidate.y * tiles // grid)
    return tx, ty


def allocate_quotas(
    buckets: dict[tuple[int, int], list[Candidate]],
    count: int,
) -> dict[tuple[int, int], int]:
    """
    Allocate a target count among occupied tiles.

    The first pass distributes samples proportionally to tile candidate counts,
    then deterministic largest-remainder allocation corrects rounding. A tile
    can never receive more samples than it contains.
    """
    total = sum(len(items) for items in buckets.values())
    if count > total:
        raise ValueError(f"Existem apenas {total} candidatos, mas foram solicitadas {count} amostras.")

    quotas = {key: 0 for key in buckets}
    active = set(buckets)
    remaining = count

    while remaining > 0 and active:
        active_total = sum(len(buckets[key]) - quotas[key] for key in active)
        if active_total <= 0:
            break

        raw = {
            key: remaining * (len(buckets[key]) - quotas[key]) / active_total
            for key in active
        }
        floors = {key: min(
            len(buckets[key]) - quotas[key], int(raw[key])
        ) for key in active}

        assigned = sum(floors.values())
        for key, amount in floors.items():
            quotas[key] += amount
        remaining -= assigned

        active = {key for key in active if quotas[key] < len(buckets[key])}
        if remaining <= 0:
            break

        ranked = sorted(
            active,
            key=lambda key: (raw.get(key, 0.0) - int(raw.get(key, 0.0)), key[1], key[0]),
            reverse=True,
        )
        if not ranked:
            break

        progressed = False
        for key in ranked:
            if remaining == 0:
                break
            if quotas[key] < len(buckets[key]):
                quotas[key] += 1
                remaining -= 1
                progressed = True
        if not progressed:
            break

    if remaining:
        raise RuntimeError(f"Não foi possível alocar {count} amostras; faltaram {remaining}.")
    return quotas


def weighted_sample_without_replacement(
    candidates: list[Candidate],
    count: int,
    rng: random.Random,
) -> list[Candidate]:
    """Deterministic weighted reservoir selection using an exponential-race key."""
    if count == 0:
        return []
    if count >= len(candidates):
        return list(candidates)

    # Larger score increases selection probability while every candidate
    # retains a nonzero chance of selection.
    heap: list[tuple[float, int, Candidate]] = []
    for index, candidate in enumerate(candidates):
        u = max(rng.random(), sys.float_info.min)
        key = math.log(u) / candidate.score
        item = (key, index, candidate)
        if len(heap) < count:
            heapq.heappush(heap, item)
        elif key > heap[0][0]:
            heapq.heapreplace(heap, item)

    return [item[2] for item in sorted(heap, key=lambda item: item[1])]


def select_samples(
    candidates: list[Candidate],
    count: int,
    grid: int,
    tiles: int,
    seed: int,
) -> list[Candidate]:
    rng = random.Random(seed)
    buckets: dict[tuple[int, int], list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        buckets[tile_index(candidate, grid, tiles)].append(candidate)

    quotas = allocate_quotas(buckets, count)
    selected: list[Candidate] = []

    # Derive a stable per-tile RNG seed so that tile traversal order cannot
    # accidentally alter another tile's selection.
    for key in sorted(buckets, key=lambda item: (item[1], item[0])):
        quota = quotas[key]
        if quota <= 0:
            continue
        tile_seed = (seed ^ (key[0] * 73856093) ^ (key[1] * 19349663)) & 0xFFFFFFFFFFFFFFFF
        tile_rng = random.Random(tile_seed)
        selected.extend(weighted_sample_without_replacement(buckets[key], quota, tile_rng))

    # Stable shuffle avoids visible scanline order in consumers that preserve
    # instance ordering; it does not change coordinates or colors.
    rng.shuffle(selected)
    return selected


def write_atlas_atomic(output_path: Path, grid: int, samples: list[Candidate]) -> int:
    """Write GSF1 to a temporary sibling, verify size, then atomically replace."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    expected_size = HEADER_SIZE + len(samples) * RECORD_SIZE
    temp_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=f".{output_path.name}.", suffix=".tmp",
            dir=output_path.parent, delete=False
        ) as handle:
            temp_path = Path(handle.name)
            handle.write(struct.pack(HEADER_FORMAT, MAGIC, grid, grid, len(samples)))
            for sample in samples:
                handle.write(struct.pack(
                    RECORD_FORMAT, sample.x, sample.y,
                    sample.r, sample.g, sample.b
                ))
            handle.flush()

        actual_size = temp_path.stat().st_size
        if actual_size != expected_size:
            raise IOError(
                f"Arquivo temporário inconsistente: {actual_size} bytes; "
                f"esperados {expected_size}."
            )

        # Verify the header before replacing a known-good output.
        with temp_path.open("rb") as handle:
            header = handle.read(HEADER_SIZE)
        magic, width, height, record_count = struct.unpack(HEADER_FORMAT, header)
        if (magic, width, height, record_count) != (MAGIC, grid, grid, len(samples)):
            raise IOError("Validação do cabeçalho GSF1 falhou.")

        temp_path.replace(output_path)
        temp_path = None
        return expected_size
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


def main() -> int:
    args = parse_args()
    try:
        validate_args(args)
        image = load_reference(args.source, args.grid, args.background)
        candidates = collect_candidates(
            image=image,
            background=args.background,
            threshold=args.threshold,
            edge_weight=args.edge_weight,
            color_weight=args.color_weight,
            background_weight=args.background_weight,
            edge_priority=not args.no_edge_priority,
        )

        if len(candidates) < args.count:
            raise ValueError(
                f"A segmentação produziu {len(candidates)} candidatos, "
                f"mas --count={args.count} foi solicitado. "
                "Reduza --count, aumente --grid ou ajuste --background/--threshold."
            )

        samples = select_samples(
            candidates, args.count, args.grid, args.tiles, args.seed
        )
        byte_count = write_atlas_atomic(args.output, args.grid, samples)

        print("GRID SOUL — Atlas GSF1 concluído")
        print(f"Fonte: {args.source}")
        print(f"Grade: {args.grid}x{args.grid}")
        print(f"Candidatos após segmentação: {len(candidates)}")
        print(f"Amostras/cubos: {len(samples)}")
        print(f"Estratégia: amostragem espacial estratificada + prioridade de detalhes")
        print(f"Semente: {args.seed}")
        print(f"Formato: GSF1; cabeçalho={HEADER_SIZE} bytes; registro={RECORD_SIZE} bytes")
        print(f"Arquivo: {args.output}")
        print(f"Tamanho: {byte_count} bytes")
        return 0

    except (FileNotFoundError, ValueError, OSError, RuntimeError) as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
