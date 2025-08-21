// andreani.js
require("dotenv").config();
const express = require("express");
const puppeteer = require("puppeteer");

/* =========================
   Config (ENV tunables)
   ========================= */
const PORT = parseInt(process.env.PORT || "3000", 10);

const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || "120000", 10);
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || "60000", 10);

const WAIT_AFTER_LOGIN_MS = parseInt(
  process.env.WAIT_AFTER_LOGIN_MS || "4000",
  10
); // margen post-login
const WAIT_BEFORE_VER_ENVIOS_MS = parseInt(
  process.env.WAIT_BEFORE_VER_ENVIOS_MS || "2500",
  10
);
const WAIT_AFTER_VER_ENVIOS_MS = parseInt(
  process.env.WAIT_AFTER_VER_ENVIOS_MS || "7000",
  10
); // espera por requests
const VER_ENVIOS_RELOAD_TRIES = parseInt(
  process.env.VER_ENVIOS_RELOAD_TRIES || "3",
  10
);

const HEADLESS =
  (process.env.HEADLESS || "false").toLowerCase() === "true" ? "new" : false; // en prod: true/new

// Credenciales desde .env
const ANDREANI_EMAIL = process.env.ANDREANI_EMAIL;
const ANDREANI_PASSWORD = process.env.ANDREANI_PASSWORD;

/* =========================
   Utils
   ========================= */
const log = (m, ...rest) =>
  console.log(
    `${new Date().toISOString().replace("T", " ").replace("Z", "")}  ${m}`,
    ...rest
  );
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, a = 12, b = 8) =>
  !s || s.length <= a + b + 3 ? s : `${s.slice(0, a)}...${s.slice(-b)}`;

function extractAccessTokenFromUrl(urlStr) {
  try {
    if (urlStr.includes("#")) {
      const [base, hash] = urlStr.split("#");
      const fake = `${base}?${hash}`;
      const u = new URL(fake);
      return u.searchParams.get("access_token");
    }
    const u = new URL(urlStr);
    return u.searchParams.get("access_token");
  } catch {
    return null;
  }
}

async function tryReadTokenFromStorage(page) {
  try {
    const t = await page.evaluate(() => {
      const looksJWT = (v) =>
        typeof v === "string" && v.split(".").length === 3;
      const pick = (store) => {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          const v = store.getItem(k);
          if (looksJWT(v)) return v;
        }
        return null;
      };
      return pick(localStorage) || pick(sessionStorage) || null;
    });
    return t;
  } catch {
    return null;
  }
}

/* =========================
   Browser helpers
   ========================= */
async function launchBrowser() {
  return puppeteer.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 500, // Más lento para ver mejor cuando está visible
    devtools: !HEADLESS, // Abre DevTools cuando está visible
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--window-size=1366,900",
      "--lang=es-AR,es;q=0.9,en;q=0.8",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1366, height: 900 },
  });
}

async function preparePage(page, bearerSink) {
  // User-Agent e idioma
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
  });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  page.setDefaultTimeout(STEP_TIMEOUT_MS);

  // Evitar webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // Canal para recibir bearer desde el contexto de la página
  await page.exposeFunction("__pushBearerFromPage", (token) => {
    if (token && /^Bearer\s+/i.test(token) && !bearerSink.value) {
      bearerSink.value = token;
      log(`✅ (page hook) Bearer: ${truncate(token)}`);
    }
  });

  // Hookear fetch y XHR antes de que la app se cargue
  await page.evaluateOnNewDocument(() => {
    try {
      // fetch
      const _fetch = window.fetch;
      window.fetch = async function (input, init) {
        try {
          let auth = null;
          if (init && init.headers) {
            const h = init.headers;
            if (typeof h.get === "function") {
              auth = h.get("authorization");
            } else if (Array.isArray(h)) {
              const found = h.find(
                ([k]) => String(k).toLowerCase() === "authorization"
              );
              auth = found ? found[1] : null;
            } else {
              auth = h.authorization || h.Authorization || null;
            }
          }
          if (auth && /^Bearer\s+/i.test(auth)) {
            window.__pushBearerFromPage && window.__pushBearerFromPage(auth);
          }
        } catch {}
        return _fetch.apply(this, arguments);
      };

      // XHR
      const XHR = window.XMLHttpRequest;
      const _open = XHR.prototype.open;
      const _set = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function () {
        this.__andreaniUrl = arguments[1];
        return _open.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (
            String(name).toLowerCase() === "authorization" &&
            /^Bearer\s+/i.test(value)
          ) {
            window.__pushBearerFromPage && window.__pushBearerFromPage(value);
          }
        } catch {}
        return _set.apply(this, arguments);
      };
    } catch {}
  });
}

/* =========================
   Home detector
   ========================= */
async function waitForHomeReady(page, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await Promise.race([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 800 })
        .catch(() => null),
      wait(250),
    ]);
    try {
      const state = await page.evaluate(() => {
        const onLogin = !!document.querySelector("#localAccountForm");
        const hasCTA = !!(
          document.querySelector("#ver_envios") ||
          document.querySelector("#hacer_envio")
        );
        const href = location.href;
        const ready = document.readyState;

        const looksJWT = (v) =>
          typeof v === "string" && v.split(".").length === 3;
        let storageTok = null;
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k);
            if (looksJWT(v)) {
              storageTok = v;
              break;
            }
          }
          if (!storageTok) {
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              const v = sessionStorage.getItem(k);
              if (looksJWT(v)) {
                storageTok = v;
                break;
              }
            }
          }
        } catch {}

        return { onLogin, hasCTA, href, ready, hasStorageTok: !!storageTok };
      });

      if (!state.onLogin && state.hasCTA)
        return { ok: true, storageReady: state.hasStorageTok };
      if (
        /pymes\.andreani\.com/i.test(state.href) &&
        (state.ready === "interactive" || state.ready === "complete")
      ) {
        return { ok: true, storageReady: state.hasStorageTok };
      }
      if (
        /onboarding\.andreani\.com/i.test(state.href) &&
        state.hasStorageTok
      ) {
        await wait(1200);
        return { ok: true, storageReady: true };
      }
    } catch {
      await wait(300);
    }
  }
  return { ok: false, storageReady: false };
}

/* =========================
   Core: login + capturar Bearer en /ver-envios
   ========================= */
async function getBearerFromHistory(email, password) {
  let browser, page;
  const bearerRef = { value: null };

  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    await preparePage(page, bearerRef);

    // Captura por red de cualquier request con Authorization: Bearer
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      try {
        const url = req.url();
        const headers = req.headers();
        const auth = headers.authorization || headers.Authorization;
        if (auth && /^Bearer\s+/i.test(auth)) {
          bearerRef.value = bearerRef.value || auth;
          log(`✅ (net) Bearer en ${url}: ${truncate(auth)}`);
        }
      } catch {}
      req.continue().catch(() => {});
    });

    // 1) Login
    log("🔵 Navegando al login…");
    await page.goto("https://onboarding.andreani.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    log("🟩 Completando formulario…");
    await page.waitForSelector("#signInName", { visible: true });
    await page.click("#signInName", { clickCount: 3 });
    await page.type("#signInName", email, { delay: 80 });

    await page.click("#password", { clickCount: 3 });
    await page.type("#password", password, { delay: 80 });

    await page.click("#next");

    // 2) Espera robusta de home
    log("⏳ Esperando que cargue el home…");
    const home = await waitForHomeReady(page, STEP_TIMEOUT_MS + 60000);
    if (!home.ok) throw new Error("No se detectó el home post-login a tiempo");

    await wait(WAIT_AFTER_LOGIN_MS);

    // Si seguimos en onboarding pero ya hay token en storage, empujar a pymes
    if (/onboarding\.andreani\.com/i.test(page.url()) && home.storageReady) {
      log(
        "➡️ Token listo pero seguimos en onboarding; navegando a https://pymes.andreani.com/ …"
      );
      await page.goto("https://pymes.andreani.com/", {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await wait(2000);
    }

    // 3) Asegurar estar en pymes y navegar a /ver-envios
    if (!/pymes\.andreani\.com/i.test(page.url())) {
      log("ℹ️ Forzando ir al home de pymes…");
      await page.goto("https://pymes.andreani.com/", {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await wait(1500);
    }

    // 4) /ver-envios con reintentos
    for (let i = 1; i <= VER_ENVIOS_RELOAD_TRIES && !bearerRef.value; i++) {
      log(`➡️ Navegando a /ver-envios… (try ${i}/${VER_ENVIOS_RELOAD_TRIES})`);
      await page.goto("https://pymes.andreani.com/ver-envios", {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });

      // activar foco y pequeño scroll (algunas apps disparan carga al interactuar)
      try {
        await page.evaluate(() => {
          window.dispatchEvent(new Event("focus"));
          window.scrollTo(0, 1);
          window.scrollTo(0, 0);
        });
      } catch {}

      log("🔄 Esperando requests…");
      await wait(WAIT_BEFORE_VER_ENVIOS_MS);
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await wait(WAIT_AFTER_VER_ENVIOS_MS);
    }

    // 5) Fallbacks si aún no hay Bearer
    if (!bearerRef.value) {
      const tokFromUrl = extractAccessTokenFromUrl(page.url());
      if (tokFromUrl) {
        bearerRef.value = `Bearer ${tokFromUrl}`;
        log(`✅ Token desde URL: ${truncate(bearerRef.value)}`);
      }
    }
    if (!bearerRef.value) {
      const stored = await tryReadTokenFromStorage(page);
      if (stored) {
        bearerRef.value = `Bearer ${stored}`;
        log(`✅ Token desde storage: ${truncate(bearerRef.value)}`);
      }
    }

    if (!bearerRef.value) {
      await page.screenshot({ path: "debug-no-bearer.png" }).catch(() => {});
      throw new Error(
        "No se pudo capturar el Bearer desde /ver-envios ni por fallback"
      );
    }

    return bearerRef.value;
  } finally {
    if (browser) {
      log("🔴 Cerrando navegador…");
      await browser.close().catch(() => {});
    }
  }
}

/* =========================
   HTTP Server
   ========================= */
const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("andreani token svc"));

app.post("/get-andreani-token", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "Email y contraseña son requeridos" });
    }
    const token = await getBearerFromHistory(email, password);
    res.json({
      success: true,
      token,
      message: "Token capturado (header/URL/storage)",
    });
  } catch (e) {
    log("❌ Error endpoint:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Solo iniciar el servidor si este archivo se ejecuta directamente
if (require.main === module) {
  // Si se pasan argumentos de línea de comandos, ejecutar directamente
  const args = process.argv.slice(2);
  if (args.length === 2) {
    const [email, password] = args;
    log("🎯 Modo directo con argumentos: ejecutando captura de token...");
    log(`📧 Email: ${email}`);

    getBearerFromHistory(email, password)
      .then((token) => {
        log("✅ ¡Token capturado exitosamente!");
        log(`🎫 Token: ${token}`);
        process.exit(0);
      })
      .catch((error) => {
        log("❌ Error:", error.message);
        process.exit(1);
      });
  } else if (args.length === 1 && args[0] === "run") {
    // Modo directo usando credenciales del .env
    if (!ANDREANI_EMAIL || !ANDREANI_PASSWORD) {
      log(
        "❌ Error: ANDREANI_EMAIL y ANDREANI_PASSWORD deben estar definidos en el archivo .env"
      );
      log("💡 Crea un archivo .env con:");
      log("   ANDREANI_EMAIL=tu_email@andreani.com");
      log("   ANDREANI_PASSWORD=tu_password");
      process.exit(1);
    }

    log("🎯 Modo directo con .env: ejecutando captura de token...");
    log(`📧 Email: ${ANDREANI_EMAIL}`);

    getBearerFromHistory(ANDREANI_EMAIL, ANDREANI_PASSWORD)
      .then((token) => {
        log("✅ ¡Token capturado exitosamente!");
        log(`🎫 Token: ${token}`);
        process.exit(0);
      })
      .catch((error) => {
        log("❌ Error:", error.message);
        process.exit(1);
      });
  } else {
    // Modo servidor HTTP
    app.listen(PORT, () => {
      log(
        `🚀 Server listening on http://0.0.0.0:${PORT} (headless=${HEADLESS}, navTimeout=${NAV_TIMEOUT_MS}ms)`
      );
      log("💡 Opciones de uso:");
      log("   - Servidor HTTP: node andreani.js");
      log("   - Directo con .env: node andreani.js run");
      log(
        "   - Directo con args: node andreani.js email@ejemplo.com password123"
      );
    });
  }
}

// Exportar funciones para uso en otros scripts
module.exports = {
  getBearerFromHistory,
  launchBrowser,
  preparePage,
};
