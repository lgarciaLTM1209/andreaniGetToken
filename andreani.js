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

app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
});
