# Usar la versión exacta de Node.js del entorno local
FROM node:22.15.0-alpine

# Instalar dependencias necesarias para Puppeteer en Alpine
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Configurar variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias con npm v10.9.2 (viene con Node 22.15.0)
RUN npm ci --only=production

# Copiar el código fuente
COPY andreani.js ./

# Crear directorio para screenshots
RUN mkdir -p /app/screenshots

# Crear usuario no-root para ejecutar la aplicación
RUN addgroup -g 1001 -S nodejs && \
    adduser -S andreani -u 1001

# Cambiar permisos del directorio de trabajo
RUN chown -R andreani:nodejs /app
USER andreani

# Exponer el puerto
EXPOSE 3000

# Comando por defecto
CMD ["node", "andreani.js"] 