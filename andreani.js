// index.js
// Detectar si estamos en contenedor para usar puppeteer-core
const isContainer =
  process.env.NODE_ENV === "production" ||
  process.env.DOCKER_ENV === "true" ||
  process.env.COOLIFY_APP_ID;

const puppeteer = isContainer
  ? require("puppeteer-core")
  : require("puppeteer");
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
    // Detectar si estamos en un entorno de contenedor
    const isContainer =
      process.env.NODE_ENV === "production" ||
      process.env.DOCKER_ENV === "true" ||
      process.env.COOLIFY_APP_ID;

    const browserArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
      "--disable-extensions",
      "--disable-plugins",
      "--no-first-run",
      "--no-default-browser-check",
      "--single-process",
    ];

    if (isContainer) {
      browserArgs.push(
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--memory-pressure-off",
        "--disable-images"
      );
    }

    const launchConfig = {
      headless: isContainer ? "new" : false, // headless en contenedores, visible localmente
      defaultViewport: { width: 1280, height: 720 },
      args: browserArgs,
      timeout: 60000,
      protocolTimeout: 60000,
    };

    // En contenedores, usar el ejecutable de Chrome instalado
    if (isContainer) {
      launchConfig.executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
    }

    browser = await puppeteer.launch(launchConfig);

    page = await browser.newPage();

    console.log("🔵 Navegando al login...");
    await page.goto("https://onboarding.andreani.com/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    console.log("🔵 Completando login...");
    await page.waitForSelector("#signInName", {
      visible: true,
      timeout: 60000, // Timeout extendido para contenedores
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
      timeout: 60000, // Timeout extendido para contenedores
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
    // Detectar si estamos en un entorno de contenedor
    const isContainer =
      process.env.NODE_ENV === "production" ||
      process.env.DOCKER_ENV === "true" ||
      process.env.COOLIFY_APP_ID;

    const browserArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
      "--disable-extensions",
      "--disable-plugins",
      "--no-first-run",
      "--no-default-browser-check",
      "--single-process",
    ];

    if (isContainer) {
      browserArgs.push(
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--memory-pressure-off",
        "--disable-images"
      );
    }

    const launchConfig = {
      headless: isContainer ? "new" : false, // headless en contenedores, visible localmente
      defaultViewport: { width: 1280, height: 720 },
      args: browserArgs,
      timeout: 60000,
      protocolTimeout: 60000,
    };

    // En contenedores, usar el ejecutable de Chrome instalado
    if (isContainer) {
      launchConfig.executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
    }

    browser = await puppeteer.launch(launchConfig);

    page = await browser.newPage();

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
      timeout: 60000, // Timeout extendido para contenedores
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
      await page.screenshot({ path: "error-no-ubicaciones.png" });
      throw new Error("❌ No se capturó la URL de destino (ubicacionesPath)");
    }

    return {
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
    // Detectar si estamos en un entorno de contenedor
    const isContainer =
      process.env.NODE_ENV === "production" ||
      process.env.DOCKER_ENV === "true" ||
      process.env.COOLIFY_APP_ID;

    const browserArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
      "--disable-extensions",
      "--disable-plugins",
      "--no-first-run",
      "--no-default-browser-check",
      "--single-process",
    ];

    if (isContainer) {
      browserArgs.push(
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--memory-pressure-off",
        "--disable-images"
      );
    }

    const launchConfig = {
      headless: "new", // siempre headless para esta función
      defaultViewport: { width: 1280, height: 720 },
      args: browserArgs,
      timeout: 60000,
      protocolTimeout: 60000,
    };

    // En contenedores, usar el ejecutable de Chrome instalado
    if (isContainer) {
      launchConfig.executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
    }

    browser = await puppeteer.launch(launchConfig);

    page = await browser.newPage();

    // Interceptar requests para capturar el token de autorización
    await page.setRequestInterception(true);
    let responseData = null;

    page.on("request", (request) => {
      const url = request.url();

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

    console.log("🔵 Navegando al login...");
    await page.goto("https://onboarding.andreani.com/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    console.log("🔵 Completando login...");
    await page.waitForSelector("#signInName", {
      visible: true,
      timeout: 60000, // Timeout extendido para contenedores
    });
    await page.type("#signInName", finalEmail, { delay: 60 });
    await page.type("#password", finalPassword, { delay: 60 });
    await page.click("#next");

    console.log("🟠 Esperando navegación post-login...");
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
      .catch(() => {});

    console.log("📍 URL actual después del login:", page.url());

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

    // Hacer click en el botón "Hacer envío" con estrategias múltiples
    console.log("🎯 Buscando botón 'Hacer envío'...");

    // Estrategia 1: Esperar a que el botón sea visible y esté habilitado con timeout extendido
    try {
      await page.waitForSelector("#hacer_envio", {
        visible: true,
        timeout: 90000, // Timeout extendido significativamente para contenedores
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
      await page.click("#hacer_envio");
    } catch (error) {
      console.log("❌ Error esperando el botón #hacer_envio:", error.message);

      // Estrategia 2: Debugging - tomar screenshot y analizar DOM
      console.log("🔍 Analizando la página actual para debugging...");
      await page.screenshot({ path: "debug-screenshot.png", fullPage: true });

      const currentUrl = page.url();
      console.log("📍 URL actual:", currentUrl);

      // Verificar si hay elementos similares
      const similarButtons = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('button, [role="button"], a, div[onclick]')
        );
        return buttons
          .filter(
            (btn) =>
              btn.textContent && btn.textContent.toLowerCase().includes("envío")
          )
          .map((btn) => ({
            tagName: btn.tagName,
            id: btn.id,
            className: btn.className,
            textContent: btn.textContent.trim(),
            visible: btn.offsetParent !== null,
          }));
      });

      console.log(
        "🔍 Botones relacionados con 'envío' encontrados:",
        JSON.stringify(similarButtons, null, 2)
      );

      // Intentar encontrar el botón por texto si el ID no funciona
      const foundByText = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("*"));
        const target = elements.find(
          (el) =>
            el.textContent &&
            el.textContent.toLowerCase().includes("hacer envío") &&
            el.offsetParent !== null
        );
        return target
          ? {
              tagName: target.tagName,
              id: target.id,
              className: target.className,
              textContent: target.textContent.trim(),
            }
          : null;
      });

      if (foundByText) {
        console.log("✅ Encontré botón por texto:", foundByText);
        try {
          await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll("*"));
            const target = elements.find(
              (el) =>
                el.textContent &&
                el.textContent.toLowerCase().includes("hacer envío") &&
                el.offsetParent !== null
            );
            if (target) target.click();
          });
          console.log("✅ Click realizado usando estrategia de texto");
        } catch (clickError) {
          console.log("❌ Error en click por texto:", clickError.message);
          throw error; // Re-lanzar el error original
        }
      } else {
        throw error; // Re-lanzar el error original
      }
    }

    console.log("⏳ Esperando que la página se actualice después del click...");
    // Esperar a que la página navegue o se actualice completamente
    await new Promise((r) => setTimeout(r, 3000));

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
    await new Promise((r) => setTimeout(r, 3000));

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
      timeout: 15000,
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
      await page.screenshot({ path: "error-hacer-envio.png" });
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

// Health check endpoint para Docker
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
});
