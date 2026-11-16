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

  // ---- Kilometroak: OpenRouteService (aukerakoa, gakoa config.js-n) ----
  if (CFG.openRouteServiceKey) {
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
      const body = { coordinates: coords, preference: ap ? "fastest" : "shortest" };
      if (!ap) body.options = { avoid_features: ["tollways"] };
      const r = await fetch("https://api.openrouteservice.org/v2/directions/driving-car", { method: "POST", headers: { Authorization: K, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("directions " + r.status);
      const j = await r.json();
      const m = j.routes && j.routes[0] && j.routes[0].summary && j.routes[0].summary.distance;
      if (!m) return null;
      return { km: Math.round(m / 100) / 10, ruta: ap ? "ibilbide azkarrena" : "ibilbide laburrena, bidesaririk gabe", peaje: !!ap, fuente: "OpenRouteService" };
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
  const COLS = ["componentes", "bolos", "viajes", "rutas", "materiala", "abestiak", "setlistak", "ajustes"];
  async function backup() {
    const out = {};
    for (const c of COLS) { const snap = await fs.collection(c).get(); out[c] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())); }
    const d = new Date().toISOString().slice(0, 10);
    downloads.save({ filename: `sustrai-babeskopia-${d}.json`, data: new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }) });
  }
  async function importJson(file) {
    const data = JSON.parse(await file.text());
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
  function bar() {
    const b = document.createElement("div"); b.id = "sustrai-bar";
    b.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:40;font:12px var(--font-body,sans-serif);display:flex;gap:10px;align-items:center;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:8px;padding:5px 9px;opacity:.85";
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
        b.append(lab, link("Babeskopia", () => backup().catch((e) => alert("Errorea: " + e.message))), link("Inportatu", () => file.click()), link("Irten", () => auth.signOut().then(() => location.reload())), file);
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
})();
