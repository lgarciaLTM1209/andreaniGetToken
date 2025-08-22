# Multi-stage build para optimizar tamaño de imagen final
FROM node:21.2.0-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# Imagen final para runtime
FROM node:21.2.0-slim AS runner

# Instalar Chromium y dependencias necesarias
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libgbm1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Configurar variables de entorno para Puppeteer con Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROMIUM_PATH=/usr/bin/chromium \
    CHROME_BIN=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Copiar dependencias y código desde el stage builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Crear directorio para screenshots
RUN mkdir -p /app/screenshots

# Crear usuario no-root para ejecutar la aplicación
RUN groupadd -r nodejs --gid=1001 && \
    useradd -r -g nodejs --uid=1001 --home-dir=/app --shell=/bin/bash andreani

# Cambiar permisos del directorio de trabajo
RUN chown -R andreani:nodejs /app
USER andreani

# Exponer el puerto
EXPOSE 8080

# Comando por defecto
CMD ["node", "dist/app.js"] 