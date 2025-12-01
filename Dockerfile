# Usar imagen base de Node.js slim
FROM node:21.2.0-slim

# Instalar dependencias del sistema necesarias para Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libgdk-pixbuf2.0-0 \
    libx11-xcb1 \
    libxcb1 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de Node.js
RUN npm ci --omit=dev

# Instalar navegadores de Playwright (solo Chromium)
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

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
