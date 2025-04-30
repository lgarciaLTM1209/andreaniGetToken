const puppeteer = require("puppeteer");
require("dotenv").config();
const express = require("express");

const app = express();
const port = 3000;
app.use(express.json());

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
    await page.setViewport({ width: 1600, height: 1080 });

    // Interceptar requests para capturar el Bearer
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = request.url();
      const headers = request.headers();

      if (
        url.includes("/api/v1/Sucursal/GetUbicacionesSucursales") &&
        headers.authorization &&
        headers.authorization.startsWith("Bearer")
      ) {
        bearerToken = headers.authorization;
        console.log("✅ Token Bearer capturado:", bearerToken);
      }

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
    await page.type("#signInName", email, { delay: 100 });
    await page.type("#password", password, { delay: 100 });
    await page.click("#next");

    console.log("🟠 Esperando redirección...");
    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 10000,
      });
    } catch (error) {
      console.warn(
        "⚠️ No redireccionó después del login. Reintentando login..."
      );

      // Intentamos completar el login de nuevo
      await page.waitForSelector("#signInName", {
        visible: true,
        timeout: 5000,
      });
      await page.click("#signInName", { clickCount: 3 }); // Selecciona y borra
      await page.type("#signInName", email, { delay: 100 });

      await page.click("#password", { clickCount: 3 });
      await page.type("#password", password, { delay: 100 });

      await page.click("#next");

      // Esperamos redirección otra vez
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 15000,
      });
    }

    // ➕ Acción post login: click en "Hacer envío"
    await page.waitForSelector("#hacer_envio", { visible: true });
    await page.click("#hacer_envio");

    // ➕ Espera a que aparezca la card "Paquetes – Hasta 50 kg"
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

    // ➕ Click en la card correspondiente
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

    // 🔁 Espera adicional para capturar el token
    await new Promise((resolve) => setTimeout(resolve, 5000));

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

async function getSucursalId(email, password, cp) {
  let browser;
  let page;
  let bearerToken = null;
  let ubicacionesPath = null;

  try {
    browser = await puppeteer.launch({
      headless: "shell",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      const headers = request.headers();

      if (
        url.includes("/api/v1/Sucursal/GetUbicacionesSucursales") &&
        headers.authorization?.startsWith("Bearer")
      ) {
        bearerToken = headers.authorization;
        console.log("✅ Bearer Token capturado:", bearerToken);
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
    await page.type("#signInName", email);
    await page.type("#password", password);
    await page.click("#next");
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: 15000,
    });

    // Hacer envío → Paquetes
    await page.waitForSelector("#hacer_envio", { visible: true });
    await page.click("#hacer_envio");

    await page.waitForFunction(() => {
      return [...document.querySelectorAll("div.MuiCard-root")].some(
        (card) =>
          card.innerText.includes("Paquetes") &&
          card.innerText.includes("Hasta 50 kg")
      );
    });
    await page.evaluate(() => {
      const card = [...document.querySelectorAll("div.MuiCard-root")].find(
        (card) =>
          card.innerText.includes("Paquetes") &&
          card.innerText.includes("Hasta 50 kg")
      );
      if (card) card.click();
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
    console.log("📮 Ingresando CP:", cp);
    await page.waitForSelector('input[placeholder="Ej: 1824, Lanús Oeste"]', {
      visible: true,
    });
    const input = await page.$('input[placeholder="Ej: 1824, Lanús Oeste"]');
    await input.click({ clickCount: 3 });
    await input.press("Backspace");
    await input.type(cp, { delay: 80 });

    // Esperar opciones y seleccionar la primera
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

    await new Promise((resolve) => setTimeout(resolve, 2000));

    await page.waitForSelector("#DeliveryMethod-siguiente--paquetes", {
      visible: true,
    });
    await page.click("#DeliveryMethod-siguiente--paquetes");

    // Esperar la request de sucursales destino
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (!ubicacionesPath) {
      throw new Error("❌ No se capturó la URL de destino");
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

app.post("/get-andreani-token", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email y contraseña son requeridos",
      });
    }

    console.log("🔵 Iniciando proceso...");
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
        error: "Email y contraseña son requeridos",
      });
    }

    console.log("🔵 Iniciando proceso...");
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
