// Delad kart-grund för alla vyer som ritar banan (kartvyn + strategivyn).
// Stateless helpers under window.CourseMap — ingen egen global state, ingen
// DOM-koppling. Laddas FÖRE app.js / strategy.js.
"use strict";

window.CourseMap = {
  // Esri World Imagery — gratis satellit, ingen nyckel.
  ESRI_URL:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  // CSS-filter som gör satellit-/ortofoto-tiles ljusare & friskare (Google Maps-
  // känsla). Verkar på tile-panelerna (Esri + Lantmäteriets ortofoto + imagery-
  // pane) men INTE på overlayPane, så banytornas vektorfärger lämnas orörda.
  // Justera hela kartans ljus/färg genom att ändra denna enda rad.
  MAP_FILTER: "brightness(1.60) saturate(1.44) contrast(0.92) sepia(0.05)",
  _filterInjected: false,
  applyImageFilter() {
    if (this._filterInjected || typeof document === "undefined") return;
    this._filterInjected = true;
    const st = document.createElement("style");
    st.textContent =
      `.leaflet-tile-pane,.leaflet-imagery-pane{filter:${this.MAP_FILTER};}`;
    document.head.appendChild(st);
  },

  // opts slås ihop med bas-optionerna → anropare kan skicka t.ex.
  // {updateWhenIdle:false, keepBuffer:6} (kartvyn på mobil, roterad karta).
  esriLayer(opts = {}) {
    this.applyImageFilter();
    return L.tileLayer(this.ESRI_URL, {
      maxZoom: 21, maxNativeZoom: 19,
      attribution:
        "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      ...opts,
    });
  },

  // Ytfärger (delas av kartvy + strategivy + ev. legend).
  SURFACE_STYLE: {
    fairway:      { color: "#4f9e3f", fill: "#6cc257", label: "Fairway" },
    green:        { color: "#4fd07a", fill: "#8ef0a6", label: "Green" },
    bunker:       { color: "#e8c46a", fill: "#f7e3a3", label: "Bunker" },
    water_hazard: { color: "#3f9fd8", fill: "#6fc8f2", label: "Vatten" },
    tee:          { color: "#9d7ef0", fill: "#c3aefd", label: "Tee" },
    ob:           { color: "#e05555", fill: "#f08a8a", label: "OB" },
    heavy_rough:  { color: "#8a9a3d", fill: "#aec257", label: "Tjockruff" },
    mask:         { color: "#2e7a46", fill: "#49a86a", label: "Mask (träd)" },
  },

  // fetch-JSON med snäll feltext (plockar FastAPI:s {detail} om den finns).
  async api(path) {
    const r = await fetch(path);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || `${path} → ${r.status}`);
    }
    return r.json();
  },

  // Rita banans ytor i `target` (en L.layerGroup el. karta). Returnerar
  // {surfaces, groups} så anroparen själv kan bygga lagerkontroll/bounds.
  // opts.fillOpacity (default 0.35).
  async addSurfaces(target, opts = {}) {
    const surfaces = await this.api("/api/course/surfaces");
    const byType = {};
    for (const f of surfaces.features) (byType[f.properties.surface] ||= []).push(f);
    const groups = {};
    for (const [t, feats] of Object.entries(byType)) {
      const st = this.SURFACE_STYLE[t] || { color: "#999", fill: "#aaa", label: t };
      const grp = L.geoJSON({ type: "FeatureCollection", features: feats }, {
        style: { color: st.color, weight: 1, fillColor: st.fill,
                 fillOpacity: opts.fillOpacity ?? 0.35 },
        interactive: false,
      }).addTo(target);
      groups[t] = { group: grp, style: st };
    }
    return { surfaces, groups };
  },
};
