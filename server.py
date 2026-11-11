#!/usr/bin/env python3
"""Mars Explorer server: serves the website and real-DEM analysis endpoints.

    pip install rasterio numpy pillow
    python server.py                 -> http://localhost:8000

Elevation data (real):
  * dem/mars_dem.tif, if you downloaded a Mars DEM GeoTIFF (fast, offline), otherwise
  * streamed on demand from USGS Astrogeology over HTTP range requests (needs internet).
Optional resource layer: dem/swim_ice.tif (SWIM ice-consistency GeoTIFF from https://swim.psi.edu).
MARS_SYNTH=1 serves an obviously fake terrain for testing the code only.
"""
import io, json, math, os, threading, urllib.parse, webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
from PIL import Image

R = 3396190.0                                   # Mars 2000 sphere radius used by the USGS global DEMs (m)
KM_DEG = R * math.pi / 180 / 1000               # km per degree of latitude (~59.27)
HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_DEM = os.environ.get("MARS_DEM", os.path.join(HERE, "dem", "mars_dem.tif"))
REMOTE_DEM = os.environ.get("MARS_DEM_URL", "https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif")
ICE_TIF = os.environ.get("MARS_ICE", os.path.join(HERE, "dem", "swim_ice.tif"))
SYNTH = os.environ.get("MARS_SYNTH") == "1"
PORT = int(os.environ.get("PORT", "8000"))
LOCK = threading.Lock()
for k, v in {"GDAL_HTTP_MULTIPLEX": "YES", "GDAL_HTTP_VERSION": "2", "VSI_CACHE": "TRUE", "VSI_CACHE_SIZE": "200000000",
             "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif"}.items():
    os.environ.setdefault(k, v)


# ------------------------------------------------------------------ DEM providers
POOL = ThreadPoolExecutor(8)
CACHE = {}


class RasterDEM:
    """Reads a window in parallel row-bands (one file handle per thread) and converts it to metres.
    USGS HRSC+MOLA blend: 16-bit unsigned, metres = DN * 0.25 - 8000 (PDS label). If the TIFF carries its own
    scale/offset (or is float) that is used instead. Values outside the real Mars range raise an error."""

    def __init__(self, src):
        import rasterio, rasterio.windows, rasterio.enums
        self.rio, self.src, self.name, self.tl = rasterio, src, src, threading.local()
        self.ds = self._h()
        sc, off = (self.ds.scales[0] or 1.0), (self.ds.offsets[0] or 0.0)
        self.scale, self.offset = (0.25, -8000.0) if (self.ds.dtypes[0] == "uint16" and sc == 1.0 and off == 0.0) else (sc, off)

    def _h(self):
        h = getattr(self.tl, "ds", None)
        if h is None:
            h = self.tl.ds = self.rio.open(self.src)
        return h

    def read(self, w, s, e, n, maxpx=900):
        key = (self.src, round(w, 5), round(s, 5), round(e, 5), round(n, 5), maxpx)
        if key in CACHE:
            return CACHE[key]
        rio, ds, b = self.rio, self.ds, self.ds.bounds
        if b.left <= -179.9:
            w2 = w
        elif b.right > 180.5:
            w2 = w % 360
        else:
            w2 = ((w + 180) % 360) - 180
        e2 = w2 + (e - w)
        full = rio.windows.Window(0, 0, ds.width, ds.height)
        win = rio.windows.from_bounds(w2, s, e2, n, transform=ds.transform).round_offsets().round_lengths()
        win = rio.windows.intersection(win, full)
        f = max(1, math.ceil(max(win.width, win.height) / maxpx))
        oh, ow = max(2, int(win.height // f)), max(2, int(win.width // f))
        nb = max(1, min(8, oh // 8))
        edges = np.linspace(0, oh, nb + 1).astype(int)

        def band(i):
            r0, r1 = int(edges[i]), int(edges[i + 1])
            wb = rio.windows.Window(win.col_off, win.row_off + r0 * f, win.width, (r1 - r0) * f)
            return self._h().read(1, window=wb, out_shape=(r1 - r0, ow), resampling=rio.enums.Resampling.nearest)

        raw = np.vstack(list(POOL.map(band, range(nb))))
        arr = raw.astype("float32") * self.scale + self.offset
        if ds.nodata is not None:
            arr[raw == ds.nodata] = np.nan
        v = arr[np.isfinite(arr)]
        if v.size and (v.min() < -9000 or v.max() > 22000):
            raise ValueError(f"DEM values {v.min():.0f}..{v.max():.0f} m are outside the real Mars range: wrong units/scale for this file")
        l, bm, r, t = ds.window_bounds(win)
        out = (arr, (l - (w2 - w), bm, r - (w2 - w), t))
        CACHE[key] = out
        if len(CACHE) > 40:
            CACHE.pop(next(iter(CACHE)))
        return out


class SynthDEM:
    name = "SYNTHETIC - code tests only, NOT Mars data"

    def read(self, w, s, e, n, maxpx=900):
        ppd = 296.0
        ow, oh = max(2, min(maxpx, int((e - w) * ppd))), max(2, min(maxpx, int((n - s) * ppd)))
        lon, lat = np.linspace(w, e, ow)[None, :], np.linspace(n, s, oh)[:, None]
        z = 1500 * np.sin(lon / 3) * np.cos(lat / 4) + 400 * np.sin(lon * 7) * np.sin(lat * 9) - 3000
        return z.astype("float32"), (w, s, e, n)


_dem = None


def dem():
    global _dem
    if _dem is None:
        _dem = SynthDEM() if SYNTH else RasterDEM(LOCAL_DEM if os.path.exists(LOCAL_DEM) else "/vsicurl/" + REMOTE_DEM)
    return _dem


_ice = None


def ice_grid(w, s, e, n, oh, ow):
    global _ice
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.crs import CRS
    if _ice is None:
        _ice = rasterio.open(ICE_TIF)
    dst = np.full((oh, ow), np.nan, "float32")
    with LOCK:
        reproject(rasterio.band(_ice, 1), dst, dst_transform=rasterio.transform.from_bounds(w, s, e, n, ow, oh),
                  dst_crs=CRS.from_proj4("+proj=longlat +a=3396190 +b=3396190 +no_defs"), dst_nodata=np.nan, resampling=Resampling.nearest)
    return dst


def has_ice():
    return (not SYNTH) and os.path.exists(ICE_TIF)


# ------------------------------------------------------------------ maths
def haversine_m(la1, lo1, la2, lo2):
    p1, p2 = math.radians(la1), math.radians(la2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(a)))


def slope_deg(arr, bounds):
    l, b, r, t = bounds
    h, w = arr.shape
    dlat, dlon = (t - b) / h, (r - l) / w
    lat = np.linspace(t, b, h)
    dy = R * math.radians(dlat)
    dx = (R * np.cos(np.radians(lat)) * math.radians(dlon)).clip(min=1.0)[:, None]
    gy, gx = np.gradient(arr, axis=0) / dy, np.gradient(arr, axis=1) / dx
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def sample(arr, bounds, lon, lat):
    l, b, r, t = bounds
    h, w = arr.shape
    x = np.clip((np.asarray(lon) - l) / (r - l) * w - 0.5, 0, w - 1.001)
    y = np.clip((t - np.asarray(lat)) / (t - b) * h - 0.5, 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = x - x0, y - y0
    return (arr[y0, x0] * (1 - fx) * (1 - fy) + arr[y0, x0 + 1] * fx * (1 - fy) + arr[y0 + 1, x0] * (1 - fx) * fy + arr[y0 + 1, x0 + 1] * fx * fy)


def clean(a, nd=1):
    return [None if (v is None or not np.isfinite(v)) else round(float(v), nd) for v in a]


# ------------------------------------------------------------------ endpoints
def status():
    out = {"synthetic": SYNTH, "ice": {"ok": has_ice()}}
    try:
        d = dem()
        d.read(77.0, 18.0, 77.2, 18.2, 60)
        out["dem"] = {"ok": True, "name": str(d.name)}
    except Exception as ex:
        out["dem"] = {"ok": False, "error": str(ex)[:300]}
    return out


def profile(q):
    pts = [tuple(map(float, p.split(","))) for p in q["pts"].split(";")]
    if len(pts) < 2:
        raise ValueError("need at least 2 points")
    n = max(20, min(600, int(q.get("n", 200))))
    seg = [haversine_m(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seg)
    if total > 400_000:
        raise ValueError("route longer than 400 km")
    cum = np.concatenate([[0], np.cumsum(seg)])
    d = np.linspace(0, total, n)
    idx = np.clip(np.searchsorted(cum, d, side="right") - 1, 0, len(seg) - 1)
    f = (d - cum[idx]) / np.maximum(1e-9, np.array(seg)[idx])
    P = np.array(pts)
    lat = P[idx, 0] + (P[idx + 1, 0] - P[idx, 0]) * f
    lon = P[idx, 1] + (P[idx + 1, 1] - P[idx, 1]) * f
    pad = max(0.02, total / 1000 / KM_DEG * 0.05)
    arr, bnd = dem().read(lon.min() - pad, lat.min() - pad, lon.max() + pad, lat.max() + pad, 1000)
    z = sample(arr, bnd, lon, lat)
    sl = np.degrees(np.arctan2(np.diff(z), np.maximum(1e-6, np.diff(d))))
    sl = np.concatenate([[sl[0]], sl])
    res = (bnd[2] - bnd[0]) / arr.shape[1] * math.pi / 180 * R * math.cos(math.radians(float(lat.mean())))
    dz = np.diff(z)
    return {"dist_km": clean(d / 1000, 3), "elev_m": clean(z), "slope_deg": clean(sl, 2), "lat": clean(lat, 5), "lon": clean(lon, 5),
            "total_km": round(total / 1000, 3), "ascent_m": round(float(np.nansum(dz[dz > 0])), 1), "descent_m": round(float(-np.nansum(dz[dz < 0])), 1),
            "max_slope_deg": round(float(np.nanmax(np.abs(sl))), 1), "pct_over15": round(float(np.nanmean(np.abs(sl) > 15) * 100), 1),
            "res_m": round(res, 1), "source": str(dem().name)}


def site(q):
    lat, lon, r = float(q["lat"]), float(q["lon"]), float(q.get("r", 100))
    flat = float(q.get("flat", 8))
    hl = r / KM_DEG
    hn = hl / max(0.2, math.cos(math.radians(lat)))
    arr, bnd = dem().read(lon - hn, lat - hl, lon + hn, lat + hl, 700)
    h, w = arr.shape
    la = np.linspace(bnd[3], bnd[1], h)[:, None]
    lo = np.linspace(bnd[0], bnd[2], w)[None, :]
    dist = np.hypot((la - lat) * KM_DEG, (lo - lon) * KM_DEG * math.cos(math.radians(lat)))
    m = (dist <= r) & np.isfinite(arr)
    if m.sum() < 10:
        raise ValueError("no DEM coverage here")
    sl = slope_deg(arr, bnd)
    out = {"elev_mean": float(arr[m].mean()), "elev_min": float(arr[m].min()), "elev_max": float(arr[m].max()),
           "slope_p50": float(np.nanpercentile(sl[m], 50)), "slope_p90": float(np.nanpercentile(sl[m], 90)),
           "flat_pct": float((sl[m] < flat).mean() * 100), "res_m": round((bnd[2] - bnd[0]) / w * math.pi / 180 * R * math.cos(math.radians(lat)), 1),
           "source": str(dem().name), "r_km": r, "ice_pos_pct": None}
    if has_ice():
        try:
            g = ice_grid(bnd[0], bnd[1], bnd[2], bnd[3], h, w)
            v = g[m & np.isfinite(g)]
            out["ice_pos_pct"] = float((v > 0).mean() * 100) if v.size else None
        except Exception as ex:
            out["ice_error"] = str(ex)[:200]
    return out


def overlay(q):
    w, s, e, n = (float(q[k]) for k in ("w", "s", "e", "n"))
    if (e - w) > 4 or (n - s) > 4:
        raise ValueError("zoom in: overlay limited to 4 degrees")
    kind = q.get("kind", "slope")
    arr, bnd = dem().read(w, s, e, n, 700)
    rgba = np.zeros(arr.shape + (4,), np.uint8)
    if kind == "slope":
        sl = slope_deg(arr, bnd)
        for lo_, hi_, col in [(0, 8, (70, 200, 120, 70)), (8, 15, (245, 180, 60, 150)), (15, 25, (235, 70, 60, 185)), (25, 91, (150, 20, 40, 215))]:
            rgba[(sl >= lo_) & (sl < hi_)] = col
    elif kind == "ice":
        if not has_ice():
            raise ValueError("SWIM file not installed (dem/swim_ice.tif)")
        g = ice_grid(bnd[0], bnd[1], bnd[2], bnd[3], *arr.shape)
        pos = np.isfinite(g) & (g > 0)
        if pos.any():
            v = np.clip(g / np.nanmax(g[pos]), 0, 1)
            rgba[pos] = np.stack([60 + 0 * v[pos], 150 + 90 * v[pos], 255 + 0 * v[pos], 90 + 140 * v[pos]], -1).astype(np.uint8)
    else:
        raise ValueError("unknown overlay kind")
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG")
    return buf.getvalue(), bnd


# ------------------------------------------------------------------ http
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            name = u.path[5:]
            if name == "overlay":
                png, b = overlay(q)
                return self._send(200, png, "image/png", {"X-Bounds": ",".join(f"{v:.6f}" for v in b), "Access-Control-Expose-Headers": "X-Bounds"})
            res = {"status": status, "profile": profile, "site": site}[name]
            res = res() if name == "status" else res(q)
            self._send(200, json.dumps(res).encode(), "application/json")
        except Exception as ex:
            self._send(400, json.dumps({"error": f"{type(ex).__name__}: {ex}"[:400]}).encode(), "application/json")


if __name__ == "__main__":
    print("Checking elevation data source ...")
    st = status()
    print(json.dumps(st, indent=1))
    if SYNTH:
        print("WARNING: synthetic terrain, for tests only.")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"Open http://localhost:{PORT}/explorer.html   (Ctrl+C to stop)")
    threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{PORT}/explorer.html")).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
