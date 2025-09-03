// index.js
const puppeteer = require("puppeteer");
require("dotenv").config();
const express = require("express");

const app = express();
const port = process.env.PORT || 8080;
const isProduction = process.env.NODE_ENV === "production";
app.use(express.json());

// Función para decodificar JWT
function decodeJWT(token) {
  try {
    // Remover "Bearer " si está presente
    const jwtToken = token.replace(/^Bearer\s+/, '');
    
    // Dividir el token en sus partes
    const parts = jwtToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Token JWT inválido');
    }

    // Decodificar el payload (segunda parte)
    const payload = parts[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    
    return decoded;
  } catch (error) {
    console.error('Error decodificando JWT:', error);
    return null;
  }
}




/* ================================================
   hacerEnvio: login y captura de token bearer
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
  let capturedTokens = [];
  let seenTokens = new Set(); // Para evitar duplicados

  try {
    console.log("🔍 Iniciando Puppeteer...");

    const puppeteerOptions = {
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    };

    // En producción o Docker, usar puppeteer-core con executablePath
    if (process.env.CHROMIUM_PATH || isProduction) {
      puppeteerOptions.executablePath = process.env.CHROMIUM_PATH;
    }

    browser = await puppeteer.launch(puppeteerOptions);

    page = await browser.newPage();

    // Configurar viewport de la página (como en el original)
    await page.setViewport({
      width: 1920,
      height: 1080,
    });

    // Interceptar requests para capturar tokens Bearer
    await page.setRequestInterception(true);

    page.on("request", (request) => {
      const headers = request.headers();
      
      // Verificar si la request tiene Authorization header con Bearer token
      if (headers.authorization && headers.authorization.startsWith("Bearer ")) {
        const token = headers.authorization;
        const decodedToken = decodeJWT(token);
        
        // Verificar si el token es del issuer correcto Y no lo hemos visto antes
        if (decodedToken && decodedToken.iss === "PymeBackend-WebApi" && !seenTokens.has(token)) {
          console.log("🔑 Token Bearer válido encontrado:", token.substring(0, 30) + "...");
          seenTokens.add(token); // Marcar como visto
          capturedTokens.push({
            token: token,
            decoded: decodedToken,
            url: request.url(),
            timestamp: new Date().toISOString()
          });
        }
      }
      
      request.continue();
    });

    // Navegar al login (EXACTAMENTE como funcionaba antes)
    console.log("🔵 Navegando al login...");
    await page.goto("https://onboarding.andreani.com/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Realizar login (EXACTAMENTE como funcionaba antes)
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
    
    // Esperar un poco más para que se generen requests con tokens
    console.log("⏳ Esperando requests con tokens Bearer...");
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log(`🎯 Total de tokens capturados: ${capturedTokens.length}`);
    
    return {
      tokensCapturados: capturedTokens,
      totalTokens: capturedTokens.length,
      loginExitoso: true
    };

  } catch (error) {
    console.error("❌ Error en hacerEnvio:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 Browser cerrado");
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
    service: "andreani-token-service",
  });
});



app.post("/hacer-envio", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("🔵 Iniciando proceso /hacer-envio...");
    const result = await hacerEnvio(email, password);

    res.json({
      success: true,
      tokensCapturados: result.tokensCapturados,
      totalTokens: result.totalTokens,
      loginExitoso: result.loginExitoso,
      message: "Login realizado exitosamente y tokens capturados",
    });
  } catch (error) {
    console.error("❌ Error en el endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Error durante el proceso de login y captura de tokens",
    });
  }
});


app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
  console.log(`🔧 Modo de producción: ${isProduction}`);
  console.log(
    `🌐 Chromium path: ${process.env.CHROMIUM_PATH || "No configurado"}`
  );
});