// index.js
const puppeteer = require("puppeteer-core");
require("dotenv").config();
const express = require("express");

const app = express();
const port = process.env.PORT || 8080;
const isProduction = process.env.NODE_ENV === 'production';
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
  // Usar variables de entorno como fallback si no se proporcionan
  const finalEmail = email || process.env.ANDREANI_EMAIL;
  const finalPassword = password || process.env.ANDREANI_PASSWORD;

  if (!finalEmail || !finalPassword) {
    throw new Error(
      "Email y contraseña son requeridos (vía parámetros o variables de entorno ANDREANI_EMAIL y ANDREANI_PASSWORD)"
    );
  }

  let browser;
  let page;

  try {
    browser = await puppeteer.launch({
      headless: false, // 👈 Cambiado para mostrar navegador
      defaultViewport: {
        width: 1920,
        height: 1080
      },
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox",
        "--window-size=1920,1080"
      ],
      // Usar executablePath si está definido (Docker) o si estamos en producción
      ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }),
    });

    page = await browser.newPage();
    
    // Configurar viewport de la página
    await page.setViewport({
      width: 1920,
      height: 1080
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
    await page.type("#signInName", finalEmail, { delay: 60 });
    await page.type("#password", finalPassword, { delay: 60 });
    await page.click("#next");

    console.log("🟠 Esperando navegación post-login...");
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
      .catch(() => {});

    console.log("📍 URL actual después del login:", page.url());
    console.log("⏳ Pausa de 3 segundos para observar la página...");
    await new Promise((r) => setTimeout(r, 3000));

    // Hacer click en el botón "Hacer envío"
    console.log("🎯 Buscando botón 'Hacer envío'...");
    await page.waitForSelector("#hacer_envio", {
      visible: true,
      timeout: 20000,
    });
    console.log("✅ Encontré el botón 'Hacer envío', haciendo click...");
    await page.click("#hacer_envio");

    console.log("⏳ Pausa de 5 segundos después del click en 'Hacer envío'...");
    await new Promise((r) => setTimeout(r, 5000));

    console.log("✅ Click en 'Hacer envío' completado exitosamente");

    return {
      success: true,
      message: "Click en botón 'Hacer envío' realizado exitosamente",
      url: page.url(),
    };
  } catch (error) {
    console.error("❌ Error durante el proceso:", error);
    if (browser && page) {
      await page.screenshot({ path: "./screenshots/error-screenshot.png" });
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
  // Usar variables de entorno como fallback si no se proporcionan
  const finalEmail = email || process.env.ANDREANI_EMAIL;
  const finalPassword = password || process.env.ANDREANI_PASSWORD;

  if (!finalEmail || !finalPassword || !cp) {
    throw new Error(
      "Email, contraseña y CP son requeridos (email/password vía parámetros o variables de entorno ANDREANI_EMAIL y ANDREANI_PASSWORD)"
    );
  }

  let browser;
  let page;
  let ubicacionesPath = null;

  try {
    browser = await puppeteer.launch({
      headless: false, // 👈 visible
      defaultViewport: {
        width: 1920,
        height: 1080
      },
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox",
        "--window-size=1920,1080"
      ],
      // Usar executablePath si está definido (Docker) o si estamos en producción
      ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }),
    });

    page = await browser.newPage();
    
    // Configurar viewport de la página
    await page.setViewport({
      width: 1920,
      height: 1080
    });

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();

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
    await page.type("#signInName", finalEmail, { delay: 50 });
    await page.type("#password", finalPassword, { delay: 50 });
    await page.click("#next");
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
      .catch(() => {});

    console.log("📍 URL actual después del login:", page.url());

    // Redirigir directamente a /hacer-envio
    console.log("🔄 Redirigiendo directamente a /hacer-envio...");
    await page.goto("https://pymes.andreani.com/hacer-envio", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    console.log("⏳ Pausa de 3 segundos después de llegar a hacer-envio...");
    await new Promise((r) => setTimeout(r, 3000));

    // Hacer envío
    console.log("🎯 Buscando botón 'Hacer envío'...");
    await page.waitForSelector("#hacer_envio", {
      visible: true,
      timeout: 20000,
    });
    console.log("✅ Encontré el botón 'Hacer envío', haciendo click...");
    await page.click("#hacer_envio");

    console.log("⏳ Pausa de 2 segundos después del click en 'Hacer envío'...");
    await new Promise((r) => setTimeout(r, 2000));

    // Card "Paquetes – Hasta 50 kg"
    console.log("🎯 Buscando card de 'Paquetes - Hasta 50 kg'...");
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
    console.log("✅ Encontré la card de Paquetes, haciendo click...");
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

    console.log("⏳ Pausa de 2 segundos después del click en card Paquetes...");
    await new Promise((r) => setTimeout(r, 2000));

    // ORIGEN
    console.log("🟠 Esperando sucursal origen preseleccionada...");
    await page.waitForFunction(() =>
      document.querySelector(
        '[data-testid="branch-card"][data-selected="true"]'
      )
    );
    console.log("✅ Sucursal origen preseleccionada encontrada");
    await page.waitForSelector("#OriginBranchOffice-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de origen...");
    await page.click("#OriginBranchOffice-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de seleccionar origen...");
    await new Promise((r) => setTimeout(r, 2000));

    // CARGA MANUAL
    console.log("🎯 Buscando opción 'Carga manual'...");
    await page.waitForSelector("#carga_manual--paquetes", { visible: true });
    console.log("✅ Haciendo click en 'Carga manual'...");
    await page.click("#carga_manual--paquetes");

    console.log("⏳ Pausa de 2 segundos después de carga manual...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.waitForSelector("#DataUpload-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de carga de datos...");
    await page.click("#DataUpload-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de siguiente en carga...");
    await new Promise((r) => setTimeout(r, 2000));

    // FORMULARIO PAQUETE
    console.log("📦 Completando formulario de paquete...");
    await page.waitForSelector("#input_alto", { visible: true });
    console.log("✏️ Escribiendo dimensiones y peso...");
    await page.type("#input_alto", "1", { delay: 100 });
    await page.type("#input_ancho", "1", { delay: 100 });
    await page.type("#input_largo", "1", { delay: 100 });
    await page.type("#input_peso", "1", { delay: 100 });
    await page.type("#input_valorDeclarado", "10000", { delay: 100 });

    console.log("⏳ Pausa de 2 segundos después de completar formulario...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.waitForSelector("#PackageDescription-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' del formulario paquete...");
    await page.click("#PackageDescription-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de siguiente en paquete...");
    await new Promise((r) => setTimeout(r, 2000));

    // CÓDIGO POSTAL DESTINO
    console.log("📮 Ingresando CP:", cp);
    await page.waitForSelector('input[placeholder="Ej: 1824, Lanús Oeste"]', {
      visible: true,
    });
    const input = await page.$('input[placeholder="Ej: 1824, Lanús Oeste"]');
    console.log("✏️ Limpiando campo de CP...");
    await input.click({ clickCount: 3 });
    await input.press("Backspace");
    console.log("✏️ Escribiendo CP:", cp);
    await input.type(String(cp), { delay: 150 });

    console.log("⏳ Esperando opciones de CP...");
    // Seleccionar primera opción
    await page.waitForFunction(() => {
      const items = document.querySelectorAll("li[role='option']");
      return items.length > 0;
    });
    console.log("✅ Seleccionando primera opción de CP...");
    await page.evaluate(() => {
      const first = document.querySelector("li[role='option']");
      if (first) first.click();
    });

    console.log("⏳ Pausa de 2 segundos después de seleccionar CP...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.waitForSelector("#PostalCode-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de CP...");
    await page.click("#PostalCode-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de siguiente en CP...");
    await new Promise((r) => setTimeout(r, 2000));

    // OPCIÓN "A SUCURSAL"
    console.log("🏁 Seleccionando 'A sucursal'...");
    await page.waitForSelector('[data-testid="sucursal"]', { visible: true });
    console.log("✅ Encontré opción 'A sucursal', haciendo click...");
    await page.evaluate(() => {
      const sucursalDiv = document.querySelector('[data-testid="sucursal"]');
      if (sucursalDiv) sucursalDiv.click();
    });

    console.log(
      "⏳ Pausa de 2 segundos después de seleccionar 'A sucursal'..."
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await page.waitForSelector("#DeliveryMethod-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de método de entrega...");
    await page.click("#DeliveryMethod-siguiente--paquetes");

    // Esperar a que dispare la request de sucursales destino
    console.log(
      "⏳ Esperando 5 segundos para que se carguen las sucursales..."
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));

    if (!ubicacionesPath) {
      await page.screenshot({ path: "./screenshots/error-no-ubicaciones.png" });
      throw new Error("❌ No se capturó la URL de destino (ubicacionesPath)");
    }

    return {
      ubicacionesPath,
    };
  } catch (error) {
    console.error("❌ Error:", error);
    if (page) await page.screenshot({ path: "./screenshots/error.png" });
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/* ================================================
   hacerEnvio: login + click en botón hacer envío
   ================================================ */

async function hacerEnvio(email, password) {
  // Usar variables de entorno como fallback si no se proporcionan
  const finalEmail = email || process.env.ANDREANI_EMAIL;
  const finalPassword = password || process.env.ANDREANI_PASSWORD;

  if (!finalEmail || !finalPassword) {
    throw new Error(
      "Email y contraseña son requeridos (vía parámetros o variables de entorno ANDREANI_EMAIL y ANDREANI_PASSWORD)"
    );
  }

  let browser;
  let page;
  let authToken = null;

  try {
    // Crear directorio de screenshots si no existe
    const fs = require('fs');
    const screenshotsDir = '/app/screenshots';
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      console.log("📁 Directorio de screenshots creado");
    }
    
    console.log("🔍 Iniciando Puppeteer con configuración Docker...");
    console.log("🔍 CHROMIUM_PATH:", process.env.CHROMIUM_PATH);
    console.log("🔍 Production mode:", isProduction);
    
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: {
        width: 1920,
        height: 1080
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI,VizDisplayCompositor",
        "--disable-ipc-flooding-protection",
        "--no-first-run",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-translate",
        "--hide-scrollbars",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-zygote",
        "--window-size=1920,1080",
        // Argumentos adicionales para solucionar problemas en contenedor
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-features=AudioServiceOutOfProcess",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-notifications",
        "--disable-offer-store-unmasked-wallet-cards",
        "--disable-popup-blocking",
        "--disable-print-preview",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-speech-api",
        "--disable-sync",
        "--hide-scrollbars",
        "--ignore-gpu-blacklist",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-pings",
        "--no-zygote",
        "--password-store=basic",
        "--use-gl=swiftshader",
        "--use-mock-keychain",
        "--single-process",
        "--disable-dbus",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor"
      ],
      // Usar executablePath si está definido (Docker) o si estamos en producción
      ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }),
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    
    console.log("✅ Puppeteer browser launched successfully");

    page = await browser.newPage();
    console.log("✅ New page created successfully");
    
    // Configurar viewport de la página
    await page.setViewport({
      width: 1920,
      height: 1080
    });
    console.log("✅ Viewport configured to 1920x1080");
    
    // Configurar User-Agent realista
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log("✅ User-Agent configured");
    
    // Configurar headers adicionales
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });
    console.log("✅ HTTP headers configured");
    
    // Configurar geolocalización simulada (Buenos Aires, Argentina)
    await page.setGeolocation({
      latitude: -34.6118,  // Buenos Aires
      longitude: -58.3960, // Buenos Aires
      accuracy: 100
    });
    console.log("✅ Geolocation set to Buenos Aires, Argentina");
    
    // Otorgar permisos de geolocalización
    const context = browser.defaultBrowserContext();
    await context.overridePermissions('https://pymes.andreani.com', ['geolocation']);
    console.log("✅ Geolocation permissions granted");

    // Interceptar requests para capturar el token de autorización Y debugging de red
    await page.setRequestInterception(true);
    let responseData = null;
    
    // Debug: Interceptar TODAS las requests para ver qué falla
    const failedRequests = [];
    const successfulRequests = [];

    page.on("request", (request) => {
      const url = request.url();
      
      // Debug: Log de TODAS las requests (filtrar solo las importantes)
      if (url.includes('pymes-api.andreani.com') || 
          url.includes('sucursal') || 
          url.includes('Sucursal') || 
          url.includes('branch') || 
          url.includes('ubicacion') || 
          url.includes('location') ||
          url.includes('Step/by-stepper') ||
          url.includes('maps') ||
          url.includes('geolocation') ||
          url.includes('GetUbicaciones')) {
        console.log("🌐 REQUEST:", {
          method: request.method(),
          url: url,
          headers: {
            authorization: request.headers().authorization ? request.headers().authorization.substring(0, 30) + '...' : 'none',
            'accept': request.headers().accept,
            'content-type': request.headers()['content-type']
          }
        });
      }

      if (
        url.includes("https://pymes-api.andreani.com/api/v1/Envios") &&
        request.method() === "POST"
      ) {
        const headers = request.headers();
        if (
          headers.authorization &&
          headers.authorization.startsWith("Bearer ")
        ) {
          authToken = headers.authorization; // Mantener el "Bearer " en el token
          console.log(
            "🎯 Token capturado:",
            authToken.substring(0, 27) + "..."
          );
        }
      }

      request.continue();
    });
    
    // Debug: Interceptar responses
    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();
      
      if (url.includes('pymes-api.andreani.com') || 
          url.includes('sucursal') || 
          url.includes('Sucursal') || 
          url.includes('branch') || 
          url.includes('ubicacion') || 
          url.includes('location') ||
          url.includes('Step/by-stepper') ||
          url.includes('maps') ||
          url.includes('geolocation') ||
          url.includes('GetUbicaciones')) {
        
        let responseBody = '';
        try {
          if (status >= 200 && status < 300 && response.headers()['content-type']?.includes('application/json')) {
            responseBody = await response.text();
            responseBody = responseBody.substring(0, 200) + (responseBody.length > 200 ? '...' : '');
          }
        } catch (e) {
          responseBody = 'Error reading body';
        }
        
        console.log("📡 RESPONSE:", {
          url: url,
          status: status,
          statusText: response.statusText(),
          contentType: response.headers()['content-type'],
          body: responseBody
        });
        
        if (status >= 200 && status < 300) {
          successfulRequests.push({ url, status, body: responseBody });
        } else {
          failedRequests.push({ url, status, statusText: response.statusText() });
        }
      }
    });
    
    // Debug: Interceptar requests fallidos
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (url.includes('sucursal') || url.includes('Sucursal') || url.includes('branch') || url.includes('ubicacion') || url.includes('location')) {
        console.log("❌ REQUEST FAILED:", {
          url: url.substring(0, 100) + (url.length > 100 ? '...' : ''),
          failure: request.failure()
        });
        failedRequests.push({ url, error: request.failure() });
      }
    });

    // Interceptar respuestas para capturar pedidoId y envioId usando CDPSession
    const client = await page.target().createCDPSession();
    await client.send("Network.enable");

    client.on("Network.responseReceived", async (params) => {
      const url = params.response.url;
      if (
        url.includes("https://pymes-api.andreani.com/api/v1/Envios") &&
        params.response.status >= 200 &&
        params.response.status < 300
      ) {
        try {
          const responseBody = await client.send("Network.getResponseBody", {
            requestId: params.requestId,
          });

          if (responseBody.body) {
            const decodedBody = responseBody.base64Encoded
              ? Buffer.from(responseBody.body, "base64").toString("utf-8")
              : responseBody.body;

            responseData = JSON.parse(decodedBody);
            console.log("🎯 Respuesta del POST capturada:", responseData);
          }
        } catch (error) {
          console.log("⚠️ Error al capturar respuesta del POST:", error);
        }
      }
    });

    // Test de conectividad previo
    console.log("🌐 Probando conectividad de red...");
    try {
      const testResponse = await page.goto("https://httpbin.org/status/200", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      console.log("✅ Conectividad de red OK, status:", testResponse.status());
    } catch (error) {
      console.log("⚠️ Problema de conectividad de red:", error.message);
      console.log("🔄 Continuando con el intento principal...");
    }
    
    console.log("🔵 Navegando al login...");
    
    // Estrategia de navegación más robusta con múltiples intentos
    let navegacionExitosa = false;
    let intentosNavegacion = 0;
    const maxIntentosNavegacion = 3;
    
    while (!navegacionExitosa && intentosNavegacion < maxIntentosNavegacion) {
      try {
        intentosNavegacion++;
        console.log(`🔍 Intento de navegación ${intentosNavegacion} de ${maxIntentosNavegacion}...`);
        
        await page.goto("https://onboarding.andreani.com/", {
          waitUntil: ["domcontentloaded", "networkidle0"], // Múltiples condiciones
          timeout: 45000, // Timeout más largo para primera carga
        });
        
        // Verificar que la página se cargó correctamente
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
        
        navegacionExitosa = true;
        console.log("✅ Navegación exitosa!");
        
        // 📸 CAPTURA 1: Después de navegación exitosa
        console.log("📸 Capturando screenshot después de navegación exitosa...");
        await page.screenshot({ 
          path: `/app/screenshots/paso-1-navegacion-exitosa-intento-${intentosNavegacion}.png`, 
          fullPage: true 
        });
        
      } catch (error) {
        console.log(`⚠️ Intento ${intentosNavegacion} falló:`, error.message);
        
        // 📸 CAPTURA: Error de navegación
        console.log(`📸 Capturando screenshot de error de navegación intento ${intentosNavegacion}...`);
        try {
          await page.screenshot({ 
            path: `/app/screenshots/error-navegacion-intento-${intentosNavegacion}.png`, 
            fullPage: true 
          });
        } catch (screenshotError) {
          console.log("⚠️ No se pudo tomar screenshot del error:", screenshotError.message);
        }
        
        if (intentosNavegacion < maxIntentosNavegacion) {
          console.log("🔄 Esperando antes del siguiente intento...");
          await new Promise(r => setTimeout(r, 5000));
        } else {
          console.log("❌ Todos los intentos de navegación fallaron");
          throw error;
        }
      }
    }

    console.log("🔵 Completando login...");
    
    // 📸 CAPTURA 2: Antes de buscar #signInName
    console.log("📸 Capturando screenshot antes de buscar selector #signInName...");
    await page.screenshot({ 
      path: '/app/screenshots/paso-2-antes-buscar-signInName.png', 
      fullPage: true 
    });
    
    // 🔍 ANÁLISIS: Verificar qué elementos están disponibles
    console.log("🔍 Analizando elementos disponibles en la página...");
    const analisisDOM = await page.evaluate(() => {
      const resultado = {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        todosLosInputs: [],
        posiblesLogins: []
      };
      
      // Buscar todos los inputs
      const inputs = document.querySelectorAll('input');
      inputs.forEach((input, index) => {
        const rect = input.getBoundingClientRect();
        resultado.todosLosInputs.push({
          index,
          id: input.id,
          name: input.name,
          type: input.type,
          placeholder: input.placeholder,
          className: input.className,
          visible: rect.width > 0 && rect.height > 0,
          value: input.value
        });
      });
      
      // Buscar específicamente signInName
      const signInNameInput = document.querySelector('#signInName');
      resultado.signInNameEncontrado = signInNameInput ? {
        existe: true,
        visible: signInNameInput.offsetParent !== null,
        disabled: signInNameInput.disabled,
        value: signInNameInput.value,
        placeholder: signInNameInput.placeholder
      } : { existe: false };
      
      // Buscar formularios
      const forms = document.querySelectorAll('form');
      forms.forEach((form, index) => {
        resultado.posiblesLogins.push({
          index,
          id: form.id,
          className: form.className,
          inputs: Array.from(form.querySelectorAll('input')).map(inp => ({
            id: inp.id,
            name: inp.name,
            type: inp.type,
            placeholder: inp.placeholder
          }))
        });
      });
      
      return resultado;
    });
    
    console.log("🔍 ANÁLISIS COMPLETO DEL DOM:", JSON.stringify(analisisDOM, null, 2));
    
    // Intentar múltiples estrategias para encontrar el campo de login
    let loginExitoso = false;
    let selectorEmailUsado = "#signInName";
    let selectorPasswordUsado = "#password";
    let selectorBotonUsado = "#next";
    
    if (analisisDOM.signInNameEncontrado.existe) {
      console.log("✅ Elemento #signInName encontrado, procediendo con login normal...");
      try {
        await page.waitForSelector("#signInName", {
          visible: true,
          timeout: 20000, // Timeout más largo para login
        });
        loginExitoso = true;
      } catch (error) {
        console.log("⚠️ Error esperando #signInName:", error.message);
      }
    }
    
    if (!loginExitoso) {
      console.log("🔄 Intentando estrategias alternativas para encontrar campos de login...");
      
      // 📸 CAPTURA 3: Estado cuando no se encuentra signInName
      console.log("📸 Capturando screenshot cuando no se encuentra #signInName...");
      await page.screenshot({ 
        path: '/app/screenshots/paso-3-signInName-no-encontrado.png', 
        fullPage: true 
      });
      
      // Estrategia: Buscar por tipo de input
      const estrategias = [
        { email: 'input[type="email"]', password: 'input[type="password"]' },
        { email: 'input[name*="email"]', password: 'input[name*="password"]' },
        { email: 'input[name*="username"]', password: 'input[name*="password"]' }
      ];
      
      for (const estrategia of estrategias) {
        try {
          console.log(`🔍 Probando estrategia: email=${estrategia.email}`);
          
          const elementoEmail = await page.$(estrategia.email);
          const elementoPassword = await page.$(estrategia.password);
          
          if (elementoEmail && elementoPassword) {
            const sonVisibles = await page.evaluate((selEmail, selPassword) => {
              const email = document.querySelector(selEmail);
              const password = document.querySelector(selPassword);
              if (!email || !password) return false;
              
              const rectEmail = email.getBoundingClientRect();
              const rectPassword = password.getBoundingClientRect();
              return rectEmail.width > 0 && rectEmail.height > 0 && 
                     rectPassword.width > 0 && rectPassword.height > 0;
            }, estrategia.email, estrategia.password);
            
            if (sonVisibles) {
              selectorEmailUsado = estrategia.email;
              selectorPasswordUsado = estrategia.password;
              
              // Buscar botón
              const posiblesButtons = ['button[type="submit"]', 'input[type="submit"]', 'button'];
              for (const btnSelector of posiblesButtons) {
                try {
                  const boton = await page.$(btnSelector);
                  if (boton) {
                    selectorBotonUsado = btnSelector;
                    break;
                  }
                } catch (btnError) {
                  continue;
                }
              }
              
              // 📸 CAPTURA 4: Elementos alternativos encontrados
              console.log("📸 Capturando screenshot con elementos alternativos...");
              await page.screenshot({ 
                path: '/app/screenshots/paso-4-elementos-alternativos.png', 
                fullPage: true 
              });
              
              await page.waitForSelector(estrategia.email, { visible: true, timeout: 10000 });
              loginExitoso = true;
              console.log(`🔄 Usando selectores: email=${selectorEmailUsado}, password=${selectorPasswordUsado}`);
              break;
            }
          }
        } catch (error) {
          console.log(`⚠️ Error con estrategia:`, error.message);
          continue;
        }
      }
    }
    
    if (!loginExitoso) {
      // 📸 CAPTURA 5: Error final
      console.log("📸 Capturando screenshot final - no se encontró login...");
      await page.screenshot({ 
        path: '/app/screenshots/paso-5-error-final-no-login.png', 
        fullPage: true 
      });
      
      throw new Error("No se pudo encontrar ningún campo de login en la página");
    }
    
    // Proceder con el login
    console.log(`✅ Usando selectores: email=${selectorEmailUsado}, password=${selectorPasswordUsado}, boton=${selectorBotonUsado}`);
    
    // 📸 CAPTURA 6: Antes de escribir credenciales
    console.log("📸 Capturando screenshot antes de escribir credenciales...");
    await page.screenshot({ 
      path: '/app/screenshots/paso-6-antes-credenciales.png', 
      fullPage: true 
    });
    
    await page.type(selectorEmailUsado, finalEmail, { delay: 60 });
    await page.type(selectorPasswordUsado, finalPassword, { delay: 60 });
    
    // 📸 CAPTURA 7: Después de escribir credenciales
    console.log("📸 Capturando screenshot después de escribir credenciales...");
    await page.screenshot({ 
      path: '/app/screenshots/paso-7-despues-credenciales.png', 
      fullPage: true 
    });
    
    await page.click(selectorBotonUsado);

    console.log("🟠 Esperando navegación post-login...");
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
      .catch(() => {});

    console.log("📍 URL actual después del login:", page.url());
    
    // 📸 CAPTURA 8: Después del login exitoso
    console.log("📸 Capturando screenshot después del login...");
    await page.screenshot({ 
      path: '/app/screenshots/paso-8-despues-login.png', 
      fullPage: true 
    });

    // Esperar más tiempo para que la página cargue completamente
    console.log("⏳ Esperando que la página principal cargue completamente...");
    await new Promise((r) => setTimeout(r, 5000));

    // Esperar a que el DOM esté completamente listo
    await page
      .waitForFunction(() => document.readyState === "complete", {
        timeout: 10000,
      })
      .catch(() => {
        console.log(
          "⚠️ No se pudo confirmar que la página esté completamente cargada"
        );
      });

    // Hacer click en el botón "Hacer envío"
    console.log("🎯 Buscando botón 'Hacer envío'...");
    
    // 📸 CAPTURA 9: Antes de buscar botón hacer envío
    console.log("📸 Capturando screenshot antes de buscar botón 'Hacer envío'...");
    await page.screenshot({ 
      path: '/app/screenshots/paso-9-antes-buscar-hacer-envio.png', 
      fullPage: true 
    });

    // Esperar a que el botón sea visible y esté habilitado
    await page.waitForSelector("#hacer_envio", {
      visible: true,
      timeout: 30000,
    });

    // Verificar que el botón esté realmente disponible para click
    await page.waitForFunction(
      () => {
        const btn = document.querySelector("#hacer_envio");
        return btn && !btn.disabled && btn.offsetParent !== null;
      },
      { timeout: 10000 }
    );

    console.log("⏳ Pausa adicional antes del click...");
    await new Promise((r) => setTimeout(r, 2000));
    console.log("✅ Encontré el botón 'Hacer envío', haciendo click...");
    
    // 📸 CAPTURA 10: Antes del click en hacer envío
    console.log("📸 Capturando screenshot antes del click en 'Hacer envío'...");
    await page.screenshot({ 
      path: '/app/screenshots/paso-10-antes-click-hacer-envio.png', 
      fullPage: true 
    });
    
    await page.click("#hacer_envio");

    console.log("⏳ Esperando que la página se actualice después del click...");
    // Esperar a que la página navegue o se actualice completamente
    await new Promise((r) => setTimeout(r, 3000));
    
    // 📸 CAPTURA 11: Después del click en hacer envío
    console.log("📸 Capturando screenshot después del click en 'Hacer envío'...");
    await page.screenshot({ 
      path: '/app/screenshots/paso-11-despues-click-hacer-envio.png', 
      fullPage: true 
    });

    // Intentar esperar a que la página esté cargada
    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 5000,
      });
      console.log("✅ Navegación detectada");
    } catch {
      console.log("⚠️ No se detectó navegación, continuando...");
    }

    console.log("📍 URL actual después de 'Hacer envío':", page.url());

    // Click en #servicio--paquetes
    console.log("🎯 Buscando botón 'servicio--paquetes'...");
    await page.waitForSelector("#servicio--paquetes", {
      visible: true,
      timeout: 20000,
    });

    // Verificar que el botón esté disponible para click
    await page.waitForFunction(
      () => {
        const btn = document.querySelector("#servicio--paquetes");
        return btn && !btn.disabled && btn.offsetParent !== null;
      },
      { timeout: 10000 }
    );

    console.log("✅ Encontré el botón 'servicio--paquetes', haciendo click...");
    await page.click("#servicio--paquetes");

    console.log(
      "⏳ Pausa de 2 segundos después del click en servicio--paquetes..."
    );
    await new Promise((r) => setTimeout(r, 2000));

    // Card "Paquetes – Hasta 50 kg"
    console.log("🎯 Buscando card de 'Paquetes - Hasta 50 kg'...");

    // Primero esperamos a que aparezcan las cards en general
    await page.waitForSelector("div.MuiCard-root", {
      visible: true,
      timeout: 15000,
    });

    // Luego esperamos específicamente por la card de Paquetes
    await page.waitForFunction(
      () => {
        const cards = document.querySelectorAll("div.MuiCard-root");
        return [...cards].some(
          (card) =>
            card.innerText.includes("Paquetes") &&
            card.innerText.includes("Hasta 50 kg")
        );
      },
      { timeout: 10000 }
    );

    console.log("✅ Encontré la card de Paquetes, haciendo click...");

    // Scroll primero y luego click
    await page.evaluate(() => {
      const cards = document.querySelectorAll("div.MuiCard-root");
      for (const el of cards) {
        if (
          el.innerText.includes("Paquetes") &&
          el.innerText.includes("Hasta 50 kg")
        ) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return true;
        }
      }
      return false;
    });

    // Esperar un poco para que termine el scroll
    await new Promise((r) => setTimeout(r, 1000));

    // Ahora hacer el click
    await page.evaluate(() => {
      const cards = document.querySelectorAll("div.MuiCard-root");
      for (const el of cards) {
        if (
          el.innerText.includes("Paquetes") &&
          el.innerText.includes("Hasta 50 kg")
        ) {
          el.click();
          return true;
        }
      }
      return false;
    });

    console.log("⏳ Pausa de 3 segundos después del click en card Paquetes...");
    console.log("🔍 Monitoreando requests después del click en Paquetes...");
    
    // Reset de contadores para esta fase
    failedRequests.length = 0;
    successfulRequests.length = 0;
    
    await new Promise((r) => setTimeout(r, 3000));
    
    // Capturar screenshot después del click en Paquetes
    console.log("📸 Capturando screenshot después del click en Paquetes...");
    await page.screenshot({ 
      path: '/app/screenshots/despues-click-paquetes.png', 
      fullPage: true 
    });
    
    // Log de requests hasta este momento
    console.log("📊 REQUESTS DESPUÉS DEL CLICK EN PAQUETES:");
    console.log("✅ Exitosas:", successfulRequests.length);
    console.log("❌ Fallidas:", failedRequests.length);
    if (successfulRequests.length > 0) {
      console.log("🟢 REQUESTS EXITOSAS:", JSON.stringify(successfulRequests.slice(-3), null, 2));
    }
    if (failedRequests.length > 0) {
      console.log("🔴 REQUESTS FALLIDAS:", JSON.stringify(failedRequests.slice(-3), null, 2));
    }

    // ORIGEN - Esperar carga completa ANTES de escribir dirección
    console.log("⏳ Esperando carga completa de la página...");
    
    // Paso 1: Esperar a que aparezca el mapa
    console.log("🗺️ Esperando carga del mapa...");
    try {
      await page.waitForSelector('.leaflet-container, [class*="map"], [class*="Map"]', {
        visible: true,
        timeout: 30000
      });
      console.log("✅ Mapa cargado");
    } catch (error) {
      console.log("⚠️ No se detectó mapa específico, continuando...");
    }
    
    // Paso 2: Esperar requests de geolocalización y sucursales
    console.log("📍 Esperando carga inicial de sucursales cercanas...");
    await new Promise((r) => setTimeout(r, 5000)); // Dar tiempo para requests de geolocalización
    
    // Paso 3: Verificar si ya hay sucursales cargadas automáticamente
    const sucursalesIniciales = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="branch-card"]');
      return {
        cantidad: cards.length,
        haySeleccionada: !!document.querySelector('[data-testid="branch-card"][data-selected="true"]')
      };
    });
    
    console.log("🏪 Sucursales iniciales detectadas:", JSON.stringify(sucursalesIniciales, null, 2));
    
    // Capturar screenshot después de la carga inicial
    console.log("📸 Capturando screenshot después de carga inicial...");
    await page.screenshot({ 
      path: '/app/screenshots/despues-carga-inicial.png', 
      fullPage: true 
    });
    
    // Log de requests hasta este momento
    console.log("📊 REQUESTS DESPUÉS DE CARGA INICIAL:");
    console.log("✅ Exitosas:", successfulRequests.length);
    console.log("❌ Fallidas:", failedRequests.length);
    if (successfulRequests.length > 0) {
      console.log("🟢 ÚLTIMAS REQUESTS:", JSON.stringify(successfulRequests.slice(-3), null, 2));
    }
    
    if (sucursalesIniciales.cantidad > 0 && sucursalesIniciales.haySeleccionada) {
      console.log("🎯 Ya hay una sucursal preseleccionada automáticamente, saltando escritura de dirección");
      // Si ya hay sucursales y una está seleccionada, no necesitamos escribir dirección
    } else {
      console.log("📍 Escribiendo dirección de origen...");
      
      // Buscar y completar el campo de dirección de origen
      await page.waitForSelector('.MuiInputBase-input', {
        visible: true,
        timeout: 50000
      });
    
    console.log("✅ Campo de dirección encontrado, analizando inputs disponibles...");
    
    // Primero analizar qué inputs hay disponibles
    const inputsInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll('.MuiInputBase-input');
      const info = [];
      inputs.forEach((input, i) => {
        const rect = input.getBoundingClientRect();
        info.push({
          index: i,
          placeholder: input.placeholder || 'sin placeholder',
          value: input.value || 'vacío',
          visible: rect.width > 0 && rect.height > 0,
          disabled: input.disabled,
          type: input.type || 'text'
        });
      });
      return info;
    });
    
    console.log("📋 Inputs encontrados:", JSON.stringify(inputsInfo, null, 2));
    
    // Buscar específicamente el campo de dirección de origen
    let direccionEscrita = false;
    
    if (inputsInfo.length > 0) {
      // Intentar con el primer input visible
      const primerInput = inputsInfo.find(input => input.visible && !input.disabled);
      if (primerInput) {
        console.log(`📍 Intentando escribir en input ${primerInput.index}...`);
        
        try {
          // Método mejorado para Material-UI
          await page.click('.MuiInputBase-input');
          await page.keyboard.selectAll();
          await page.keyboard.type('Azcuénaga 1001, C1115AAE Ciudad de Buenos Aires, Argentina', { delay: 100 });
          
          direccionEscrita = true;
          console.log(`✅ Dirección escrita en input ${primerInput.index}`);
          
        } catch (error) {
          console.log(`⚠️ Error escribiendo en input ${primerInput.index}:`, error.message);
        }
      }
    }
    
    if (!direccionEscrita) {
      console.log("⚠️ No se pudo escribir con evaluate, intentando método click + type...");
      try {
        await page.click('.MuiInputBase-input');
        await page.keyboard.selectAll();
        await page.type('.MuiInputBase-input', 'Azcuénaga 1001, C1115AAE Ciudad de Buenos Aires, Argentina', { delay: 50 });
        direccionEscrita = true;
        console.log("✅ Dirección escrita con método alternativo");
      } catch (error) {
        console.log("❌ Error con método alternativo:", error.message);
      }
    }
    
    if (direccionEscrita) {
      console.log("⏳ Esperando a que aparezcan las opciones de dirección...");
      
      // Esperar a que aparezcan las opciones en el dropdown/lista
      try {
        await page.waitForSelector('.MuiAutocomplete-option, .MuiMenuItem-root, li[role="option"], [role="option"]', {
          visible: true,
          timeout: 10000
        });
        console.log("✅ Opciones de dirección aparecieron");
        
        // Capturar screenshot de las opciones
        console.log("📸 Capturando screenshot de las opciones...");
        await page.screenshot({ 
          path: '/app/screenshots/opciones-direccion.png', 
          fullPage: true 
        });
        
        // Analizar las opciones disponibles
        const opciones = await page.evaluate(() => {
          const selectores = [
            '.MuiAutocomplete-option',
            '.MuiMenuItem-root', 
            'li[role="option"]',
            '[role="option"]',
            '.MuiListbox-root li',
            '[data-option-index]'
          ];
          
          let opcionesEncontradas = [];
          
          for (const selector of selectores) {
            const elementos = document.querySelectorAll(selector);
            if (elementos.length > 0) {
              elementos.forEach((el, index) => {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  opcionesEncontradas.push({
                    selector,
                    index,
                    text: el.innerText ? el.innerText.trim() : '',
                    visible: true,
                    classes: el.className,
                    dataOptionIndex: el.getAttribute('data-option-index')
                  });
                }
              });
              
              if (opcionesEncontradas.length > 0) break;
            }
          }
          
          return opcionesEncontradas;
        });
        
        console.log("🏠 Opciones de dirección encontradas:", JSON.stringify(opciones.slice(0, 5), null, 2));
        
        if (opciones.length > 0) {
          console.log("👆 Haciendo click en la primera opción...");
          
          // Hacer click en la primera opción
          await page.evaluate((selector, index) => {
            const elementos = document.querySelectorAll(selector);
            if (elementos[index]) {
              elementos[index].click();
              return true;
            }
            return false;
          }, opciones[0].selector, opciones[0].index);
          
          console.log("✅ Click realizado en la primera opción");
          
          // Esperar un poco para que se procese la selección
          await new Promise((r) => setTimeout(r, 2000));
          
        } else {
          console.log("⚠️ No se encontraron opciones para seleccionar");
        }
        
      } catch (error) {
        console.log("⚠️ No aparecieron opciones de dirección:", error.message);
        console.log("🔄 Intentando presionar Enter para autocompletar...");
        
        try {
          await page.focus('.MuiInputBase-input');
          await page.keyboard.press('Enter');
          await new Promise((r) => setTimeout(r, 2000));
          console.log("✅ Enter presionado");
        } catch (enterError) {
          console.log("❌ Error presionando Enter:", enterError.message);
        }
      }
    }
    
    // Verificar que la dirección se escribió correctamente
    const verificacionDireccion = await page.evaluate(() => {
      const inputs = document.querySelectorAll('.MuiInputBase-input');
      const resultados = [];
      inputs.forEach((input, i) => {
        resultados.push({
          index: i,
          value: input.value,
          placeholder: input.placeholder || 'sin placeholder'
        });
      });
      return resultados;
    });
    
    console.log("🔍 Verificación después de escribir:", JSON.stringify(verificacionDireccion, null, 2));
    
    console.log("📸 Capturando screenshot después de escribir dirección...");
    await page.screenshot({ 
      path: '/app/screenshots/despues-escribir-direccion.png', 
      fullPage: true 
    });
    
    // Log de requests después de escribir dirección
    console.log("📊 REQUESTS DESPUÉS DE ESCRIBIR DIRECCIÓN:");
    console.log("✅ Exitosas:", successfulRequests.length);
    console.log("❌ Fallidas:", failedRequests.length);
    if (successfulRequests.length > 0) {
      console.log("🟢 ÚLTIMAS REQUESTS EXITOSAS:", JSON.stringify(successfulRequests.slice(-5), null, 2));
    }
    
    console.log("⏳ Esperando a que carguen las sucursales...");
    
    // Esperar inteligentemente a que aparezcan las sucursales
    try {
      await page.waitForFunction(() => {
        const cards = document.querySelectorAll('[data-testid="branch-card"]');
        return cards.length > 0;
      }, { timeout: 15000 });
      console.log("✅ Sucursales cargadas correctamente");
    } catch (error) {
      console.log("⚠️ Timeout esperando sucursales, analizando requests de red...");
      
      // Debug: Mostrar resumen de requests
      console.log("📊 RESUMEN DE REQUESTS:");
      console.log("✅ Requests exitosas:", successfulRequests.length);
      console.log("❌ Requests fallidas:", failedRequests.length);
      
      if (failedRequests.length > 0) {
        console.log("🚨 REQUESTS FALLIDAS:", JSON.stringify(failedRequests, null, 2));
      }
      
      if (successfulRequests.length > 0) {
        console.log("✅ REQUESTS EXITOSAS:", JSON.stringify(successfulRequests.slice(0, 5), null, 2));
      }
      
      // Intentar usar ubicación actual como alternativa
      console.log("🔄 Intentando usar 'Utilizar ubicación actual' como alternativa...");
      try {
        // Buscar botón por clase primero (más confiable)
        const ubicacionBtnClass = await page.$('.SearchLocation_myLocation__o9yDP');
        if (ubicacionBtnClass) {
          await ubicacionBtnClass.click();
          console.log("✅ Click en 'Utilizar ubicación actual' por clase");
          await new Promise((r) => setTimeout(r, 5000)); // Esperar más tiempo
        } else {
          console.log("⚠️ No se encontró el botón de ubicación actual");
        }
      } catch (error) {
        console.log("⚠️ No se pudo hacer click en ubicación actual:", error.message);
      }
      
      await new Promise((r) => setTimeout(r, 3000)); // Fallback a tiempo fijo
    }
    
    } // Fin del else de escritura de dirección
    
    console.log("🟠 Esperando sucursal origen preseleccionada...");
    
    // DEBUGGING MASIVO: Capturar screenshot y analizar DOM completo
    console.log("📸 Capturando screenshot antes de buscar sucursales...");
    await page.screenshot({ 
      path: '/app/screenshots/antes-buscar-sucursales.png', 
      fullPage: true 
    });
    
    // Debug: ver TODO el contenido de la página
    const pageContent = await page.evaluate(() => {
      return {
        title: document.title,
        url: window.location.href,
        readyState: document.readyState,
        bodyText: document.body ? document.body.innerText.substring(0, 1000) : 'No body',
        htmlLength: document.documentElement.innerHTML.length
      };
    });
    console.log("📄 Contenido de la página:", JSON.stringify(pageContent, null, 2));
    
    // Debug: buscar TODOS los elementos que podrían ser sucursales
    const elementosEncontrados = await page.evaluate(() => {
      const resultados = {
        branchCards: [],
        elementosConBranch: [],
        elementosConSucursal: [],
        todosLosTestIds: [],
        elementosClickeables: []
      };
      
      // Buscar por data-testid="branch-card"
      const branchCards = document.querySelectorAll('[data-testid="branch-card"]');
      branchCards.forEach((card, index) => {
        resultados.branchCards.push({
          index,
          selected: card.getAttribute('data-selected'),
          classes: card.className,
          text: card.innerText.substring(0, 100),
          html: card.outerHTML.substring(0, 200)
        });
      });
      
      // Buscar elementos que contengan "branch" en cualquier atributo
      const todosElementos = document.querySelectorAll('*');
      todosElementos.forEach((el, index) => {
        if (index < 100) { // Limitar para no saturar logs
          // Buscar elementos con "branch" en atributos
          for (let attr of el.attributes || []) {
            if (attr.value && attr.value.toLowerCase().includes('branch')) {
              resultados.elementosConBranch.push({
                tagName: el.tagName,
                attribute: attr.name,
                value: attr.value,
                text: el.innerText ? el.innerText.substring(0, 50) : ''
              });
              break;
            }
          }
          
          // Buscar elementos con "sucursal" en el texto
          if (el.innerText && el.innerText.toLowerCase().includes('sucursal')) {
            resultados.elementosConSucursal.push({
              tagName: el.tagName,
              text: el.innerText.substring(0, 100),
              classes: el.className
            });
          }
          
          // Buscar todos los data-testid
          if (el.getAttribute('data-testid')) {
            resultados.todosLosTestIds.push({
              testId: el.getAttribute('data-testid'),
              tagName: el.tagName,
              text: el.innerText ? el.innerText.substring(0, 50) : ''
            });
          }
          
          // Buscar elementos clickeables
          if (el.onclick || el.addEventListener || ['button', 'a', 'div'].includes(el.tagName.toLowerCase())) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              resultados.elementosClickeables.push({
                tagName: el.tagName,
                classes: el.className,
                text: el.innerText ? el.innerText.substring(0, 50) : '',
                visible: rect.width > 0 && rect.height > 0
              });
            }
          }
        }
      });
      
      return resultados;
    });
    
    console.log("🔍 ANÁLISIS COMPLETO DEL DOM:");
    console.log("📋 Branch cards encontradas:", JSON.stringify(elementosEncontrados.branchCards, null, 2));
    console.log("🏢 Elementos con 'branch':", JSON.stringify(elementosEncontrados.elementosConBranch.slice(0, 10), null, 2));
    console.log("🏪 Elementos con 'sucursal':", JSON.stringify(elementosEncontrados.elementosConSucursal.slice(0, 10), null, 2));
    console.log("🏷️ Todos los data-testid:", JSON.stringify(elementosEncontrados.todosLosTestIds.slice(0, 20), null, 2));
    console.log("👆 Elementos clickeables:", JSON.stringify(elementosEncontrados.elementosClickeables.slice(0, 10), null, 2));
    
    // Intentar múltiples estrategias para encontrar la sucursal preseleccionada
    let sucursalEncontrada = false;
    let intentos = 0;
    const maxIntentos = 3;
    
    while (!sucursalEncontrada && intentos < maxIntentos) {
      try {
        intentos++;
        console.log(`🔍 Intento ${intentos} de ${maxIntentos} para encontrar sucursal preseleccionada...`);
        
        // Buscar sucursal con múltiples estrategias
        await page.waitForFunction(() => {
          // Estrategia 1: Selector original
          const originalSelector = document.querySelector('[data-testid="branch-card"][data-selected="true"]');
          if (originalSelector) return true;
          
          // Estrategia 2: Selector específico proporcionado
          const specificSelector = document.querySelector('#OriginBranchOfficeForm > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiGrid-root.MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-md-4.BranchFinder_form__MSvN8.mui-1eqw7n8 > div.MuiGrid-root.mui-19gvopz > div.MuiGrid-root.MuiGrid-container.Branches_container__WBihE.mui-nmfa4y > div:nth-child(1)');
          if (specificSelector) return true;
          
          // Estrategia 3: Cualquier elemento con Branches_container
          const branchContainer = document.querySelector('.Branches_container__WBihE > div');
          if (branchContainer) return true;
          
          // Estrategia 4: Buscar por contenido de sucursal
          const allDivs = document.querySelectorAll('div');
          for (let div of allDivs) {
            if (div.innerText && (div.innerText.includes('sucursal') || div.innerText.includes('Sucursal'))) {
              const rect = div.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return true;
            }
          }
          
          return false;
        }, { timeout: 20000 });
        
        sucursalEncontrada = true;
        console.log("✅ Sucursal encontrada exitosamente");
        
      } catch (error) {
        console.log(`⚠️ Intento ${intentos} falló:`, error.message);
        
        // Capturar screenshot del fallo
        console.log(`📸 Capturando screenshot del intento ${intentos} fallido...`);
        await page.screenshot({ 
          path: `/app/screenshots/intento-${intentos}-fallido.png`, 
          fullPage: true 
        });
        
        // Verificar si hay sucursales disponibles y seleccionar la primera si es necesario
        console.log(`🔍 Intento ${intentos} falló, analizando DOM nuevamente...`);
        
        const analisisDetallado = await page.evaluate(() => {
          const cards = document.querySelectorAll('[data-testid="branch-card"]');
          const resultado = {
            cantidadCards: cards.length,
            cardsDetalle: [],
            estadoPagina: {
              title: document.title,
              url: window.location.href,
              bodyVisible: document.body ? true : false,
              loadingElements: document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="loader"]').length
            },
            elementosAlternativos: []
          };
          
          // Analizar cada card en detalle
          cards.forEach((card, index) => {
            const rect = card.getBoundingClientRect();
            resultado.cardsDetalle.push({
              index,
              selected: card.getAttribute('data-selected'),
              classes: card.className,
              visible: rect.width > 0 && rect.height > 0,
              position: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height
              },
              text: card.innerText.substring(0, 200),
              innerHTML: card.innerHTML.substring(0, 300)
            });
          });
          
          // Buscar elementos alternativos que podrían ser sucursales
          const posiblesAlternativas = document.querySelectorAll(
            '[class*="branch"], [class*="sucursal"], [id*="branch"], [id*="sucursal"], ' +
            '[data-test*="branch"], [data-test*="sucursal"], button, .card, .item'
          );
          
          Array.from(posiblesAlternativas).slice(0, 10).forEach((el, index) => {
            if (el.innerText && el.innerText.trim().length > 0) {
              const rect = el.getBoundingClientRect();
              resultado.elementosAlternativos.push({
                index,
                tagName: el.tagName,
                classes: el.className,
                id: el.id,
                text: el.innerText.substring(0, 100),
                visible: rect.width > 0 && rect.height > 0
              });
            }
          });
          
          return resultado;
        });
        
        console.log(`🔍 ANÁLISIS DETALLADO INTENTO ${intentos}:`, JSON.stringify(analisisDetallado, null, 2));
        
        // Intentar seleccionar sucursal automáticamente con múltiples métodos
        const sucursalSeleccionada = await page.evaluate(() => {
          console.log('🔍 Iniciando búsqueda de sucursales para selección automática...');
          
          // Método 1: Selector específico proporcionado
          const specificSelector = '#OriginBranchOfficeForm > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiGrid-root.MuiGrid-item.MuiGrid-grid-xs-12.MuiGrid-grid-md-4.BranchFinder_form__MSvN8.mui-1eqw7n8 > div.MuiGrid-root.mui-19gvopz > div.MuiGrid-root.MuiGrid-container.Branches_container__WBihE.mui-nmfa4y > div:nth-child(1)';
          const specificElement = document.querySelector(specificSelector);
          if (specificElement) {
            console.log('📍 Elemento específico encontrado:', {
              text: specificElement.innerText.substring(0, 100),
              classes: specificElement.className
            });
            specificElement.click();
            return { method: 'specific', success: true };
          }
          
          // Método 2: Buscar en contenedor de sucursales
          const branchContainer = document.querySelector('.Branches_container__WBihE');
          if (branchContainer) {
            const firstChild = branchContainer.querySelector('div:first-child');
            if (firstChild) {
              console.log('📍 Primer elemento en contenedor de sucursales encontrado');
              firstChild.click();
              return { method: 'container', success: true };
            }
          }
          
          // Método 3: Selector original
          const cards = document.querySelectorAll('[data-testid="branch-card"]');
          console.log(`🔍 Verificando ${cards.length} tarjetas con data-testid="branch-card"...`);
          
          if (cards.length > 0) {
            const primeraCard = cards[0];
            console.log('📍 Primera tarjeta data-testid encontrada:', {
              selected: primeraCard.getAttribute('data-selected'),
              text: primeraCard.innerText.substring(0, 100),
              classes: primeraCard.className
            });
            
            if (!primeraCard.getAttribute('data-selected') || primeraCard.getAttribute('data-selected') !== 'true') {
              console.log('👆 Haciendo click en primera tarjeta data-testid...');
              primeraCard.click();
              return { method: 'data-testid', success: true };
            } else {
              console.log('✅ Primera tarjeta ya está seleccionada');
              return { method: 'data-testid', success: true };
            }
          }
          
          // Método 4: Buscar cualquier elemento clickeable con texto de sucursal
          const allElements = document.querySelectorAll('div, button, span');
          for (let element of allElements) {
            if (element.innerText && element.innerText.toLowerCase().includes('sucursal')) {
              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                console.log('📍 Elemento con texto "sucursal" encontrado:', element.innerText.substring(0, 50));
                element.click();
                return { method: 'text-search', success: true };
              }
            }
          }
          
          console.log('❌ No se encontraron sucursales con ningún método');
          return { method: 'none', success: false };
        });
        
        console.log("🔍 Resultado de selección automática:", JSON.stringify(sucursalSeleccionada, null, 2));
        
        if (sucursalSeleccionada && sucursalSeleccionada.success) {
          console.log(`✅ Sucursal seleccionada exitosamente con método: ${sucursalSeleccionada.method}`);
          await new Promise(r => setTimeout(r, 2000)); // Esperar que se aplique la selección
          
          // Capturar screenshot después de la selección
          console.log("📸 Capturando screenshot después de selección manual...");
          await page.screenshot({ 
            path: `/app/screenshots/despues-seleccion-manual-intento-${intentos}.png`, 
            fullPage: true 
          });
          
          sucursalEncontrada = true;
        } else if (intentos >= maxIntentos) {
          // Capturar screenshot final del fallo
          console.log("📸 Capturando screenshot FINAL del fallo...");
          await page.screenshot({ 
            path: '/app/screenshots/fallo-final-sucursales.png', 
            fullPage: true 
          });
          
          // Log final del estado de la página
          const estadoFinal = await page.evaluate(() => {
            return {
              url: window.location.href,
              title: document.title,
              todosLosElementos: Array.from(document.querySelectorAll('*'))
                .slice(0, 50)
                .map(el => ({
                  tag: el.tagName,
                  id: el.id,
                  classes: el.className,
                  text: el.innerText ? el.innerText.substring(0, 50) : ''
                }))
                .filter(el => el.text.trim().length > 0)
            };
          });
          
          console.log("🔍 ESTADO FINAL DE LA PÁGINA:", JSON.stringify(estadoFinal, null, 2));
          throw new Error(`No se pudo encontrar o seleccionar una sucursal después de ${maxIntentos} intentos`);
        } else {
          console.log("⏳ Esperando antes del siguiente intento...");
          await new Promise(r => setTimeout(r, 3000)); // Esperar antes del siguiente intento
        }
      }
    }
    console.log("✅ Sucursal origen preseleccionada encontrada");
    await page.waitForSelector("#OriginBranchOffice-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de origen...");
    await page.click("#OriginBranchOffice-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de seleccionar origen...");
    await new Promise((r) => setTimeout(r, 2000));

    // CARGA MANUAL
    console.log("🎯 Buscando opción 'Carga manual'...");
    await page.waitForSelector("#carga_manual--paquetes", { visible: true });
    console.log("✅ Haciendo click en 'Carga manual'...");
    await page.click("#carga_manual--paquetes");

    console.log("⏳ Pausa de 2 segundos después de carga manual...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.waitForSelector("#DataUpload-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de carga de datos...");
    await page.click("#DataUpload-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de siguiente en carga...");
    await new Promise((r) => setTimeout(r, 2000));

    // FORMULARIO PAQUETE
    console.log("📦 Completando formulario de paquete...");
    await page.waitForSelector("#input_alto", { visible: true });
    console.log("✏️ Escribiendo dimensiones y peso...");
    await page.type("#input_alto", "1", { delay: 100 });
    await page.type("#input_ancho", "1", { delay: 100 });
    await page.type("#input_largo", "1", { delay: 100 });
    await page.type("#input_peso", "1", { delay: 100 });
    await page.type("#input_valorDeclarado", "10000", { delay: 100 });

    console.log("⏳ Pausa de 2 segundos después de completar formulario...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.waitForSelector("#PackageDescription-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' del formulario paquete...");
    await page.click("#PackageDescription-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de siguiente en paquete...");
    await new Promise((r) => setTimeout(r, 2000));

    // CÓDIGO POSTAL DESTINO
    console.log("📮 Ingresando CP:", 1636);
    await page.waitForSelector('input[placeholder="Ej: 1824, Lanús Oeste"]', {
      visible: true,
    });
    const input = await page.$('input[placeholder="Ej: 1824, Lanús Oeste"]');
    console.log("✏️ Limpiando campo de CP...");
    await input.click({ clickCount: 3 });
    await input.press("Backspace");
    console.log("✏️ Escribiendo CP:", 1636);
    await input.type(String(1636), { delay: 150 });

    console.log("⏳ Esperando opciones de CP...");

    // Seleccionar primera opción
    await page.waitForFunction(() => {
      const items = document.querySelectorAll("li[role='option']");
      return items.length > 0;
    });
    console.log("✅ Seleccionando primera opción de CP...");
    await page.evaluate(() => {
      const first = document.querySelector("li[role='option']");
      if (first) first.click();
    });

    console.log("⏳ Pausa de 2 segundos después de seleccionar CP...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.waitForSelector("#PostalCode-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de CP...");
    await page.click("#PostalCode-siguiente--paquetes");

    console.log("⏳ Pausa de 2 segundos después de siguiente en CP...");
    await new Promise((r) => setTimeout(r, 2000));

    // OPCIÓN "A SUCURSAL"
    console.log("🏁 Seleccionando 'A sucursal'...");
    await page.waitForSelector('[data-testid="sucursal"]', { visible: true });
    console.log("✅ Encontré opción 'A sucursal', haciendo click...");
    await page.evaluate(() => {
      const sucursalDiv = document.querySelector('[data-testid="sucursal"]');
      if (sucursalDiv) sucursalDiv.click();
    });

    console.log(
      "⏳ Pausa de 2 segundos después de seleccionar 'A sucursal'..."
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await page.waitForSelector("#DeliveryMethod-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de método de entrega...");
    await page.click("#DeliveryMethod-siguiente--paquetes");

    // Esperar a que carguen las sucursales destino
    console.log("⏳ Esperando que carguen las opciones de sucursales...");
    await page.waitForSelector("div.Branches_paper__MWRtc:nth-child(1)", {
      visible: true,
      timeout: 30000,
    });

    console.log(
      "✅ Opciones de sucursales cargadas, seleccionando la primera..."
    );
    await page.click("div.Branches_paper__MWRtc:nth-child(1)");

    console.log("⏳ Pausa de 2 segundos después de seleccionar sucursal...");
    await new Promise((r) => setTimeout(r, 2000));

    // Click en el botón siguiente de destino
    await page.waitForSelector("#DestinationBranchOffice-siguiente--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Siguiente' de sucursal destino...");
    await page.click("#DestinationBranchOffice-siguiente--paquetes");

    // Esperar a que cargue el formulario
    console.log("⏳ Esperando que cargue el formulario de datos personales...");
    await page.waitForSelector("#input_nombre", {
      visible: true,
      timeout: 15000,
    });

    console.log("📝 Completando formulario de datos personales...");

    // Completar campo nombre
    console.log("✏️ Escribiendo nombre...");
    await page.type("#input_nombre", "test", { delay: 100 });

    // Completar campo apellido
    console.log("✏️ Escribiendo apellido...");
    await page.type("#input_apellido", "test", { delay: 100 });

    // Completar campo DNI
    console.log("✏️ Escribiendo DNI...");
    await page.type("#input_dni", "45545545", { delay: 100 });

    // Completar campo teléfono
    console.log("✏️ Escribiendo teléfono...");
    await page.type("#input_telefono", "12131211", { delay: 100 });

    // Completar campo email
    console.log("✏️ Escribiendo email...");
    await page.type("#input_email", "test@gmail.com", { delay: 100 });

    console.log("⏳ Pausa de 2 segundos después de completar el formulario...");
    await new Promise((r) => setTimeout(r, 2000));

    // Click en el botón finalizar
    await page.waitForSelector("#finalizar_envio--paquetes", {
      visible: true,
    });
    console.log("🎯 Haciendo click en 'Finalizar envío'...");
    await page.click("#finalizar_envio--paquetes");

    // Esperar a que se capture el token (máximo 10 segundos)
    console.log("⏳ Esperando a capturar el token de autorización...");
    let attempts = 0;
    while (!authToken && attempts < 50) {
      // 50 intentos = 10 segundos
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    if (authToken) {
      console.log("✅ Token capturado exitosamente!");
      console.log("🔑 Token completo:", authToken);
    } else {
      console.log("⚠️ No se pudo capturar el token en el tiempo esperado");
    }

    // Esperar a que se capture la respuesta del POST (máximo 5 segundos adicionales)
    console.log("⏳ Esperando respuesta del POST con pedidoId y envioId...");
    attempts = 0;
    while (!responseData && attempts < 25) {
      // 25 intentos = 5 segundos
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    if (responseData) {
      console.log("✅ Datos de respuesta capturados:");
      console.log("📦 PedidoId:", responseData.pedidoId);
      console.log("🚚 EnvioId:", responseData.envioId);
    } else {
      console.log(
        "⚠️ No se pudo capturar la respuesta del POST en el tiempo esperado"
      );
    }

    // Esperar a que la página redirija y capturar el ID del pedido desde URL
    console.log("⏳ Esperando redirección para capturar ID desde URL...");
    let urlPedidoId = null;

    // Esperar hasta que la URL contenga "resumen-de-pedido" (máximo 10 segundos)
    attempts = 0;
    while (attempts < 50) {
      // 50 intentos = 10 segundos
      const currentUrl = page.url();

      if (currentUrl.includes("resumen-de-pedido/")) {
        // Extraer el ID de la URL
        const urlParts = currentUrl.split("resumen-de-pedido/");
        if (urlParts.length > 1) {
          urlPedidoId = urlParts[1].split("?")[0].split("#")[0]; // Remover query params y fragments
          console.log("✅ ID del pedido desde URL capturado:", urlPedidoId);
          console.log("📍 URL completa:", currentUrl);
          break;
        }
      }

      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    if (!urlPedidoId) {
      console.log(
        "⚠️ No se pudo capturar el ID del pedido desde URL en el tiempo esperado"
      );
      console.log("📍 URL actual:", page.url());
    }

    console.log("✅ Proceso de envío finalizado exitosamente!");

    return {
      success: true,
      message:
        "Proceso de hacer envío completado exitosamente - Formulario enviado",
      url: page.url(),
      token: authToken,
      tokenCaptured: !!authToken,
      pedidoId: responseData?.pedidoId || null,
      envioId: responseData?.envioId || null,
      urlPedidoId: urlPedidoId,
      responseData: responseData,
      dataCaptured: !!responseData,
    };
  } catch (error) {
    console.error("❌ Error durante el proceso:", error);
    
    if (browser && page) {
      try {
        // 📸 CAPTURA DE ERROR: Tomar múltiples screenshots para debugging
        console.log("📸 Capturando screenshots de error para debugging...");
        
        // Screenshot principal del error
        await page.screenshot({ 
          path: "/app/screenshots/error-hacer-envio.png", 
          fullPage: true 
        });
        
        // Screenshot con timestamp para no sobrescribir
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await page.screenshot({ 
          path: `/app/screenshots/error-${timestamp}.png`, 
          fullPage: true 
        });
        
        // Análisis del DOM en el momento del error
        console.log("🔍 Analizando DOM en el momento del error...");
        const errorAnalysis = await page.evaluate(() => {
          return {
            url: window.location.href,
            title: document.title,
            readyState: document.readyState,
            visibleText: document.body ? document.body.innerText.substring(0, 500) : 'No body',
            inputsCount: document.querySelectorAll('input').length,
            buttonsCount: document.querySelectorAll('button').length,
            formsCount: document.querySelectorAll('form').length,
            hasSignInName: !!document.querySelector('#signInName'),
            hasHacerEnvio: !!document.querySelector('#hacer_envio')
          };
        });
        
        console.log("🔍 ANÁLISIS DE ERROR:", JSON.stringify(errorAnalysis, null, 2));
        
        // Guardar análisis en archivo de texto
        const fs = require('fs');
        const errorLog = `
TIMESTAMP: ${new Date().toISOString()}
ERROR: ${error.message}
STACK: ${error.stack}
DOM ANALYSIS: ${JSON.stringify(errorAnalysis, null, 2)}
        `;
        
        fs.writeFileSync(`/app/screenshots/error-log-${timestamp}.txt`, errorLog);
        console.log(`📝 Log de error guardado en: error-log-${timestamp}.txt`);
        
      } catch (screenshotError) {
        console.log("⚠️ Error tomando screenshots de debugging:", screenshotError.message);
      }
    }
    
    throw error;
  } finally {
    if (browser) {
      console.log("🔴 Cerrando navegador...");
      await browser.close();
    }
  }
}

/* ======================
   Endpoints HTTP
   ====================== */

// Health check endpoint para Docker
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "andreani-token-service"
  });
});

app.post("/get-andreani-token", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Ya no requerimos que vengan en el body, pueden venir del .env
    console.log("🔵 Iniciando proceso /get-andreani-token...");
    const result = await getAndreaniToken(email, password);

    res.json({
      success: true,
      result: result,
      message: "Proceso completado exitosamente",
    });
  } catch (error) {
    console.error("❌ Error en el endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Error al procesar la solicitud de Andreani",
    });
  }
});

app.post("/hacer-envio", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("🔵 Iniciando proceso /hacer-envio...");
    const result = await hacerEnvio(email, password);

    res.json({
      success: true,
      result: result,
      message: "Click en botón 'Hacer envío' realizado exitosamente",
    });
  } catch (error) {
    console.error("❌ Error en el endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Error al hacer click en el botón de envío",
    });
  }
});

app.post("/get-sucursal-id", async (req, res) => {
  try {
    const { email, password, cp } = req.body;

    if (!cp) {
      return res.status(400).json({
        success: false,
        error: "CP es requerido",
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
  console.log(`🔧 Modo de producción: ${isProduction}`);
  console.log(`🌐 Chromium path: ${process.env.CHROMIUM_PATH || 'No configurado'}`);
});
