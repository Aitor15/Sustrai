/* Sustrai kontuak — Firebase egokitzailea.
   Aplikazioak erabiltzen duen window.claude.use(...) interfazea Firebase-ren gainean eskaintzen du:
   db (Firestore), user (saioa), downloads (fitxategiak deskargatu). Besteak (sample, mcp) ez daude. */
(function () {
  "use strict";
  const CFG = window.SUSTRAI_CONFIG || {};
  const ADMIN = String(CFG.adminEmail || "").trim().toLowerCase();
  let fs = null, auth = null, initError = null;
  try {
    firebase.initializeApp(CFG.firebase);
    auth = firebase.auth();
    fs = firebase.firestore();
    fs.settings({ ignoreUndefinedProperties: true });
  } catch (e) { initError = e; console.error("Firebase:", e); }

  // ---- Saioa: admina Google-rekin, besteak izenik gabe (anonimoki) ----
  const authReady = new Promise((resolve) => {
    if (!auth) return resolve(null);
    let tried = false;
    auth.getRedirectResult().catch(() => {});
    auth.onAuthStateChanged((u) => {
      if (u) return resolve(u);
      if (tried) return resolve(null);
      tried = true;
      auth.signInAnonymously().catch((e) => { console.error(e); resolve(null); });
    });
  });
  const isAdminUser = (u) => !!(u && !u.isAnonymous && u.email && u.email.toLowerCase() === ADMIN);

  // ---- Datu-basea ----
  const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;
  function flatten(obj, pre, out) {
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (isPlain(v) && Object.keys(v).length) flatten(v, pre + k + ".", out);
      else out[pre + k] = v === undefined ? null : v;
    });
    return out;
  }
  const wrapDoc = (ref) => ({
    id: ref.id,
    set: (d) => ref.set(d),
    update: (d) => {
      const f = flatten(d, "", {}), ks = Object.keys(f);
      // Ordainketa bakarra markatzean, nork-nori gehitu (segurtasun-arauek egiaztatzen dute).
      if (ks.length === 1 && ks[0].startsWith("ordainduak.")) { const [from, to] = ks[0].slice(11).split("__"); if (from && to) f.ordainduakAzkena = { from, to }; }
      return ref.update(f);
    },
    delete: () => ref.delete(),
    onSnapshot: (a, b) => ref.onSnapshot(a, b),
  });
  const db = fs && {
    collection: (c) => { const col = fs.collection(c); return { doc: (id) => wrapDoc(id ? col.doc(id) : col.doc()), onSnapshot: (a, b) => col.onSnapshot(a, b) }; },
    doc: (p) => wrapDoc(fs.doc(p)),
  };

  // ---- PINak eta loturak ----
  window.sustraiSetPin = (compId, pin) => fs.collection("pinak").doc(compId).set({ pin: String(pin) });
  window.sustraiClaim = async (compId, pin) => {
    const u = auth.currentUser; if (!u) throw new Error("no-user");
    await fs.collection("loturak").doc(u.uid).set({ comp: compId, pin: String(pin), creado: new Date().toISOString() });
    await fs.collection("componentes").doc(compId).update({ uid: u.uid });
  };
  // PINa kendu: PINa ezabatu, gailu guztiak deskonektatu eta "lotuta" marka kendu.
  window.sustraiRevoke = async (compId) => {
    await fs.collection("pinak").doc(compId).delete();
    await window.sustraiUnlink(compId);
    await fs.collection("componentes").doc(compId).update({ uid: null });
  };
  window.sustraiUnlink = async (compId) => {
    const snap = await fs.collection("loturak").where("comp", "==", compId).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  };

  // ---- Kilometroak eta bidesariak: Google Routes API (aukerakoa, gakoa config.js-n) ----
  const splitTray = (tray) => {
    let pts = tray.split(/\s*[–—>→\/]\s*|\s+-\s+|\s+a\s+/).map((x) => x.trim()).filter(Boolean);
    if (pts.length < 2) pts = tray.split("-").map((x) => x.trim()).filter(Boolean);
    return pts;
  };
  // ---- Bidesarien taula ofiziala (Bidegi / Interbiak, arinak, 2026-01-01etik) ----
  // Euskal Herriko ordainpeko autobideak, arinak / 1. klasea. Urtarrilero eguneratu (Iparraldea: otsailean):
  // Bidegi/Interbiak (AP-8, AP-1, AP-636), Audenasa (AP-15), Bizkaia/Araba (AP-68), ASF-Vinci (A63).
  // W = AP-8/AP-1 mendebaldea (Bilbo – Gasteiz – Donostia); E = AP-8 Donostia – Irun.
  const TOLL_YEAR = 2026;
  const WN = ["AO", "Amorebieta", "Iurreta", "Abadino", "Ermua", "Eibar", "BergaraIN", "BergaraHS", "Arrasate", "Eskoriatza", "Luko", "Etxabarri", "Elgoibar", "Itziar", "Zestoa", "Zarautz", "Donostia"];
  const WROWS = {
    AO: [null, 1.05, 2.8, 3.3, 4.6, 6.66, 8.23, 9.01, 9.66, 11.31, 15.14, 16.39, 7.56, 8.84, 9.74, 11.12, 13.81],
    Iurreta: [2.8, 2.8, null, null, 1.75, 2.97, 4.54, 5.32, 5.97, 7.62, 11.45, 12.7, 3.87, 5.15, 6.05, 7.43, 10.12],
    Abadino: [3.3, 3.3, null, null, 1.25, 2.44, 4.01, 4.79, 5.44, 7.09, 10.92, 12.17, 3.34, 4.62, 5.52, 6.9, 9.59],
    Ermua: [4.6, 4.6, 1.75, 1.25, null, 1.22, 2.79, 3.57, 4.22, 5.87, 9.7, 10.95, 2.12, 3.4, 4.3, 5.68, 8.37],
    Eibar: [6.66, 6.66, 2.97, 2.44, 1.22, null, 1.88, 2.66, 3.31, 4.96, 8.79, 10.04, 1.17, 2.47, 3.27, 4.75, 7.43],
    BergaraIN: [8.23, 8.23, 4.54, 4.01, 2.79, 1.88, null, null, null, null, null, null, 2.58, 3.85, 4.57, 6.13, 8.71],
    BergaraHS: [9.01, 9.01, 5.32, 4.79, 3.57, 2.66, null, null, 0.89, 2.45, 6.31, 7.56, 3.36, 4.63, 5.35, 6.91, 9.49],
    Arrasate: [9.66, 9.66, 5.97, 5.44, 4.22, 3.31, null, 0.89, null, 1.71, 5.54, 6.79, 4.01, 5.28, 6.0, 7.56, 10.14],
    Eskoriatza: [11.31, 11.31, 7.62, 7.09, 5.87, 4.96, null, 2.45, 1.71, null, 3.97, 5.22, 5.66, 6.93, 7.65, 9.21, 11.79],
    Luko: [15.14, 15.14, 11.45, 10.92, 9.7, 8.79, null, 6.31, 5.54, 3.97, null, 1.5, 9.49, 10.76, 11.48, 13.04, 15.62],
    Etxabarri: [16.39, 16.39, 12.7, 12.17, 10.95, 10.04, null, 7.56, 6.79, 5.22, 1.5, null, 10.74, 12.01, 12.73, 14.29, 16.87],
    Elgoibar: [7.56, 7.56, 3.87, 3.34, 2.12, 1.17, 2.58, 3.36, 4.01, 5.66, 9.49, 10.74, null, 1.63, 2.35, 3.92, 6.41],
    Itziar: [8.84, 8.84, 5.15, 4.62, 3.4, 2.47, 3.85, 4.63, 5.28, 6.93, 10.76, 12.01, 1.63, null, 1.17, 2.47, 5.17],
    Zestoa: [9.74, 9.74, 6.05, 5.52, 4.3, 3.27, 4.57, 5.35, 6.0, 7.65, 11.48, 12.73, 2.35, 1.17, null, 1.74, 4.41],
    // Zarautz – Donostia: taulan ez dago zuzenean; Zarautzeko sarrerako barrera 2,80 € (taldeak egiaztatua).
    Zarautz: [11.12, 11.12, 7.43, 6.9, 5.68, 4.75, 6.13, 6.91, 7.56, 9.21, 13.04, 14.29, 3.92, 2.47, 1.74, null, 2.8],
  };
  const W = {};
  WN.forEach((n) => { W[n] = {}; });
  Object.entries(WROWS).forEach(([a, row]) => row.forEach((v, i) => { if (v != null) { W[a][WN[i]] = v; W[WN[i]][a] = v; } }));
  W.Amorebieta.AO = W.AO.Amorebieta = 1.05;
  const E = { Donostia: { Oiartzun: 1.61, Irun: 2.24, Behobia: 2.47 }, Oiartzun: { Irun: 2.24, Behobia: 2.47 }, Irun: { Behobia: 0.5 } };
  // A63 Iparralde (ASF / Vinci, 1. klasea, 2026-02-01etik). Biriatou = Behobia (muga).
  const F = { Biriatou: { SJL: 2.0, Biarritz: 3.2, Bayonne: 4.8, Ondres: 5.8, Capbreton: 6.8 }, SJL: { Biarritz: 1.2, Bayonne: 2.8, Ondres: 3.8, Capbreton: 4.8 },
    Biarritz: { Bayonne: 1.2, Ondres: 2.2, Capbreton: 3.2 }, Bayonne: { Ondres: 1.0, Capbreton: 2.0 }, Ondres: { Capbreton: 1.0 } };
  // Lerroko sareak: barrera bakoitzaren prezioa, ondoz ondoko sarbideen artean (batu egiten dira).
  // AP-636 (Bidegi 2026). Antzuola–Bergara = 1,55 − 0,52 (kalkulatua).
  const G = [["Beasain", "Ormaiztegi", 0.42], ["Ormaiztegi", "Zumarraga", 0.82], ["Zumarraga", "Antzuola", 0.52], ["Antzuola", "Bergara", 1.03]];
  // AP-15 Nafarroa (Audenasa 2026): Sarasa, Oriz-Tiebas, Marcilla (enlace / tronco) barrerak.
  const N = [["Irurtzun", "Pamplona", 2.65], ["Pamplona", "Tafalla", 4.55], ["Tafalla", "Marcilla", 3.45], ["Tafalla", "Tudela", 6.85]];
  // AP-68 Euskadi, 2026-11-11tik (Bizkaia −20 %, Araba −70 %). Errioxa, Aragoi eta Nafarroako zatia doan.
  const A = [["Bilbao", "Areta", 3.35], ["Areta", "Altube", 0.9], ["Altube", "Zambrana", 2.45]];
  const mGet = (T, a, b) => (T[a] && T[a][b]) ?? (T[b] && T[b][a]);
  const lineGet = (edges, a, b) => { // zuhaitza: bide bakarra
    const adj = {}; edges.forEach(([x, y, v]) => { (adj[x] = adj[x] || []).push([y, v]); (adj[y] = adj[y] || []).push([x, v]); });
    if (!adj[a] || !adj[b]) return undefined;
    const seen = { [a]: 0 }, q = [a];
    while (q.length) { const x = q.shift(); for (const [y, v] of adj[x]) if (!(y in seen)) { seen[y] = seen[x] + v; q.push(y); } }
    return b in seen ? Math.round(seen[b] * 100) / 100 : undefined;
  };
  const SOUTH = new Set(["Arrasate", "Eskoriatza", "Luko", "Etxabarri"]);
  const wGet = (a, b) => {
    if (a === "Bergara") a = SOUTH.has(b) ? "BergaraHS" : "BergaraIN";
    if (b === "Bergara") b = SOUTH.has(a) ? "BergaraHS" : "BergaraIN";
    return W[a] ? W[a][b] : undefined;
  };
  const NET = {
    W: (a, b) => wGet(a, b), E: (a, b) => mGet(E, a, b), F: (a, b) => mGet(F, a, b),
    G: (a, b) => lineGet(G, a, b), N: (a, b) => lineGet(N, a, b), A: (a, b) => lineGet(A, a, b),
  };
  // Sareen arteko loturak (sarbide bera bi sareetan).
  const GATES = [["W", "Donostia", "E", "Donostia"], ["E", "Behobia", "F", "Biriatou"], ["W", "Bergara", "G", "Bergara"], ["W", "AO", "A", "Bilbao"]];
  // Sarbideen kokapena: Google-ren ibilbide errealetan ordainpeko tarteak hasi eta amaitzen diren lekuak.
  const NODES = [["W:AO", 43.237, -2.885], ["W:Amorebieta", 43.220, -2.733], ["W:Iurreta", 43.174, -2.638], ["W:Abadino", 43.151, -2.611], ["W:Ermua", 43.189, -2.493], ["W:Eibar", 43.183, -2.472],
    ["W:Bergara", 43.126, -2.423], ["W:Bergara", 43.107, -2.401], ["W:Arrasate", 43.066, -2.487], ["W:Arrasate", 43.074, -2.463], ["W:Eskoriatza", 43.017, -2.528], ["W:Luko", 42.935, -2.642], ["W:Etxabarri", 42.916, -2.710],
    ["W:Elgoibar", 43.216, -2.413], ["W:Itziar", 43.276, -2.330], ["W:Zestoa", 43.255, -2.260], ["W:Zarautz", 43.285, -2.171], ["W:Donostia", 43.268, -2.018], ["W:Donostia", 43.281, -1.948], ["W:Donostia", 43.289, -2.022],
    ["E:Oiartzun", 43.300, -1.860], ["E:Irun", 43.338, -1.789], ["E:Irun", 43.330, -1.803], ["E:Behobia", 43.339, -1.755],
    ["F:SJL", 43.374, -1.682], ["F:Biarritz", 43.452, -1.556], ["F:Bayonne", 43.488, -1.449], ["F:Bayonne", 43.510, -1.460], ["F:Ondres", 43.565, -1.435], ["F:Capbreton", 43.631, -1.394],
    ["G:Beasain", 43.046, -2.226], ["G:Ormaiztegi", 43.051, -2.261], ["G:Zumarraga", 43.080, -2.309], ["G:Antzuola", 43.095, -2.370],
    ["N:Irurtzun", 42.901, -1.799], ["N:Pamplona", 42.837, -1.690], ["N:Pamplona", 42.757, -1.629], ["N:Tafalla", 42.563, -1.642], ["N:Tafalla", 42.512, -1.668], ["N:Marcilla", 42.334, -1.723], ["N:Tudela", 42.195, -1.675],
    ["A:Bilbao", 43.235, -2.918], ["A:Areta", 43.158, -2.936], ["A:Altube", 42.964, -2.867], ["A:Zambrana", 42.660, -2.880]];
  const NAMES = { AO: "Bilbo", Bilbao: "Bilbo", Abadino: "Abadiño", Etxabarri: "Etxabarri-Ibiña", Zestoa: "Zestoa-Zumaia", SJL: "Donibane Lohizune", Bayonne: "Baiona", Biarritz: "Biarritz", Pamplona: "Iruñea", Areta: "Areta (Laudio)" };
  const kmBetween = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const nearNode = (ll, maxKm = 6) => { let best = null, d = 1e9; NODES.forEach((n) => { const k = kmBetween(ll, [n[1], n[2]]); if (k < d) { d = k; best = n[0]; } }); return d <= maxKm ? best : null; };
  const tollPrice = (A1, B1) => { // "Sarea:Sarbidea" formatuan
    if (!A1 || !B1) return undefined;
    const [na, a] = A1.split(":"), [nb, b] = B1.split(":");
    if (na === nb) return a === b ? 0 : NET[na](a, b);
    // sareen arteko bidea (BFS) eta zatien batura
    const q = [[na, a, 0]], seen = new Set([na]);
    while (q.length) {
      const [n, at, sum] = q.shift();
      for (const [x, xa, y, ya] of GATES.flatMap((g) => [g, [g[2], g[3], g[0], g[1]]])) {
        if (x !== n || seen.has(y)) continue;
        const p = at === xa ? 0 : NET[n](at, xa); if (p === undefined) continue;
        if (y === nb) { const p2 = ya === b ? 0 : NET[y](ya, b); if (p2 !== undefined) return Math.round((sum + p + p2) * 100) / 100; continue; }
        seen.add(y); q.push([y, ya, sum + p]);
      }
    }
    return undefined;
  };
  window.sustraiTollPrice = tollPrice;

  if (CFG.googleMapsKey) {
    window.sustraiRouteKm = async (tray, ap) => {
      const pts = splitTray(tray);
      if (pts.length < 2) return null;
      const wp = (p) => ({ address: p });
      const body = {
        origin: wp(pts[0]), destination: wp(pts[pts.length - 1]),
        intermediates: pts.slice(1, -1).map(wp),
        travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE",
        extraComputations: ["TOLLS"],
        routeModifiers: { avoidTolls: !ap, vehicleInfo: { emissionType: "GASOLINE" } },
        regionCode: "es", languageCode: "es", units: "METRIC",
      };
      const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": CFG.googleMapsKey,
          "X-Goog-FieldMask": "routes.distanceMeters,routes.description,routes.travelAdvisory.tollInfo,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction.instructions,routes.legs.steps.startLocation,routes.legs.steps.endLocation" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} console.error("Google Routes:", r.status, m); throw new Error("routes " + r.status); }
      const j = await r.json();
      const rt = j.routes && j.routes[0];
      if (!rt || !rt.distanceMeters) return null;
      const ti = rt.travelAdvisory && rt.travelAdvisory.tollInfo;
      // Google-k ez du Espainiako bidesarien preziorik ematen, baina ordainpeko tarteak markatzen ditu
      // ("Carretera con peajes"). Tarte bakoitzaren sarrera eta irteera ezagututa, taula ofizialeko prezioa;
      // taulan ez badago (AP-15, AP-68…), km-ak × €/km (config.js: bidesariaKm).
      const rate = Number(CFG.bidesariaKm) > 0 ? Number(CFG.bidesariaKm) : 0.14;
      const LL = (l) => l && l.latLng ? [l.latLng.latitude, l.latLng.longitude] : null;
      const runs = []; let cur = null;
      (rt.legs || []).forEach((lg) => (lg.steps || []).forEach((st) => {
        const t = (st.navigationInstruction && st.navigationInstruction.instructions) || "";
        if (/peaje/i.test(t)) { if (!cur) { cur = { from: LL(st.startLocation), m: 0 }; runs.push(cur); } cur.to = LL(st.endLocation); cur.m += st.distanceMeters || 0; }
        else if ((st.distanceMeters || 0) > 1500) cur = null; // zati libre luze batek tartea mozten du
      }));
      let tollKm = 0, peajes = 0; const parts = [];
      runs.forEach((r) => {
        const km = r.m / 1000; tollKm += km;
        let a = r.from && nearNode(r.from), b = r.to && nearNode(r.to);
        // AP-68: Zambranatik hegoaldera doan da 2026-11-11tik (Google-k oraindik ordainpekotzat markatzen du).
        if (a && a.startsWith("A:") && !b && r.to && r.to[0] < 42.7) b = "A:Zambrana";
        if (b && b.startsWith("A:") && !a && r.from && r.from[0] < 42.7) a = "A:Zambrana";
        if (!b && a && a.startsWith("N:") && r.to && r.to[0] < 42.2) b = "N:Tudela";
        const p = a && b ? tollPrice(a, b) : undefined;
        const nm = (n) => { const k = n.split(":")[1]; return NAMES[k] || k; };
        if (p !== undefined) { if (p > 0) parts.push(`${nm(a)} → ${nm(b)} ${p.toFixed(2).replace(".", ",")} € (tarifa ${TOLL_YEAR})`); peajes += p; }
        else if (km >= 0.5) { const e = Math.round(km * rate * 100) / 100; parts.push(`${String(Math.round(km * 10) / 10).replace(".", ",")} km ordainpeko × ${String(rate).replace(".", ",")} € (estimazioa)`); peajes += e; }
      });
      tollKm = Math.round(tollKm * 10) / 10; peajes = Math.round(peajes * 100) / 100;
      if (!ap) peajes = 0;
      else if (ti && ti.estimatedPrice && ti.estimatedPrice.length) {
        const eur = ti.estimatedPrice.find((x) => x.currencyCode === "EUR") || ti.estimatedPrice[0];
        peajes = Math.round((Number(eur.units || 0) + Number(eur.nanos || 0) / 1e9) * 100) / 100; parts.length = 0;
      }
      const kalkulua = ap ? parts.join(" + ") : "";
      return { km: Math.round(rt.distanceMeters / 100) / 10, ruta: (rt.description || (ap ? "ibilbide azkarrena" : "bidesaririk gabeko ibilbidea")) + (kalkulua ? ` — ${kalkulua}` : ""), peaje: !!ap, peajes, tollKm, exacto: ap && parts.length > 0 && parts.every((x) => /tarifa/.test(x)), fuente: "Google Maps" };
    };
  }

  // ---- Kilometroak: OpenRouteService (aukerakoa, gakoa config.js-n) ----
  if (CFG.openRouteServiceKey && !CFG.googleMapsKey) {
    const K = CFG.openRouteServiceKey;
    const geocode = async (name) => {
      const u = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(K)}&text=${encodeURIComponent(name)}&boundary.country=ES,FR&focus.point.lon=-2.0&focus.point.lat=43.1&size=1`;
      const r = await fetch(u); if (!r.ok) throw new Error("geocode " + r.status);
      const j = await r.json(); const f = j.features && j.features[0];
      if (!f) throw new Error("not found: " + name);
      return f.geometry.coordinates;
    };
    window.sustraiRouteKm = async (tray, ap) => {
      let pts = tray.split(/\s*[–—>→\/]\s*|\s+-\s+|\s+a\s+/).map((x) => x.trim()).filter(Boolean);
      if (pts.length < 2) pts = tray.split("-").map((x) => x.trim()).filter(Boolean);
      if (pts.length < 2) return null;
      const coords = [];
      for (const p of pts) coords.push(await geocode(p));
      const body = { coordinates: coords, preference: ap ? "fastest" : "shortest", extra_info: ["tollways"] };
      if (!ap) body.options = { avoid_features: ["tollways"] };
      const r = await fetch("https://api.openrouteservice.org/v2/directions/driving-car", { method: "POST", headers: { Authorization: K, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("directions " + r.status);
      const j = await r.json();
      const r0 = j.routes && j.routes[0];
      const m = r0 && r0.summary && r0.summary.distance;
      if (!m) return null;
      // Bidesaria: ibilbideko ordainpeko km-ak × €/km (config.js-n aldatu daiteke).
      const tw = (r0.extras && r0.extras.tollways && r0.extras.tollways.summary) || [];
      const tollM = tw.filter((x) => x.value === 1).reduce((s, x) => s + (x.distance || 0), 0);
      const tollKm = Math.round(tollM / 100) / 10;
      const rate = Number(CFG.bidesariaKm) > 0 ? Number(CFG.bidesariaKm) : 0.12;
      const peajes = ap ? Math.round(tollKm * rate * 100) / 100 : 0;
      return { km: Math.round(m / 100) / 10, ruta: ap ? (tollKm ? `ibilbide azkarrena (${String(tollKm).replace(".", ",")} km autobidean)` : "ibilbide azkarrena, bidesaririk gabe") : "ibilbide laburrena, bidesaririk gabe", peaje: !!ap, peajes, tollKm, fuente: "OpenRouteService" };
    };
  }

  // ---- Deskargak ----
  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename || "fitxategia";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { status: "saved" };
    },
  };

  // ---- window.claude.use ----
  window.claude = {
    use: async (name) => {
      if (initError) return null;
      const u = await authReady;
      if (!u) return null;
      if (name === "db") return db;
      if (name === "downloads") return downloads;
      if (name === "user") {
        const admin = isAdminUser(u);
        if (admin && !window.sustraiPinIds) {
          window.sustraiPinIds = new Set();
          fs.collection("pinak").onSnapshot((snap) => { window.sustraiPinIds = new Set(snap.docs.map((d) => d.id)); window.dispatchEvent(new Event("sustrai-pins")); }, () => {});
        }
        if (!admin && window.sustraiMyComp === undefined) {
          window.sustraiMyComp = null;
          try {
            const l = await fs.collection("loturak").doc(u.uid).get();
            if (l.exists) {
              // PINa kendu edo aldatu bada, arauek irakurtzea ukatzen dute: berriro "Nor zara?" erakutsi.
              try { await fs.collection("ajustes").doc("general").get(); window.sustraiMyComp = l.data().comp || null; }
              catch (e) { window.sustraiMyComp = null; }
            }
          } catch (e) {}
        }
        return {
          isOwner: async () => admin,
          canEdit: async () => admin,
          can: async () => true,
          me: async () => ({ id: u.uid, email: u.isAnonymous ? null : u.email }),
        };
      }
      return null;
    },
  };

  // ---- Admin barra txikia (saioa, babeskopia, inportazioa) ----
  const COLS = ["componentes", "bolos", "viajes", "rutas", "materiala", "abestiak", "setlistak", "ajustes", "bezeroak"];
  async function collectAll() {
    const out = {};
    for (const c of COLS) {
      try { const snap = await fs.collection(c).get(); out[c] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())); }
      catch (e) { if (c === "bezeroak") out[c] = []; else throw e; } // arau berriak oraindik argitaratu gabe badaude
    }
    return out;
  }
  // ---- Babeskopia automatikoa: astean behin, Firebase barruan (azken 8ak gordetzen dira) ----
  const BK_COL = "babeskopiak", BK_KEEP = 8, BK_DAYS = 7;
  const dayStr = (d) => { const x = d || new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  async function listBackups() { const snap = await fs.collection(BK_COL).get(); return snap.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => String(b.id).localeCompare(String(a.id))); }
  async function makeBackup(force) {
    const list = await listBackups();
    const last = list[0];
    if (!force && last && Date.now() - Date.parse(last.id + "T12:00:00") < BK_DAYS * 864e5) return null;
    const out = await collectAll();
    const json = JSON.stringify(out);
    if (json.length > 900000) { console.warn("Babeskopia handiegia Firebase-n gordetzeko:", json.length); return null; }
    const id = dayStr(), n = COLS.reduce((s, c) => s + out[c].length, 0);
    await fs.collection(BK_COL).doc(id).set({ noiz: new Date().toISOString(), json, n, tamaina: json.length, auto: !force });
    const all = await listBackups();
    for (const old of all.slice(BK_KEEP)) await fs.collection(BK_COL).doc(old.id).delete();
    return id;
  }
  async function backup() {
    const out = await collectAll();
    const d = new Date().toISOString().slice(0, 10);
    downloads.save({ filename: `sustrai-babeskopia-${d}.json`, data: new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }) });
  }
  async function importJson(file) { return importData(JSON.parse(await file.text())); }
  async function importData(data) {
    let n = 0, batch = fs.batch(), inBatch = 0;
    for (const c of COLS) {
      for (const doc of data[c] || []) {
        const { id, ...rest } = doc; if (!id) continue;
        delete rest.uid; delete rest.email;
        batch.set(fs.collection(c).doc(id), rest); n++; inBatch++;
        if (inBatch >= 400) { await batch.commit(); batch = fs.batch(); inBatch = 0; }
      }
    }
    if (inBatch) await batch.commit();
    return n;
  }
  function backupsPanel() {
    const old = document.getElementById("bk-panel"); if (old) old.remove();
    const w = document.createElement("div"); w.id = "bk-panel";
    w.style.cssText = "position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:16px";
    w.innerHTML = `<div style="background:var(--surface,#fff);color:var(--ink,#111);border-radius:14px;max-width:520px;width:100%;max-height:85vh;overflow:auto;padding:18px;font:14px var(--font-body,sans-serif);box-shadow:0 10px 40px rgba(0,0,0,.3)">
      <h2 style="margin:0 0 4px">Babeskopiak</h2>
      <p style="margin:0 0 12px;color:var(--muted,#666)">Astean behin bere kabuz egiten da, zu (admina) sartzean. Azken ${BK_KEEP}ak gordetzen dira Firebase-n.</p>
      <div id="bk-list">Kargatzen…</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap"><button type="button" class="btn" data-bk="now">Orain egin</button><button type="button" class="btn primary" data-bk="close">Itxi</button></div></div>`;
    document.body.appendChild(w);
    const fill = async () => {
      const box = w.querySelector("#bk-list");
      try {
        const list = await listBackups();
        box.innerHTML = list.length ? list.map((b) => `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line,#ddd);flex-wrap:wrap">
          <div><strong>${b.id}</strong><div style="color:var(--muted,#666);font-size:12px">${b.n || "?"} dokumentu · ${Math.round((b.tamaina || 0) / 1024)} KB${b.auto ? " · automatikoa" : ""}</div></div>
          <div style="display:flex;gap:6px"><button type="button" class="btn small" data-bk="dl" data-id="${b.id}">Deskargatu</button><button type="button" class="btn small" data-bk="restore" data-id="${b.id}">Leheneratu</button></div></div>`).join("") : "Oraindik ez dago babeskopiarik.";
        w._list = list;
      } catch (e) { box.textContent = "Ezin izan dira kargatu: " + (e.code || e.message); }
    };
    w.addEventListener("click", async (e) => {
      if (e.target === w) return w.remove();
      const b = e.target.closest("[data-bk]"); if (!b) return;
      const k = b.dataset.bk, item = (w._list || []).find((x) => x.id === b.dataset.id);
      if (k === "close") return w.remove();
      if (k === "now") { b.disabled = true; try { await makeBackup(true); await fill(); } catch (er) { alert("Errorea: " + (er.code || er.message)); } b.disabled = false; return; }
      if (k === "dl" && item) return downloads.save({ filename: `sustrai-babeskopia-${item.id}.json`, data: new Blob([JSON.stringify(JSON.parse(item.json), null, 2)], { type: "application/json" }) });
      if (k === "restore" && item) {
        if (!confirm(`${item.id}-ko babeskopia leheneratu? Data horretako dokumentuak berriro idatziko dira (geroztik sortutakoak ez dira ezabatzen).`)) return;
        try { const n = await importData(JSON.parse(item.json)); alert(n + " dokumentu leheneratuta ✓"); location.reload(); } catch (er) { alert("Errorea: " + (er.code || er.message)); }
      }
    });
    fill();
  }
  function bar() {
    const b = document.createElement("div"); b.id = "sustrai-bar";
    b.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:15;font:12px var(--font-body,sans-serif);display:flex;gap:10px;align-items:center;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:8px;padding:5px 9px;opacity:.85";
    const link = (txt, fn) => { const a = document.createElement("button"); a.type = "button"; a.textContent = txt; a.style.cssText = "border:0;background:none;color:var(--accent,#d0191c);cursor:pointer;padding:0;font:inherit;text-decoration:underline"; a.onclick = fn; return a; };
    authReady.then((u) => {
      if (isAdminUser(u)) {
        const lab = document.createElement("span"); lab.textContent = "★ Admin"; lab.style.color = "var(--muted,#666)";
        const file = document.createElement("input"); file.type = "file"; file.accept = "application/json,.json"; file.style.display = "none";
        file.onchange = async () => {
          if (!file.files[0]) return;
          if (!confirm("Fitxategiko datuak datu-basera kopiatuko dira (id bera duten dokumentuak ordezkatuz). Jarraitu?")) return;
          try { const n = await importJson(file.files[0]); alert(n + " dokumentu inportatuta ✓"); location.reload(); } catch (e) { alert("Errorea inportatzean: " + (e.message || e)); }
        };
        b.append(lab, link("Babeskopia", () => backup().catch((e) => alert("Errorea: " + e.message))), link("Babeskopiak", backupsPanel), link("Inportatu", () => file.click()), link("Irten", () => auth.signOut().then(() => location.reload())), file);
      } else {
        b.append(link("Admin sarrera", async () => {
          const p = new firebase.auth.GoogleAuthProvider();
          try { await auth.signInWithPopup(p); location.reload(); }
          catch (e) { if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) auth.signInWithRedirect(p); else if (e && e.code !== "auth/popup-closed-by-user") alert("Ezin izan da saioa hasi: " + (e.message || e)); }
        }));
      }
      if (u && !u.isAnonymous && !isAdminUser(u)) {
        const w = document.createElement("span"); w.textContent = u.email + " ez da admina"; w.style.color = "var(--bad,#b3141a)";
        b.append(w, link("Irten", () => auth.signOut().then(() => location.reload())));
      }
    });
    document.body.appendChild(b);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bar); else bar();
  authReady.then((u) => { if (isAdminUser(u)) setTimeout(() => makeBackup(false).then((id) => { if (id) console.log("Babeskopia automatikoa:", id); }).catch((e) => console.warn("Babeskopia automatikoa:", e)), 5000); });
})();
