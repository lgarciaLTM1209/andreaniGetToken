// test-browser.js - Script para probar el navegador visible
require("dotenv").config();
const puppeteer = require("puppeteer");

async function testBrowser() {
  let browser;

  try {
    console.log("🚀 Abriendo navegador en modo visible...");

    // Configuración igual que en andreani.js pero forzando modo visible
    browser = await puppeteer.launch({
      headless: false, // Forzar visible
      slowMo: 500, // Más lento para ver mejor
      devtools: true, // Abrir DevTools
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

    const page = await browser.newPage();

    console.log("📱 Navegando a la página de login...");
    await page.goto("https://onboarding.andreani.com/", {
      waitUntil: "domcontentloaded",
    });

    console.log("✅ Navegador abierto! Puedes ver la página de Andreani.");
    console.log("⏳ El navegador se mantendrá abierto por 30 segundos...");

    // Mantener abierto por 30 segundos para que puedas ver
    await new Promise((resolve) => setTimeout(resolve, 30000));
  } catch (error) {
    console.log("❌ Error:", error.message);
  } finally {
    if (browser) {
      console.log("🔴 Cerrando navegador...");
      await browser.close();
    }
  }
}

testBrowser();
