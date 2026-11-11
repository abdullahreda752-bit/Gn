# inspired x · Mars Explorer

## Run
1. Install Python 3.9+ (tick "Add Python to PATH").
2. Double-click `run_explorer.bat`  (or: `pip install rasterio numpy pillow` then `python server.py`).
3. The browser opens `http://localhost:8000/explorer.html`. The globe is `index.html` on the same server.

## What is real
* Imagery: NASA Mars Trek WMTS (Viking, MOLA, CTX 5 m, THEMIS) streamed live.
* Slope / hazard, route elevation profile, site report: computed by `server.py` from a real Mars DEM.
  - By default it streams the USGS HRSC+MOLA blended DEM over HTTP range requests (needs internet; first requests can take seconds).
  - Faster/offline: put any Mars DEM GeoTIFF at `dem/mars_dem.tif`.
  - Check the first lines the server prints: they say if the DEM could be opened.
* Subsurface ice (SWIM): download an ice-consistency GeoTIFF from https://swim.psi.edu and save it as `dem/swim_ice.tif`.
* `MARS_SYNTH=1` makes the server serve fake terrain to test the code. It is labelled in the UI and is NOT Mars data.

## Not verified yet
* The default DEM URL and the Trek THEMIS layer id were taken from public pages, not tested from this build environment.
* The suitability criteria (max elevation, latitude, flat area) are adjustable assumptions, not official NASA thresholds.

## Chat assistant (Mars only)
* Lives in `chatbot/` and is started by `run_all.bat`. Setup, providers and security are in `chatbot/README.md`.
* The 💬 widget (`chat.js`) talks to it at `http://localhost:3000`; the AI key stays in `chatbot/.env` on the server.
* It refuses non-Mars questions on the server, shows NASA Image Library photos, and knows which mission/route/site you are looking at.
* Works only while the chatbot server runs. A public static host has no chat unless the chatbot is deployed too (set `CHAT_NODE` and `ALLOWED_ORIGIN`).
