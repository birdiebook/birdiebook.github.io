// Delad kart-grund för alla vyer som ritar banan (kartvyn + strategivyn).
// Stateless helpers under window.CourseMap — ingen egen global state, ingen
// DOM-koppling. Laddas FÖRE app.js / strategy.js.
"use strict";

window.CourseMap = {
  // Esri World Imagery — gratis satellit, ingen nyckel.
  ESRI_URL:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  esriLayer() {
    return L.tileLayer(this.ESRI_URL, {
      maxZoom: 21, maxNativeZoom: 19,
      attribution:
        "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    });
  },

  // Ytfärger (delas av kartvy + strategivy + ev. legend).
  SURFACE_STYLE: {
    fairway:      { color: "#3a7d34", fill: "#4c9e44", label: "Fairway" },
    green:        { color: "#2fae57", fill: "#54d57e", label: "Green" },
    bunker:       { color: "#c9a24b", fill: "#e8c878", label: "Bunker" },
    water_hazard: { color: "#2f7fae", fill: "#4aa6e0", label: "Vatten" },
    tee:          { color: "#7d5bd0", fill: "#9d7ef0", label: "Tee" },
    ob:           { color: "#d04545", fill: "#e06666", label: "OB" },
    heavy_rough:  { color: "#6b7a2a", fill: "#8a9a3d", label: "Tjockruff" },
    mask:         { color: "#1f5c33", fill: "#2e7a46", label: "Mask (träd)" },
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
