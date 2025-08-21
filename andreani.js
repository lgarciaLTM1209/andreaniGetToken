// index.js
const puppeteer = require("puppeteer");
require("dotenv").config();
const express = require("express");

const app = express();
const port = 3000;
app.use(express.json());

/* =========================
   Helpers de captura token
   ========================= */

function truncateToken(tok, head = 12, tail = 8) {
  if (!tok || typeof tok !== "string") return tok;
  if (tok.length <= head + tail + 3) return tok;
  return tok.slice(0, head) + "..." + tok.slice(-tail);
}

function extractAccessTokenFromUrl(urlStr) {
  try {
    // Maneja query y fragment (#access_token=...)
    const hasHash = urlStr.includes("#");
    if (hasHash) {
      const [base, hash] = urlStr.split("#");
      const fake = `${base}?${hash}`;
      const u = new URL(fake);
      const token = u.searchParams.get("access_token");
      return token || null;
    } else {
      const u = new URL(urlStr);
      const token = u.searchParams.get("access_token");
      return token || null;
    }
  } catch {
    return null;
  }
}

async function waitForAccessToken(page, { timeout = 15000 } = {}) {
  let token = null;
  let resolveFn;
  const done = new Promise((resolve) => (resolveFn = resolve));

  // 1) Chequeo inmediato
  const immediate = extractAccessTokenFromUrl(page.url());
  if (immediate) return immediate;

  // 2) Listeners
  const onFrameNav = (frame) => {
    const url = frame.url();
    const t = extractAccessTokenFromUrl(url);
    if (t) {
      token = t;
      cleanup();
      resolveFn();
    }
  };
  const onRequest = (request) => {
    if (request.isNavigationRequest && request.isNavigationRequest()) {
      const url = request.url();
      const t = extractAccessTokenFromUrl(url);
      if (t) {
        token = t;
        cleanup();
        resolveFn();
      }
    }
  };

  page.on("framenavigated", onFrameNav);
  page.on("request", onRequest);

  const to = setTimeout(() => {
    cleanup();
    resolveFn();
  }, timeout);

  function cleanup() {
    page.off("framenavigated", onFrameNav);
    page.off("request", onRequest);
    clearTimeout(to);
  }

  await done;
  return token;
}

async function tryReadTokenFromStorage(page) {
  const data = await page.evaluate(() => {
    const looksJWT = (v) => typeof v === "string" && v.split(".").length === 3;
    const out = { localStorage: {}, sessionStorage: {} };

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        if (looksJWT(v)) out.localStorage[k] = v;
      }
    } catch (e) {}

    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        const v = sessionStorage.getItem(k);
        if (looksJWT(v)) out.sessionStorage[k] = v;
      }
    } catch (e) {}

    return out;
  });

  const prefer = (obj) => {
    const keys = Object.keys(obj);
    const preferred = keys.find((k) =>
      /access|token|auth|id_token|bearer|jwt/i.test(k)
    );
    return preferred ? obj[preferred] : keys[0] ? obj[keys[0]] : null;
  };

  return prefer(data.localStorage) || prefer(data.sessionStorage) || null;
}

/* =======================================
   getAndreaniToken: login + captura token
   ======================================= */

async function getAndreaniToken(email, password) {
  let browser;
  let page;
  let bearerToken = null;

  try {
    browser = await puppeteer.launch({
      headless: "shell",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();

    // Interceptar requests para capturar Bearer por header (fallback)
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = request.url();
      const headers = request.headers();

      if (
        headers.authorization &&
        headers.authorization.startsWith("Bearer ")
      ) {
        bearerToken = headers.authorization;
        console.log("✅ Bearer por header:", truncateToken(bearerToken));
      }

      // No bloquear requests de navegación
      request.continue();
    });

    console.log("🔵 Navegando al login...");
    await page.goto("https://onboarding.andreani.com/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    console.log("🔵 Completando login...");
    await page.waitForSelector("#signInName", {
      visible: true,
      timeout: 30000,
    });
    await page.type("#signInName", email, { delay: 60 });
    await page.type("#password", password, { delay: 60 });
    await page.click("#next");

    console.log("🟠 Esperando navegación post-login...");
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
      .catch(() => {});

    // 👉 Captura del access_token en el salto a pymes.andreani.com
    const tokenFromUrl = await waitForAccessToken(page, { timeout: 15000 });

    if (tokenFromUrl) {
      bearerToken = `Bearer ${tokenFromUrl}`;
      console.log("✅ access_token de URL:", truncateToken(bearerToken));
    } else if (page.url().includes("pymes.andreani.com")) {
      // Intentar storage si ya limpió la URL
      const stored = await tryReadTokenFromStorage(page);
      if (stored) {
        bearerToken = `Bearer ${stored}`;
        console.log("✅ Token desde storage:", truncateToken(bearerToken));
      } else {
        console.warn("⚠️ No encontré token en URL ni en storage.");
      }
    }

    // 🔁 Pausa mínima por si la app dispara XHRs con Authorization
    await new Promise((r) => setTimeout(r, 2000));

    if (!bearerToken) {
      await page.screenshot({ path: "debug-no-token.png" });
      throw new Error("No se pudo capturar el token de autorización");
    }

    return bearerToken;
  } catch (error) {
    console.error("❌ Error durante el proceso:", error);
    if (browser && page) {
      await page.screenshot({ path: "error-screenshot.png" });
    }
    throw error;
  } finally {
    if (browser) {
      console.log("🔴 Cerrando navegador...");
      await browser.close();
    }
  }
}

/* ====================================================
   getSucursalId: login + token + capturar ubicaciones
   ==================================================== */

async function getSucursalId(email, password, cp) {
  let browser;
  let page;
  let bearerToken = null;
  let ubicacionesPath = null;

  try {
    browser = await puppeteer.launch({
      headless: false, // 👈 visible
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      const headers = request.headers();

      if (
        headers.authorization &&
        headers.authorization.startsWith("Bearer ")
      ) {
        bearerToken = headers.authorization;
        console.log("✅ Bearer por header:", truncateToken(bearerToken));
      }

      if (
        url.includes("/api/v1/Sucursal/GetUbicacionesSucursales/") &&
        url.includes("?esOrigen=false")
      ) {
        const base = "/api/v1/Sucursal/GetUbicacionesSucursales/";
        const index = url.indexOf(base);
        if (index !== -1) {
          ubicacionesPath = url.substring(index + base.length);
          console.log("📍 Path capturado:", ubicacionesPath);
        }
      }

      request.continue();
    });

    // Login
    console.log("🔵 Login...");
    await page.goto("https://onboarding.andreani.com/", {
      waitUntil: "networkidle2",
    });

    await page.waitForSelector("#signInName", { visible: true });
    await page.type("#signInName", email, { delay: 50 });
    await page.type("#password", password, { delay: 50 });
    await page.click("#next");
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
      .catch(() => {});

    // 👉 Captura del token en salto a pymes
    const tokenFromUrl = await waitForAccessToken(page, { timeout: 15000 });
    if (tokenFromUrl) {
      bearerToken = `Bearer ${tokenFromUrl}`;
      console.log("✅ access_token de URL:", truncateToken(bearerToken));
    } else if (page.url().includes("pymes.andreani.com")) {
      const stored = await tryReadTokenFromStorage(page);
      if (stored) {
        bearerToken = `Bearer ${stored}`;
        console.log("✅ Token desde storage:", truncateToken(bearerToken));
      } else {
        console.warn("⚠️ No encontré token en URL ni en storage.");
      }
    }

    // Si tu flujo de “hacer envío → paquetes” ahora vive en pymes.andreani.com,
    // ajustá los selectores. Abajo uso los que ya venías usando:

    // Hacer envío
    await page.waitForSelector("#hacer_envio", {
      visible: true,
      timeout: 20000,
    });
    await page.click("#hacer_envio");

    // Card "Paquetes – Hasta 50 kg"
    await page.waitForFunction(
      () => {
        const cards = document.querySelectorAll("div.MuiCard-root");
        return [...cards].some(
          (card) =>
            card.innerText.includes("Paquetes") &&
            card.innerText.includes("Hasta 50 kg")
        );
      },
      { timeout: 15000 }
    );
    await page.evaluate(() => {
      const cards = document.querySelectorAll("div.MuiCard-root");
      for (const el of cards) {
        if (
          el.innerText.includes("Paquetes") &&
          el.innerText.includes("Hasta 50 kg")
        ) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.click();
          break;
        }
      }
    });

    // ORIGEN
    console.log("🟠 Esperando sucursal origen preseleccionada...");
    await page.waitForFunction(() =>
      document.querySelector(
        '[data-testid="branch-card"][data-selected="true"]'
      )
    );
    await page.waitForSelector("#OriginBranchOffice-siguiente--paquetes", {
      visible: true,
    });
    await page.click("#OriginBranchOffice-siguiente--paquetes");

    // CARGA MANUAL
    await page.waitForSelector("#carga_manual--paquetes", { visible: true });
    await page.click("#carga_manual--paquetes");
    await page.waitForSelector("#DataUpload-siguiente--paquetes", {
      visible: true,
    });
    await page.click("#DataUpload-siguiente--paquetes");

    // FORMULARIO PAQUETE
    await page.waitForSelector("#input_alto", { visible: true });
    await page.type("#input_alto", "1");
    await page.type("#input_ancho", "1");
    await page.type("#input_largo", "1");
    await page.type("#input_peso", "1");
    await page.type("#input_valorDeclarado", "10000");
    await page.waitForSelector("#PackageDescription-siguiente--paquetes", {
      visible: true,
    });
    await page.click("#PackageDescription-siguiente--paquetes");

    // CÓDIGO POSTAL DESTINO
    console.log("📮 Ingresando CP...");
    await page.waitForSelector('input[placeholder="Ej: 1824, Lanús Oeste"]', {
      visible: true,
    });
    const input = await page.$('input[placeholder="Ej: 1824, Lanús Oeste"]');
    await input.click({ clickCount: 3 });
    await input.press("Backspace");
    await input.type(String(cp), { delay: 80 });

    // Seleccionar primera opción
    await page.waitForFunction(() => {
      const items = document.querySelectorAll("li[role='option']");
      return items.length > 0;
    });
    await page.evaluate(() => {
      const first = document.querySelector("li[role='option']");
      if (first) first.click();
    });

    await page.waitForSelector("#PostalCode-siguiente--paquetes", {
      visible: true,
    });
    await page.click("#PostalCode-siguiente--paquetes");

    // OPCIÓN "A SUCURSAL"
    console.log("🏁 Seleccionando 'A sucursal'...");
    await page.waitForSelector('[data-testid="sucursal"]', { visible: true });
    await page.evaluate(() => {
      const sucursalDiv = document.querySelector('[data-testid="sucursal"]');
      if (sucursalDiv) sucursalDiv.click();
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    await page.waitForSelector("#DeliveryMethod-siguiente--paquetes", {
      visible: true,
    });
    await page.click("#DeliveryMethod-siguiente--paquetes");

    // Esperar a que dispare la request de sucursales destino
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (!ubicacionesPath) {
      await page.screenshot({ path: "error-no-ubicaciones.png" });
      throw new Error("❌ No se capturó la URL de destino (ubicacionesPath)");
    }

    return {
      bearerToken,
      ubicacionesPath,
    };
  } catch (error) {
    console.error("❌ Error:", error);
    if (page) await page.screenshot({ path: "error.png" });
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/* ======================
   Endpoints HTTP
   ====================== */

app.post("/get-andreani-token", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email y contraseña son requeridos",
      });
    }

    console.log("🔵 Iniciando proceso /get-andreani-token...");
    const token = await getAndreaniToken(email, password);

    res.json({
      success: true,
      token: token,
      message: "Token capturado exitosamente",
    });
  } catch (error) {
    console.error("❌ Error en el endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Error al obtener el token de Andreani",
    });
  }
});

app.post("/get-sucursal-id", async (req, res) => {
  try {
    const { email, password, cp } = req.body;

    if (!email || !password || !cp) {
      return res.status(400).json({
        success: false,
        error: "Email, contraseña y CP son requeridos",
      });
    }

    console.log("🔵 Iniciando proceso /get-sucursal-id...");
    const id = await getSucursalId(email, password, cp);

    res.json({
      success: true,
      id: id,
      message: "id capturado exitosamente",
    });
  } catch (error) {
    console.error("❌ Error en el endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Error al obtener el id de sucursal",
    });
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
});
