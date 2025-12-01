# Usar la imagen oficial de Playwright (ya incluye navegadores)
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de Node.js (sin descargar navegadores, ya vienen en la imagen)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

# Copiar el código fuente
COPY andreaniPlaywright.js ./

# Crear directorio para screenshots
RUN mkdir -p /app/screenshots

# Variables de entorno
ENV NODE_ENV=production

# Exponer el puerto
EXPOSE 8080

# Comando por defecto
CMD ["node", "andreaniPlaywright.js"]
