// Sustrai kontuak — konfigurazioa. Bete 3 gauza hauek (ikusi GIDA.md).
window.SUSTRAI_CONFIG = {
  // 1) Firebase-k ematen dizun konfigurazioa (Project settings → Your apps → Config).
  firebase: {
    apiKey: "AIzaSyC5OOlxb0_W8CESvkt5Zao-pA7D-ZKDBVs",
    authDomain: "sustrai-80e7d.firebaseapp.com",
    projectId: "sustrai-80e7d",
    storageBucket: "sustrai-80e7d.firebasestorage.app",
    messagingSenderId: "652416004267",
    appId: "1:652416004267:web:12f9ad71dadf24db7e07ee",
  },

  // 2) Zure Google emaila (admina). firestore.rules fitxategian ere bera jarri.
  adminEmail: "ZURE_EMAILA@gmail.com",

  // 3) Aukerakoa: OpenRouteService gakoa, km-ak bere kabuz kalkulatzeko.
  //    Hutsik utziz gero, km-ak eskuz idatzi beharko dira.
  openRouteServiceKey: "",
};
